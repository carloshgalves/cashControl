import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createSource,linkIncomeReceipt,listCalendar,changeExpectation} from '../src/backend/income/income.ts';
import {createStatement,getStatement} from '../src/backend/payroll/payroll.ts';
import {confirmSalaryWithholding,listSalaryWithholdings,listObligationWithholdings,WithholdingConflict,WithholdingNotFound,WithholdingNotApplicable} from '../src/backend/payroll/withholdings.ts';
import {createAccount} from '../src/backend/accounts/accounts.ts';
import {postMovement} from '../src/backend/movements/movements.ts';
import {createObligation,getObligation,payObligation,listObligationPayments} from '../src/backend/obligations/obligations.ts';
import {cancelUnpaidObligation,refundPaidExpense} from '../src/backend/compensations/compensations.ts';
import {getDashboard} from '../src/backend/dashboard/dashboard.ts';
import {readExportTimeline} from '../src/backend/timeline/timeline.ts';
import {makeReport} from '../src/backend/reports/report.ts';
import {handleFinancialHttp} from '../src/backend/http/accounts-handler.ts';
class Stmt {
 constructor(db,sql,params=[]){this.db=db;this.sql=sql;this.params=params;}
 bind(...params){return new Stmt(this.db,this.sql,params);}
 async first(){return this.db.prepare(this.sql).get(...this.params)??null;}
 async all(){return {results:this.db.prepare(this.sql).all(...this.params)};}
 async run(){return this.db.prepare(this.sql).run(...this.params);}
}
class Db{
 constructor(){
  this.raw=new DatabaseSync(':memory:');this.raw.exec('PRAGMA foreign_keys=ON');
  for(const name of ['0001_financial_accounts.sql','0002_better_auth.sql','0003_cash_movements.sql',
    '0004_financial_obligations.sql','0005_internal_transfers.sql','0006_cancellations_refunds.sql','0015_personal_loan_receivables.sql',
    '0007_credit_cards_installments.sql','0008_card_invoice_payments.sql',
    '0009_invoice_bank_reconciliation.sql','0010_work_services.sql','0011_income_expectations.sql','0012_salary_composition.sql','0013_salary_withholding_obligations.sql']){
   this.raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  }
  this.queue=Promise.resolve();
 }
 prepare(sql){return new Stmt(this.raw,sql);}
 batch(stmts){
  const op=this.queue.then(async()=>{
   this.raw.exec('BEGIN IMMEDIATE');
   try{const result=[];for(const s of stmts)result.push(await s.run());this.raw.exec('COMMIT');return result;}
   catch(e){this.raw.exec('ROLLBACK');throw e;}
  });
  this.queue=op.catch(()=>{});return op;
 }
 close(){this.raw.close();}
}
async function using(fn){const db=new Db();try{await fn(db);}finally{db.close();}}
const actor=id=>({userId:id}),clock=()=>new Date('2026-11-11T13:00:00.000Z');
const key=x=>'reconciliation-key-'+x;




