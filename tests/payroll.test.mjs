import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createSource,listCalendar,getSource,changeExpectation,linkIncomeReceipt} from '../src/backend/income/income.ts';
import {createRevision,listRevisions,createStatement,getStatement,listStatements,SalaryConflict,SalaryNotApplicable} from '../src/backend/payroll/payroll.ts';
import {createAccount} from '../src/backend/accounts/accounts.ts';
import {postMovement} from '../src/backend/movements/movements.ts';
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
  for(const name of ['0001_financial_accounts.sql','0002_better_auth.sql','0003_cash_movements.sql','0004_financial_obligations.sql','0005_internal_transfers.sql','0006_cancellations_refunds.sql','0007_credit_cards_installments.sql','0008_card_invoice_payments.sql','0009_invoice_bank_reconciliation.sql','0010_work_services.sql','0011_income_expectations.sql','0012_salary_composition.sql','0013_salary_withholding_obligations.sql','0014_purchase_intentions.sql','0015_personal_loan_receivables.sql','0016_debt_renegotiation.sql']){
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
const source=(tag='salary')=>({idempotencyKey:key('source-'+tag),name:'Salário CLT',relationship:'employment',payKind:'fixed',periodicity:'monthly',anchorOn:'2026-01-31',fixedNetCents:250000});
const revision=(tag='raise',effectiveOn='2026-11-01',netCents=275000)=>({idempotencyKey:key(tag),effectiveOn,netCents,reason:'Aumento salarial aprovado'});
const statement=(tag='nov',netCents=300000)=>({idempotencyKey:key(tag),netCents,grossCents:null,discounts:[],components:[
 {kind:'overtime',reason:'Horas extras de novembro',amountCents:25000},
]});
const calendar=(db)=>listCalendar(db,actor('alice'),'2026-11-01','2026-12-31');
async function bank(db){return createAccount(db,actor('alice'),{idempotencyKey:key('account'),name:'Conta',kind:'general',funding:{mode:'external',cents:0}},clock);}
async function cash(db,account){return postMovement(db,actor('alice'),{idempotencyKey:key('real-salary'),accountId:account.accountId,direction:'income',amountCents:300000,
 method:'pix',description:'Salário efetivo',occurredOn:'2026-11-30'},clock);}
test('E3 R$2500 → R$2750 from November preserves October and future salary, no bank cash',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),source(),clock);
 let before=await listCalendar(db,actor('alice'),'2026-10-01','2026-12-31');
 assert.deepEqual(before.expectations.map(e=>e.expectedCents),[250000,250000,250000]);
 const v=await createRevision(db,actor('alice'),s.sourceId,revision(),clock);
 assert.deepEqual([v.effectiveOn,v.netCents],['2026-11-01',275000]);
 const cal=await listCalendar(db,actor('alice'),'2026-10-01','2026-12-31');
 assert.deepEqual(cal.expectations.map(e=>e.expectedCents),[250000,275000,275000]);
 assert.equal((await getSource(db,actor('alice'),s.sourceId)).fixedNetCents,250000,'initial version immutable');
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.incomeCents,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
}));
test('E3 previously materialized E2 expectation gets revised expected salary in calendar, historical E2 row remains unchanged',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),source(),clock),occ='scheduled_2026-11-30';
 await changeExpectation(db,actor('alice'),s.sourceId,occ,{idempotencyKey:key('confirm'),state:'confirmed'},clock);
 assert.equal(db.raw.prepare('SELECT expected_cents FROM income_expectations').get().expected_cents,250000);
 await createRevision(db,actor('alice'),s.sourceId,revision(),clock);
 const e=(await calendar(db)).expectations.find(x=>x.occurrenceKey===occ);
 assert.deepEqual([e.state,e.expectedCents],['confirmed',275000]);
 assert.equal(db.raw.prepare('SELECT expected_cents FROM income_expectations').get().expected_cents,250000);
}));
test('E3 +R$250 overtime November is per-competence, not December recurring salary',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),source(),clock);
 await createRevision(db,actor('alice'),s.sourceId,revision(),clock);
 const w=await createStatement(db,actor('alice'),s.sourceId,'scheduled_2026-11-30',statement(),clock);
 assert.deepEqual([w.netCents,w.baseNetCents,w.componentsTotalCents,w.componentsDifferenceCents,w.grossStatus],[300000,275000,25000,0,'not_provided']);
 const cal=await calendar(db);
 assert.deepEqual(cal.expectations.map(x=>x.expectedCents),[300000,275000]);
 assert.equal(cal.totals.expectedCents,575000);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.incomeCents,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
}));
test('E3 net alone allowed and gross omitted has no phantom discounts; incomplete discount is pending',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),source(),clock),occ='scheduled_2026-11-30';
 let w=await createStatement(db,actor('alice'),s.sourceId,occ,{
  idempotencyKey:key('alone'),netCents:250000,grossCents:null,discounts:[],components:[],
 },clock);
 assert.equal(w.grossStatus,'not_provided');assert.equal(w.grossDifferenceCents,null);
 assert.deepEqual(w.discounts,[]);
 w=await createStatement(db,actor('alice'),s.sourceId,occ,{
  idempotencyKey:key('incomplete'),netCents:250000,grossCents:340000,
  discounts:[{label:'INSS',amountCents:40000}],components:[],
 },clock);
 assert.deepEqual([w.grossStatus,w.grossDifferenceCents,w.discountsTotalCents],['pending',50000,40000]);
 assert.equal((await listStatements(db,actor('alice'),s.sourceId,occ)).length,2);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.expensesCents,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
}));
test('E3 itemized INSS/IRRF/consignado matched arithmetically, never posts withheld amount as new debit',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),source(),clock),occ='scheduled_2026-11-30';
 const st=await createStatement(db,actor('alice'),s.sourceId,occ,{
  idempotencyKey:key('detailed'),netCents:250000,grossCents:320000,
  discounts:[{label:'INSS',amountCents:30000},{label:'IRRF',amountCents:10000},{label:'Consignado',amountCents:30000}],
  components:[{kind:'bonus',reason:'Bônus por projeto',amountCents:15000},{kind:'reduction',reason:'Desconto pontual',amountCents:-15000}],
 },clock);
 assert.deepEqual([st.grossStatus,st.grossDifferenceCents,st.discountsTotalCents,st.componentsTotalCents,st.componentsDifferenceCents],['matched',0,70000,0,0]);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligation_payments').get().n,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.expensesCents,0);
}));
test('E3 multiple statements append without overwriting old history; latest drives the forecast',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),source(),clock),occ='scheduled_2026-11-30';
 const first={idempotencyKey:key('first'),netCents:260000,grossCents:null,discounts:[],components:[]};
 const a=await createStatement(db,actor('alice'),s.sourceId,occ,first,clock);
 await createStatement(db,actor('alice'),s.sourceId,occ,{...first,idempotencyKey:key('second'),netCents:270000},clock);
 const replay=await createStatement(db,actor('alice'),s.sourceId,occ,first,clock);
 assert.equal(replay.statementId,a.statementId);
 assert.equal((await getStatement(db,actor('alice'),s.sourceId,occ)).netCents,270000);
 assert.deepEqual((await listStatements(db,actor('alice'),s.sourceId,occ)).map(x=>x.netCents),[270000,260000]);
 assert.equal((await calendar(db)).expectations[0].expectedCents,270000);
 await assert.rejects(()=>createStatement(db,actor('alice'),s.sourceId,occ,{...first,netCents:270001},clock),SalaryConflict);
}));
test('E3 concurrent idempotency and effective-date conflicts do not create duplicate revisions',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),source(),clock);
 const same=revision();
 const arr=await Promise.all(Array.from({length:3},()=>createRevision(db,actor('alice'),s.sourceId,same,clock)));
 assert.equal(new Set(arr.map(x=>x.effectiveOn)).size,1);
 assert.equal((await listRevisions(db,actor('alice'),s.sourceId)).length,1);
 await assert.rejects(()=>createRevision(db,actor('alice'),s.sourceId,revision('other',same.effectiveOn,280000),clock),SalaryConflict);
 await assert.rejects(()=>createRevision(db,actor('alice'),s.sourceId,revision('retro','2026-10-01',260000),clock),SalaryConflict);
 const later=await createRevision(db,actor('alice'),s.sourceId,revision('later','2026-12-01',290000),clock);
 assert.equal(later.netCents,290000);
 assert.deepEqual((await calendar(db)).expectations.map(x=>x.expectedCents),[275000,290000]);
}));
test('E3 invalid deductions, signs, negative/unsafe amounts and cross-tenant access are rejected',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),source(),clock),occ='scheduled_2026-11-30';
 await assert.rejects(()=>getStatement(db,actor('bob'),s.sourceId,occ));
 await assert.rejects(()=>createRevision(db,actor('bob'),s.sourceId,revision(),clock));
 await assert.rejects(()=>createStatement(db,actor('bob'),s.sourceId,occ,statement(),clock));
 const bad={idempotencyKey:key('bad'),netCents:250000,grossCents:null,
 discounts:[{label:'INSS',amountCents:100}],components:[]};
 await assert.rejects(()=>createStatement(db,actor('alice'),s.sourceId,occ,bad,clock),TypeError);
 await assert.rejects(()=>createStatement(db,actor('alice'),s.sourceId,occ,{...bad,discounts:[],
  components:[{kind:'overtime',reason:'invalid',amountCents:-10}]},clock),TypeError);
 await assert.rejects(()=>createStatement(db,actor('alice'),s.sourceId,occ,{...bad,discounts:[],
  components:[{kind:'reduction',reason:'invalid',amountCents:10}]},clock),TypeError);
 await assert.rejects(()=>createRevision(db,actor('alice'),s.sourceId,{...revision(),netCents:0},clock),RangeError);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM salary_period_statements').get().n,0);
}));
test('E3 fault between virtual expectation materialization and statement rolls entire D1 batch back',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),source(),clock),occ='scheduled_2026-11-30';
 db.raw.exec("CREATE TRIGGER e3_fault BEFORE INSERT ON salary_period_statements BEGIN SELECT RAISE(ABORT,'E3_FAULT'); END");
 await assert.rejects(()=>createStatement(db,actor('alice'),s.sourceId,occ,statement(),clock),/E3_FAULT/);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM income_expectations').get().n,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM salary_period_statements').get().n,0);
 db.raw.exec('DROP TRIGGER e3_fault');
 const retry=await createStatement(db,actor('alice'),s.sourceId,occ,statement(),clock);
 assert.equal(retry.netCents,300000);
}));
test('E3 statement and revisions do not change actual cash/timeline/XLSX/PDF or double pay salaries',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),source(),clock),a=await bank(db),m=await cash(db,a);
 const filter={...period,asOf:'2026-11-30',status:'all'};
 const cashBefore=await getDashboard(db,actor('alice'),period);
 const eventsBefore=await readExportTimeline(db,actor('alice'),filter);
 await linkIncomeReceipt(db,actor('alice'),s.sourceId,'scheduled_2026-11-30',{idempotencyKey:key('associate'),movementId:m.movementId},clock);
 await createRevision(db,actor('alice'),s.sourceId,revision(),clock);
 await createStatement(db,actor('alice'),s.sourceId,'scheduled_2026-11-30',statement(),clock);
 assert.deepEqual(await getDashboard(db,actor('alice'),period),cashBefore);
 assert.deepEqual(await readExportTimeline(db,actor('alice'),filter),eventsBefore);
 for(const format of ['pdf','xlsx'])assert.equal((await makeReport(db,actor('alice'),{...filter,format})).rows,1);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,1);
 assert.equal((await calendar(db)).expectations[0].receivedCents,300000);
}));
test('E3 immutable SQL history defeats UPDATE, DELETE and INSERT OR REPLACE with recursive triggers disabled',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),source(),clock);
 await createRevision(db,actor('alice'),s.sourceId,revision(),clock);
 await createStatement(db,actor('alice'),s.sourceId,'scheduled_2026-11-30',statement(),clock);
 db.raw.exec('PRAGMA recursive_triggers=OFF');
 assert.throws(()=>db.raw.exec('UPDATE salary_base_revisions SET net_cents=1'),/SALARY_IMMUTABLE/);
 assert.throws(()=>db.raw.exec('DELETE FROM salary_period_statements'),/SALARY_IMMUTABLE/);
 const sql='INSERT OR REPLACE INTO salary_base_revisions(owner_user_id,source_id,creation_key,effective_on,net_cents,reason,created_at) VALUES(?,?,?,?,?,?,?)';
 assert.throws(()=>db.raw.prepare(sql).run('alice',s.sourceId,key('rewrite'),'2026-11-01',280000,'Permanente',clock().toISOString()),/SALARY_REVISION_INVALID/);
 const sql2='INSERT OR REPLACE INTO salary_period_statements(owner_user_id,source_id,occurrence_key,creation_key,net_cents,base_net_at_entry_cents,discounts_json,components_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)';
 assert.throws(()=>db.raw.prepare(sql2).run('alice',s.sourceId,'scheduled_2026-11-30',key('nov'),250000,250000,'[]','[]',clock().toISOString()),/SALARY_STATEMENT_INVALID/);
}));
const BASE='http://127.0.0.1:8787',now=Date.parse('2026-11-11T13:00:00Z');
const session=async headers=>{const c=headers.get('cookie'),user=c==='u=alice'?'alice':c==='u=bob'?'bob':null;
 return user?{user:{id:user},session:{userId:user,expiresAt:new Date(now+120000)}}:null;};
async function http(db,path,user='alice',method='GET',body=null,origin=BASE){
 return handleFinancialHttp(new Request(BASE+path,{method,
  headers:{cookie:user?'u='+user:'',origin,'x-user-id':'bob',...(body?{'content-type':'application/json'}:{})},
  ...(body?{body:JSON.stringify(body)}:{})}),db,session,BASE,()=>now);
}
test('E3 HTTP: Better Auth, Origin, allowlist, exact decimal, gross empty, pending reconciliation, 404',()=>using(async db=>{
 const s=await createSource(db,actor('alice'),source(),clock),root='/api/income-sources/'+s.sourceId;
 const revisionPath=root+'/salary-revisions',statementPath=root+'/expectations/scheduled_2026-11-30/salary';
 assert.equal((await http(db,revisionPath,'')).status,401);
 assert.equal((await http(db,revisionPath,'bob')).status,404);
 assert.equal((await http(db,statementPath,'bob')).status,404);
 assert.equal((await http(db,revisionPath,'alice','POST',{idempotencyKey:key('http'),effectiveOn:'2026-11-01',net:'2750.00',reason:'Aumento'},'https://evil.example')).status,403);
 assert.equal((await http(db,revisionPath,'alice','POST',{idempotencyKey:key('http'),effectiveOn:'2026-11-01',net:'2750.00',reason:'Aumento',ownerId:'bob'})).status,400);
 const raise=await http(db,revisionPath,'alice','POST',{idempotencyKey:key('http'),effectiveOn:'2026-11-01',net:'2750.00',reason:'Aumento'});
 assert.equal(raise.status,201);
 assert.equal((await http(db,revisionPath,'alice','POST',{idempotencyKey:key('http'),effectiveOn:'2026-11-01',net:'2750.00',reason:'Aumento'})).status,201);
 assert.equal((await http(db,statementPath+'?limit=1&limit=2')).status,400);
 assert.equal((await http(db,statementPath,'alice','POST',{idempotencyKey:key('http-statement'),net:'3000.00',gross:null,discounts:[],components:[
  {kind:'overtime',reason:'Horas extras',amount:'250.00'}
 ]})).status,201);
 const p=await http(db,statementPath);
 assert.equal(p.status,200);
 const v=(await p.json()).statement;
 assert.equal(v.netCents,300000);assert.equal(v.grossStatus,'not_provided');
 assert.equal((await http(db,statementPath,'bob','POST',{idempotencyKey:key('steal'),net:'1.00',gross:null,discounts:[],components:[]})).status,404);
 assert.equal((await http(db,statementPath,'alice','POST',{idempotencyKey:key('bad'),net:'NaN',discounts:[],components:[]})).status,400);
}));