const period={from:'2026-11-01',to:'2026-11-30'};
const actorA=actor('alice');
const occ='scheduled_2026-11-30';
async function fixture(db,user='alice'){
 const u=actor(user);
 const source=await createSource(db,u,{idempotencyKey:key('source-'+user),name:'Salário '+user,
  relationship:'employment',payKind:'fixed',periodicity:'monthly',anchorOn:'2026-11-30',fixedNetCents:250000},clock);
 const debt=await createObligation(db,u,{idempotencyKey:key('debt-'+user),title:'Consignado',totalCents:30000,dueOn:'2026-11-30'},clock);
 return {source,debt,u};
}
async function paycheck(db,{source,u},tag='salary'){
 return createStatement(db,u,source.sourceId,occ,{
  idempotencyKey:key('statement-'+tag),netCents:250000,grossCents:300000,
  discounts:[{label:'INSS',amountCents:20000},{label:'Consignado',amountCents:30000}],
  components:[],
 },clock);
}
async function bank(db,u=actorA){
 return createAccount(db,u,{idempotencyKey:key('bank-'+u.userId),name:'Conta',kind:'general',
  funding:{mode:'external',cents:0}},clock);
}
async function income(db,u,account,amount=250000){
 return postMovement(db,u,{idempotencyKey:key('income-'+u.userId),accountId:account.accountId,
  direction:'income',amountCents:amount,method:'pix',description:'Salário líquido recebido',
  occurredOn:'2026-11-30'},clock);
}
function pay(statement,debt,amount=30000,tag='withheld'){
 return {idempotencyKey:key(tag),statementId:statement.statementId,discountIndex:1,
  obligationId:debt.obligationId,amountCents:amount,confirmedOn:'2026-11-30',confirmRetained:true};
}
test('E4 R$3000 gross − INSS R$200 − consignado R$300 = R$2500 net; withheld debt paid once, no new expense',()=>using(async db=>{
 const f=await fixture(db),s=await paycheck(db,f),a=await bank(db),m=await income(db,actorA,a);
 await linkIncomeReceipt(db,actorA,f.source.sourceId,occ,{idempotencyKey:key('link-net'),movementId:m.movementId},clock);
 const before=await getDashboard(db,actorA,period);
 assert.deepEqual([before.cashFlow.incomeCents,before.cashFlow.expensesCents,before.balances.totalCents,before.obligations.outstandingCents],[250000,0,250000,30000]);
 assert.equal((await getObligation(db,actorA,f.debt.obligationId)).state,'open');
 const result=await confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,pay(s,f.debt),clock);
 assert.deepEqual([result.amountCents,result.discountLabel,result.origin],[30000,'Consignado','salary_withholding_confirmed']);
 const debt=await getObligation(db,actorA,f.debt.obligationId);
 assert.deepEqual([debt.paidCents,debt.outstandingCents,debt.state],[30000,0,'paid']);
 const after=await getDashboard(db,actorA,period);
 assert.deepEqual([after.cashFlow.incomeCents,after.cashFlow.expensesCents,after.balances.totalCents,after.obligations.outstandingCents],[250000,0,250000,0]);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,1);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligation_payments').get().n,0);
 assert.equal((await listObligationWithholdings(db,actorA,f.debt.obligationId)).length,1);
 assert.equal((await listSalaryWithholdings(db,actorA,f.source.sourceId,occ)).length,1);
 const timeline=await readExportTimeline(db,actorA,{...period,asOf:'2026-11-30',status:'all'});
 assert.equal(timeline.filter(e=>e.status==='realized').length,1);
 for(const format of ['pdf','xlsx'])assert.equal((await makeReport(db,actorA,{...period,asOf:'2026-11-30',status:'all',format})).rows,1);
}));
test('E4 neither salary statement nor linked bank income silently pays the debt without separate confirmation',()=>using(async db=>{
 const f=await fixture(db),s=await paycheck(db,f),a=await bank(db),m=await income(db,actorA,a);
 await linkIncomeReceipt(db,actorA,f.source.sourceId,occ,{idempotencyKey:key('link-only'),movementId:m.movementId},clock);
 assert.equal((await getObligation(db,actorA,f.debt.obligationId)).outstandingCents,30000);
 assert.equal((await listSalaryWithholdings(db,actorA,f.source.sourceId,occ)).length,0);
 await assert.rejects(()=>confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,{...pay(s,f.debt),confirmRetained:false},clock),WithholdingNotApplicable);
 assert.equal((await getObligation(db,actorA,f.debt.obligationId)).state,'open');
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM salary_withheld_obligation_payments').get().n,0);
}));
test('E4 gross omitted, zero discounts or gross mismatch cannot be used to settle a debt',()=>using(async db=>{
 const f=await fixture(db);
 const missing=await createStatement(db,actorA,f.source.sourceId,occ,{
  idempotencyKey:key('missing-gross'),netCents:250000,grossCents:null,discounts:[],components:[],
 },clock);
 await assert.rejects(()=>confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,pay(missing,f.debt),clock),WithholdingNotApplicable);
 const broken=await createStatement(db,actorA,f.source.sourceId,occ,{
  idempotencyKey:key('unmatched'),netCents:250000,grossCents:300000,
  discounts:[{label:'Consignado',amountCents:30000}],components:[],
 },clock);
 await assert.rejects(()=>confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,{
  ...pay(broken,f.debt),discountIndex:0},clock),WithholdingNotApplicable);
 assert.equal((await getObligation(db,actorA,f.debt.obligationId)).state,'open');
}));
test('E4 partial payroll withholding can split R$300 across confirmations but never exceed discount or obligation',()=>using(async db=>{
 const f=await fixture(db),s=await paycheck(db,f);
 const first=pay(s,f.debt,9000,'first-part'),second=pay(s,f.debt,21000,'second-part');
 await confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,first,clock);
 assert.deepEqual([(await getObligation(db,actorA,f.debt.obligationId)).outstandingCents,(await getDashboard(db,actorA,period)).cashFlow.expensesCents],[21000,0]);
 await confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,second,clock);
 assert.equal((await getObligation(db,actorA,f.debt.obligationId)).state,'paid');
 await assert.rejects(()=>confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,pay(s,f.debt,1,'overpay'),clock),WithholdingConflict);
 assert.equal(db.raw.prepare('SELECT SUM(amount_cents) total FROM salary_withheld_obligation_payments').get().total,30000);
}));
test('E4 idempotency and concurrent attempts atomically protect same discount and debt',()=>using(async db=>{
 const f=await fixture(db),s=await paycheck(db,f);
 const same=pay(s,f.debt),copies=await Promise.all(Array.from({length:4},()=>confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,same,clock)));
 assert.equal(new Set(copies.map(v=>v.paymentId)).size,1);
 assert.equal((await listObligationWithholdings(db,actorA,f.debt.obligationId)).length,1);
 await assert.rejects(()=>confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,{...same,amountCents:100},clock),WithholdingConflict);
 const another=await createObligation(db,actorA,{idempotencyKey:key('another'),title:'Other debt',totalCents:30000,dueOn:'2026-11-30'},clock);
 await assert.rejects(()=>confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,pay(s,another,30000,'replay-cross'),clock),WithholdingConflict);
 assert.equal((await getObligation(db,actorA,another.obligationId)).outstandingCents,30000);
}));
test('E4 cash payment and withholding share a single outstanding balance under concurrency',()=>using(async db=>{
 const f=await fixture(db),s=await paycheck(db,f),a=await bank(db);
 await income(db,actorA,a);
 const attempts=await Promise.allSettled([
  confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,pay(s,f.debt,30000,'withhold-race'),clock),
  payObligation(db,actorA,{idempotencyKey:key('cash-race'),obligationId:f.debt.obligationId,accountId:a.accountId,
   amountCents:30000,method:'pix',paidOn:'2026-11-30'},clock),
 ]);
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1,'both contenders must be eligible but only one can commit');
 const o=await getObligation(db,actorA,f.debt.obligationId);
 assert.deepEqual([o.paidCents,o.outstandingCents,o.state],[30000,0,'paid']);
 const cash=db.raw.prepare('SELECT COUNT(*) n FROM financial_obligation_payments').get().n;
 const folha=db.raw.prepare('SELECT COUNT(*) n FROM salary_withheld_obligation_payments').get().n;
 assert.equal(cash+folha,1,'exactly one winner, never duplicate debt settlement');
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,1+cash,'no orphan debit on failed cash race, independent salary already received');
}));
test('E4 cancellation is rejected after withholding even if no bank payment exists',()=>using(async db=>{
 const f=await fixture(db),s=await paycheck(db,f);
 await confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,pay(s,f.debt,10000),clock);
 await assert.rejects(()=>cancelUnpaidObligation(db,actorA,{
  idempotencyKey:key('cancel-after-payroll'),obligationId:f.debt.obligationId,canceledOn:'2026-11-30',reason:'Cancel'
 },clock));
 assert.equal((await getObligation(db,actorA,f.debt.obligationId)).state,'partially_paid');
}));
test('E4 after withholding the evidence statement cannot change by a new version',()=>using(async db=>{
 const f=await fixture(db),s=await paycheck(db,f);
 await confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,pay(s,f.debt),clock);
 await assert.rejects(()=>createStatement(db,actorA,f.source.sourceId,occ,{
  idempotencyKey:key('attempt-edit'),netCents:260000,grossCents:300000,
  discounts:[{label:'Consignado',amountCents:30000},{label:'INSS',amountCents:10000}],components:[],
 },clock));
 assert.equal((await getStatement(db,actorA,f.source.sourceId,occ)).statementId,s.statementId);
}));
test('E4 SQL direct forgery/cross owner/duplicate slots/immutable history is rejected',()=>using(async db=>{
 const f=await fixture(db),s=await paycheck(db,f),bob=await fixture(db,'bob');
 await assert.rejects(()=>confirmSalaryWithholding(db,actor('bob'),f.source.sourceId,occ,pay(s,f.debt),clock));
 await assert.rejects(()=>listSalaryWithholdings(db,actor('bob'),f.source.sourceId,occ));
 await assert.rejects(()=>listObligationWithholdings(db,actor('bob'),f.debt.obligationId),WithholdingNotFound);
 const direct='INSERT INTO salary_withheld_obligation_payments(owner_user_id,payment_id,creation_key,statement_seq,discount_index,obligation_id,amount_cents,confirmed_on,created_at) VALUES(?,?,?,?,?,?,?,?,?)';
 const args=(owner,index,obligation,amount,tag)=>[owner,crypto.randomUUID(),key(tag),s.statementId,index,obligation,amount,'2026-11-30',clock().toISOString()];
 assert.throws(()=>db.raw.prepare(direct).run(...args('bob',1,bob.debt.obligationId,100,'cross-database')),/WITHHOLDING_INVALID/);
 assert.throws(()=>db.raw.prepare(direct).run(...args('alice',20,f.debt.obligationId,100,'bad-index')));
 assert.throws(()=>db.raw.prepare(direct).run(...args('alice',1,bob.debt.obligationId,100,'foreign-debt')));
 assert.throws(()=>db.raw.prepare(direct).run(...args('alice',1,f.debt.obligationId,31000,'too-big')),/WITHHOLDING_INVALID/);
 const p=await confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,pay(s,f.debt),clock);
 db.raw.exec('PRAGMA recursive_triggers=OFF');
 assert.throws(()=>db.raw.exec('UPDATE salary_withheld_obligation_payments SET amount_cents=1'),/WITHHOLDING_IMMUTABLE/);
 assert.throws(()=>db.raw.exec('DELETE FROM salary_withheld_obligation_payments'),/WITHHOLDING_IMMUTABLE/);
 assert.throws(()=>db.raw.prepare(direct.replace('INSERT INTO','INSERT OR REPLACE INTO')).run(
  'alice',p.paymentId,key('replaced'),s.statementId,1,f.debt.obligationId,30000,'2026-11-30',clock().toISOString()),/WITHHOLDING_INVALID/);
 assert.equal((await getObligation(db,actorA,f.debt.obligationId)).paidCents,30000);
}));
test('E4 third-party discount confirmation cannot steal another user debt or enumerate salary history',()=>using(async db=>{
 const a=await fixture(db),b=await fixture(db,'bob'),s=await paycheck(db,a);
 await assert.rejects(()=>confirmSalaryWithholding(db,actorA,a.source.sourceId,occ,pay(s,b.debt),clock),WithholdingNotFound);
 assert.equal((await getObligation(db,actor('bob'),b.debt.obligationId)).outstandingCents,30000);
 assert.equal((await listObligationWithholdings(db,actor('bob'),b.debt.obligationId)).length,0);
}));
const BASE='http://127.0.0.1:8787',now=Date.parse('2026-11-11T13:00:00Z');
const session=async headers=>{const v=headers.get('cookie'),who=v==='u=alice'?'alice':v==='u=bob'?'bob':null;
 return who?{user:{id:who},session:{userId:who,expiresAt:new Date(now+120000)}}:null;};