test('E3 historical salary statement retains its original base snapshot after later effective-dated salary raise',()=>using(async db=>{
 const src=await createSource(db,actor('alice'),source(),clock),occ='scheduled_2026-11-30';
 const recorded=await createStatement(db,actor('alice'),src.sourceId,occ,{
  idempotencyKey:key('salary-before-raise'),netCents:275000,grossCents:null,discounts:[],
  components:[{kind:'overtime',reason:'Extra pontual',amountCents:25000}],
 },clock);
 assert.equal(recorded.baseNetCents,250000);
 assert.equal(recorded.componentsDifferenceCents,0);
 await createRevision(db,actor('alice'),src.sourceId,revision(),clock);
 const now=await getStatement(db,actor('alice'),src.sourceId,occ);
 assert.deepEqual([now.baseNetCents,now.componentsDifferenceCents],[250000,0],
  'subsequent salary raise cannot retroactively re-interpret a statement');
 const replay=await createStatement(db,actor('alice'),src.sourceId,occ,{
  idempotencyKey:key('salary-before-raise'),netCents:275000,grossCents:null,discounts:[],
  components:[{kind:'overtime',reason:'Extra pontual',amountCents:25000}],
 },clock);
 assert.deepEqual(replay,now);
 const cal=await calendar(db);
 assert.deepEqual(cal.expectations.map(e=>e.expectedCents),[275000,275000]);
 assert.equal(db.raw.prepare('SELECT base_net_at_entry_cents FROM salary_period_statements').get().base_net_at_entry_cents,250000);
}));

test('E3 SQL refuses fabricated base-at-entry snapshots even if occurrence is valid',()=>using(async db=>{
 const src=await createSource(db,actor('alice'),source(),clock);
 await changeExpectation(db,actor('alice'),src.sourceId,'scheduled_2026-11-30',{
  idempotencyKey:key('confirm-forgery'),state:'confirmed',
 },clock);
 const sql='INSERT INTO salary_period_statements(owner_user_id,source_id,occurrence_key,creation_key,net_cents,base_net_at_entry_cents,discounts_json,components_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)';
 assert.throws(()=>db.raw.prepare(sql).run('alice',src.sourceId,'scheduled_2026-11-30',key('fake-base'),275000,1,'[]','[]',clock().toISOString()),/SALARY_STATEMENT_INVALID/);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM salary_period_statements').get().n,0);
}));