async function http(db,path,user='alice',method='GET',body=null,origin=BASE){
 return handleFinancialHttp(new Request(BASE+path,{method,headers:{cookie:user?'u='+user:'',origin,'x-user-id':'bob',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),db,session,BASE,()=>now);
}
test('E4 HTTP rejects unauthenticated, CSRF, owner spoof, absent confirmation, amount errors, replay and foreign GET',()=>using(async db=>{
 const f=await fixture(db),s=await paycheck(db,f);
 const endpoint='/api/income-sources/'+f.source.sourceId+'/expectations/'+occ+'/salary/withholdings';
 const obligationEndpoint='/api/obligations/'+f.debt.obligationId+'/withholdings';
 const payload={idempotencyKey:key('e4-http'),statementId:s.statementId,discountIndex:1,
  obligationId:f.debt.obligationId,amount:'300.00',confirmedOn:'2026-11-30',confirmRetained:true};
 assert.equal((await http(db,endpoint,'')).status,401);
 assert.equal((await http(db,endpoint,'alice','POST',payload,'https://evil.invalid')).status,403);
 assert.equal((await http(db,endpoint,'alice','POST',{...payload,ownerUserId:'bob'})).status,400);
 assert.equal((await http(db,endpoint,'alice','POST',{...payload,confirmRetained:false})).status,400);
 assert.equal((await http(db,endpoint,'alice','POST',{...payload,amount:'x'})).status,400);
 assert.equal((await http(db,endpoint+'?limit=1&limit=2')).status,400);
 assert.equal((await http(db,endpoint,'bob')).status,404);
 assert.equal((await http(db,obligationEndpoint,'bob')).status,404);
 assert.equal((await http(db,endpoint,'alice','POST',payload)).status,201);
 assert.equal((await http(db,endpoint,'alice','POST',payload)).status,201);
 assert.equal((await http(db,endpoint,'alice','POST',{...payload,amount:'50.00'})).status,409);
 assert.equal((await (await http(db,endpoint)).json()).withholdings.length,1);
 assert.equal((await (await http(db,obligationEndpoint)).json()).withholdings.length,1);
 assert.equal((await (await http(db,'/api/obligations')).json()).obligations[0].state,'paid');
}));


test('E4 raw SQL cannot settle an obligation from an unreconciled payslip even when the discount looks valid',()=>using(async db=>{
 const f=await fixture(db);
 const bad=await createStatement(db,actorA,f.source.sourceId,occ,{
  idempotencyKey:key('unmatched-sql'),netCents:250000,grossCents:310000,
  discounts:[{label:'INSS',amountCents:20000},{label:'Consignado',amountCents:30000}],components:[],
 },clock);
 const sql="INSERT INTO salary_withheld_obligation_payments(owner_user_id,payment_id,creation_key,statement_seq,discount_index,obligation_id,amount_cents,confirmed_on,created_at) VALUES(?,?,?,?,?,?,?,?,?)";
 assert.throws(()=>db.raw.prepare(sql).run('alice',crypto.randomUUID(),key('forged-evidence'),bad.statementId,1,f.debt.obligationId,30000,'2026-11-30',clock().toISOString()),/WITHHOLDING_INVALID/);
 assert.equal((await getObligation(db,actorA,f.debt.obligationId)).outstandingCents,30000);
}));


test('E4 INSERT OR REPLACE cannot rewrite even a partially used discount slot with recursive triggers OFF',()=>using(async db=>{
 const f=await fixture(db),s=await paycheck(db,f);
 const paid=await confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,pay(s,f.debt,9000,'partial-record'),clock);
 db.raw.exec('PRAGMA recursive_triggers=OFF');
 const replace='INSERT OR REPLACE INTO salary_withheld_obligation_payments(owner_user_id,payment_id,creation_key,statement_seq,discount_index,obligation_id,amount_cents,confirmed_on,created_at) VALUES(?,?,?,?,?,?,?,?,?)';
 assert.throws(()=>db.raw.prepare(replace).run('alice',paid.paymentId,key('rewrite-partial'),s.statementId,1,f.debt.obligationId,8000,'2026-11-30',clock().toISOString()),/WITHHOLDING_INVALID/);
 assert.equal((await getObligation(db,actorA,f.debt.obligationId)).paidCents,9000);
 assert.equal((await listSalaryWithholdings(db,actorA,f.source.sourceId,occ)).length,1);
}));


test('E4 partial cash plus confirmed withholding closes only the shared outstanding; refund reopens only the cash portion',()=>using(async db=>{
 const f=await fixture(db),salary=await paycheck(db,f),a=await bank(db);
 await income(db,actorA,a);
 const cashPayment=await payObligation(db,actorA,{
  idempotencyKey:key('cash-before-payroll'),obligationId:f.debt.obligationId,accountId:a.accountId,
  amountCents:10000,method:'pix',paidOn:'2026-11-30',
 },clock);
 assert.deepEqual([(await getObligation(db,actorA,f.debt.obligationId)).paidCents,
  (await getDashboard(db,actorA,period)).balances.totalCents],[10000,240000]);
 await confirmSalaryWithholding(db,actorA,f.source.sourceId,occ,
  pay(salary,f.debt,20000,'remaining-by-payroll'),clock);
 assert.deepEqual([(await getObligation(db,actorA,f.debt.obligationId)).state,
  (await getDashboard(db,actorA,period)).cashFlow.expensesCents],['paid',10000]);
 await refundPaidExpense(db,actorA,{
  idempotencyKey:key('refund-cash-part'),originalMovementId:cashPayment.movementId,
  accountId:a.accountId,amountCents:5000,method:'pix',refundedOn:'2026-11-30',
 },clock);
 const reopened=await getObligation(db,actorA,f.debt.obligationId);
 assert.deepEqual([reopened.state,reopened.paidCents,reopened.outstandingCents],['partially_paid',25000,5000]);
 assert.equal((await listObligationWithholdings(db,actorA,f.debt.obligationId)).length,1);
 assert.equal((await listObligationPayments(db,actorA,f.debt.obligationId)).length,1);
 assert.equal((await getDashboard(db,actorA,period)).balances.totalCents,245000);
}));
