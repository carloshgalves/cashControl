import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {simulatePlanning,SimulationConflict,SimulationTooLarge} from '../src/backend/planning/scenarios.ts';
import {createIntention,transitionIntention,getPlanningSummary,IntentionUnavailable} from '../src/backend/planning/intentions.ts';
import {createSource,createManualExpectation,changeExpectation,linkIncomeReceipt} from '../src/backend/income/income.ts';
import {createAccount} from '../src/backend/accounts/accounts.ts';
import {createObligation,getObligation,payObligation} from '../src/backend/obligations/obligations.ts';
import {createCard,createPurchase} from '../src/backend/cards/cards.ts';
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
  for(const name of ['0001_financial_accounts.sql','0002_better_auth.sql','0003_cash_movements.sql',
    '0004_financial_obligations.sql','0005_internal_transfers.sql','0006_cancellations_refunds.sql',
    '0007_credit_cards_installments.sql','0008_card_invoice_payments.sql',
    '0009_invoice_bank_reconciliation.sql','0010_work_services.sql','0011_income_expectations.sql','0012_salary_composition.sql','0013_salary_withholding_obligations.sql','0014_purchase_intentions.sql']){
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






const A=actor('alice'),B=actor('bob'),from='2026-11-11',to='2026-12-31';
const input=(hypothetical=null)=>({from,to,...(hypothetical?{hypothetical}:{})});
const purchase=(amountCents=50000,props={})=>({
 amountCents,purchaseOn:'2026-11-20',dueOn:'2026-12-15',...props,
});
async function wallet(db,owner=A,opening=120000){
 return createAccount(db,owner,{idempotencyKey:key('wallet-'+owner.userId),name:'Carteira',
  kind:'general',funding:{mode:'external',cents:opening}},clock);
}
async function debt(db,owner=A,amount=30000,dueOn='2026-11-25',tag='bill'){
 return createObligation(db,owner,{idempotencyKey:key(tag+'-'+owner.userId),title:'Conta da casa',
  totalCents:amount,dueOn},clock);
}
async function intention(db,owner=A,tag='notebook'){
 return createIntention(db,owner,{idempotencyKey:key('intent-'+tag),title:'Notebook',description:null,
  amountCents:50000,plannedOn:'2026-11-20'},clock);
}
async function freelancer(db,owner=A){
 return createSource(db,owner,{idempotencyKey:key('freelancer-'+owner.userId),name:'Freelance',
  relationship:'freelance',payKind:'variable',periodicity:'none'},clock);
}
async function expect(db,source,amountCents=50000,expectedOn='2026-11-28',owner=A,tag='manual'){
 return createManualExpectation(db,owner,source.sourceId,{
  idempotencyKey:key('expect-'+tag+'-'+owner.userId),expectedOn,amountCents,
 },clock);
}
const at=(r,date)=>r.points.find(p=>p.date===date);
test('F2 empty account/no employer: conservative and planned zero with no inferred salary or writes',()=>using(async db=>{
 const before=await getDashboard(db,A,{from,to});
 const r=await simulatePlanning(db,A,input());
 assert.deepEqual([r.openingRealCashCents,r.existingOutstandingObligationsCents,r.activeVirtualReserveCents,
  r.unreceivedExplicitIncomeCents,r.conservative.endingCashCents,r.planned.endingCashCents],[0,0,0,0,0,0]);
 assert.deepEqual(r.points.map(p=>p.date),[from,to]);
 assert.equal(r.kind,'ephemeral_read_only');
 assert.equal(r.asOfBasis,'current_snapshot_not_historical_balance');
 assert.deepEqual(await getDashboard(db,A,{from,to}),before);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
}));
test('F2 existing bills due by date, including overdue, lower projected cash but not current bank balance',()=>using(async db=>{
 await wallet(db);await debt(db,A,30000,'2026-11-25','nov');
 await debt(db,A,20000,'2026-11-01','overdue');
 const initial=await getPlanningSummary(db,A);
 assert.deepEqual([initial.cashBalanceCents,initial.obligationsCents,initial.freeMarginCents],[120000,50000,70000]);
 const r=await simulatePlanning(db,A,input());
 assert.deepEqual([at(r,from).outstandingPaymentsCents,at(r,from).conservativeCashAfterAssumedPaymentsCents],[20000,100000]);
 assert.deepEqual([at(r,'2026-11-25').outstandingPaymentsCents,at(r,'2026-11-25').conservativeCashAfterAssumedPaymentsCents],[30000,70000]);
 assert.deepEqual([r.conservative.endingFreeMarginCents,r.conservative.lowestCashCents],[70000,70000]);
 assert.equal((await getPlanningSummary(db,A)).cashBalanceCents,120000);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
}));
test('F2 planned shows explicitly expected money, while conservative NEVER counts even confirmed expected salary as cash',()=>using(async db=>{
 await wallet(db,A,0);const s=await freelancer(db);
 const occ=await expect(db,s,120000,'2026-11-28');
 await changeExpectation(db,A,s.sourceId,occ,{idempotencyKey:key('confirm'),state:'confirmed'},clock);
 const r=await simulatePlanning(db,A,input());
 assert.deepEqual([r.conservative.endingCashCents,r.planned.endingCashCents,r.unreceivedExplicitIncomeCents],[0,120000,120000]);
 assert.equal(at(r,'2026-11-28').explicitExpectedIncomeCents,120000);
 assert.equal(r.unreceivedSources[0].state,'confirmed');
 assert.equal(r.unreceivedSources[0].remainingCents,120000);
 assert.equal((await getDashboard(db,A,{from,to})).cashFlow.incomeCents,0);
}));
test('F2 partial ACTUAL receipt already in current cash, planned adds only the linked unreceived remainder',()=>using(async db=>{
 const a=await wallet(db,A,0),s=await freelancer(db),occ=await expect(db,s,100000,'2026-11-28');
 const m=await postMovement(db,A,{idempotencyKey:key('actual-partial'),
  accountId:a.accountId,direction:'income',amountCents:30000,method:'pix',
  description:'Parte efetivamente recebida',occurredOn:'2026-11-11'},clock);
 await linkIncomeReceipt(db,A,s.sourceId,occ,{idempotencyKey:key('link-cash'),movementId:m.movementId},clock);
 const before=await getDashboard(db,A,{from,to});
 const r=await simulatePlanning(db,A,input());
 assert.deepEqual([r.openingRealCashCents,r.conservative.endingCashCents,r.planned.endingCashCents,
   r.unreceivedExplicitIncomeCents],[30000,30000,100000,70000]);
 assert.deepEqual(await getDashboard(db,A,{from,to}),before);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,1);
}));
test('F2 canceling an expectation removes its remaining forecast, preserving real partial receipts and past',()=>using(async db=>{
 const a=await wallet(db,A,0),s=await freelancer(db),occ=await expect(db,s,100000,'2026-11-28');
 const m=await postMovement(db,A,{idempotencyKey:key('received-portion'),
  accountId:a.accountId,direction:'income',amountCents:25000,method:'pix',
  description:'Pagamento parcial',occurredOn:'2026-11-11'},clock);
 await linkIncomeReceipt(db,A,s.sourceId,occ,{idempotencyKey:key('link-portion'),movementId:m.movementId},clock);
 const before=await simulatePlanning(db,A,input());
 assert.equal(before.planned.endingCashCents,100000);
 await changeExpectation(db,A,s.sourceId,occ,{idempotencyKey:key('cancel-work'),state:'canceled',reason:'Serviço cancelado'},clock);
 const after=await simulatePlanning(db,A,input());
 assert.deepEqual([after.openingRealCashCents,after.unreceivedExplicitIncomeCents,after.planned.endingCashCents],[25000,0,25000]);
 assert.equal(after.unreceivedSources.length,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,1);
}));
test('F2 delaying an expectation moves only its unreceived amount to the actual revised date',()=>using(async db=>{
 await wallet(db,A,0);const s=await freelancer(db),occ=await expect(db,s,12000,'2026-11-28');
 await changeExpectation(db,A,s.sourceId,occ,{idempotencyKey:key('postpone'),state:'delayed',
  newOn:'2026-12-12',reason:'Cliente pediu novo prazo'},clock);
 const r=await simulatePlanning(db,A,input());
 assert.equal(at(r,'2026-11-28'),undefined);
 assert.equal(at(r,'2026-12-12').explicitExpectedIncomeCents,12000);
 assert.deepEqual([r.unreceivedSources[0].state,r.unreceivedSources[0].date],['delayed','2026-12-12']);
 assert.equal(r.conservative.endingCashCents,0);
}));
test('F2 fixed recurrent income remains a user-declared expectation; no need formal job for variable ones',()=>using(async db=>{
 await wallet(db,A,0);
 await createSource(db,A,{idempotencyKey:key('salary-fixed'),name:'Salário mensal',
  relationship:'employment',payKind:'fixed',periodicity:'monthly',anchorOn:'2026-10-30',fixedNetCents:250000},clock);
 const r=await simulatePlanning(db,A,input());
 assert.deepEqual(r.unreceivedSources.map(x=>x.date),['2026-11-30','2026-12-30']);
 assert.equal(r.unreceivedExplicitIncomeCents,500000);
 assert.equal(r.conservative.endingCashCents,0);
 assert.equal(r.planned.endingCashCents,500000);
}));
test('F2 simulation of unregistered purchase never creates a real debt and risk alerts are computed',()=>using(async db=>{
 await wallet(db,A,20000);await debt(db,A,15000,'2026-11-18');
 const before=await getDashboard(db,A,{from,to});
 const r=await simulatePlanning(db,A,input(purchase(30000)));
 assert.equal(r.hypothetical.replacedExistingReserveCents,0);
 assert.equal(at(r,'2026-11-20').hypotheticalCommitmentCents,30000);
 assert.equal(at(r,'2026-12-15').hypotheticalPaymentCents,30000);
 assert.equal(at(r,'2026-11-20').conservativeFreeMarginCents,-25000);
 assert.equal(r.conservative.endingCashCents,-25000);
 assert.equal(r.conservative.lowestCashCents,-25000);
 assert.equal(r.conservative.lowestMarginCents,-25000);
 assert.equal(at(r,'2026-12-15').conservativeCashNegative,true);
 assert.deepEqual(await getDashboard(db,A,{from,to}),before);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,1);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
}));
test('F2 simulation of reserved F1 intention replaces its precise reserve on purchase date, not double counts',()=>using(async db=>{
 await wallet(db);const i=await intention(db);
 await transitionIntention(db,A,i.intentionId,{idempotencyKey:key('reserve'),action:'reserve',reservedCents:50000},clock);
 const before=await getPlanningSummary(db,A);
 assert.equal(before.freeMarginCents,70000);
 const r=await simulatePlanning(db,A,input(purchase(50000,{intentionId:i.intentionId})));
 assert.equal(r.activeVirtualReserveCents,50000);
 assert.equal(r.hypothetical.replacedExistingReserveCents,50000);
 assert.equal(at(r,from).conservativeFreeMarginCents,70000);
 assert.equal(at(r,'2026-11-20').releasedReservationCents,50000);
 assert.equal(at(r,'2026-11-20').conservativeFreeMarginCents,70000);
 assert.equal(r.conservative.endingCashCents,70000);
 assert.equal(r.conservative.endingFreeMarginCents,70000);
 assert.deepEqual(await getPlanningSummary(db,A),before);
 assert.equal((await getObligation(db,A,i.obligationId??crypto.randomUUID())),null);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,0);
 assert.equal((await simulatePlanning(db,A,input())).activeVirtualReserveCents,50000);
}));
test('F2 partial R$200 reservation releases only R$200 and replaces with hypothetical full R$500 debt',()=>using(async db=>{
 await wallet(db);const i=await intention(db);
 await transitionIntention(db,A,i.intentionId,{idempotencyKey:key('part'),action:'reserve',reservedCents:20000},clock);
 const r=await simulatePlanning(db,A,input(purchase(50000,{intentionId:i.intentionId})));
 assert.equal(at(r,from).conservativeFreeMarginCents,100000);
 assert.equal(at(r,'2026-11-20').releasedReservationCents,20000);
 assert.equal(at(r,'2026-11-20').conservativeFreeMarginCents,70000);
 assert.equal(r.conservative.endingFreeMarginCents,70000);
}));
test('F2 converting an F1 intention in REAL ledger then simulating must count only the outstanding debt once',()=>using(async db=>{
 await wallet(db);const i=await intention(db);
 await transitionIntention(db,A,i.intentionId,{idempotencyKey:key('reserve-before'),action:'reserve',reservedCents:50000},clock);
 const conversion=await transitionIntention(db,A,i.intentionId,{idempotencyKey:key('real-buy'),action:'convert',dueOn:'2026-12-15'},clock);
 const r=await simulatePlanning(db,A,input());
 assert.deepEqual([r.existingOutstandingObligationsCents,r.activeVirtualReserveCents,r.conservative.endingFreeMarginCents],[50000,0,70000]);
 await assert.rejects(()=>simulatePlanning(db,A,input(purchase(50000,{intentionId:i.intentionId}))),SimulationConflict);
 assert.equal(conversion.intention.state,'converted');
}));
test('F2 after real debt payment the cash snapshot already reflects debit, no second simulated deduction',()=>using(async db=>{
 const a=await wallet(db);
 const d=await debt(db,A,40000,'2026-11-25');
 await payObligation(db,A,{idempotencyKey:key('pay'),obligationId:d.obligationId,
  accountId:a.accountId,amountCents:40000,paidOn:'2026-11-15',method:'pix'},clock);
 const r=await simulatePlanning(db,A,input());
 assert.deepEqual([r.openingRealCashCents,r.existingOutstandingObligationsCents,
  r.conservative.endingCashCents,r.conservative.endingFreeMarginCents],[80000,0,80000,80000]);
 assert.equal(r.points.some(p=>p.outstandingPaymentsCents>0),false);
}));
test('F2 partial outstanding cash obligation and card invoice balance are scheduled separately, not twice',()=>using(async db=>{
 await wallet(db);
 const d=await debt(db,A,20000,'2026-11-25');
 const card=await createCard(db,A,{idempotencyKey:key('card'),name:'Crédito',
  institution:'Banco',limitCents:200000,closingDay:5,dueDay:15},clock);
 const p=await createPurchase(db,A,{idempotencyKey:key('credit-purchase'),cardId:card.cardId,
  title:'Monitor',totalCents:60000,purchasedOn:'2026-11-11',installments:2},clock);
 const r=await simulatePlanning(db,A,input());
 assert.deepEqual([r.existingOutstandingObligationsCents,r.existingOutstandingCardInvoicesCents],[20000,60000]);
 assert.equal(r.conservative.endingCashCents,70000,'January installment is outside the November–December horizon');
 assert.equal(r.conservative.endingFreeMarginCents,40000,'January debt remains an outstanding burden on free margin');
 for(const date of new Set(p.installments.map(x=>x.dueOn).filter(d=>d<=to))){
  assert.ok(at(r,date),'card invoice due date inside the window is scheduled once');
 }
 assert.equal(r.points.reduce((a,x)=>a+x.outstandingPaymentsCents,0),50000,
  'only November debt and December installment cause hypothetical outflow within the horizon');
 assert.equal((await getPlanningSummary(db,A)).cardInvoicesCents,60000);
 assert.equal((await getDashboard(db,A,{from,to})).cashFlow.expensesCents,0);
}));
test('F2 rejects invalid date order, >367-day horizon, past-due hypothetical, mismatched intention, wrong owner',()=>using(async db=>{
 await wallet(db);const i=await intention(db);const outsider=await intention(db,B,'bob');
 await assert.rejects(()=>simulatePlanning(db,A,{from:'2026-12-01',to:'2026-11-30'}),TypeError);
 await assert.rejects(()=>simulatePlanning(db,A,{from,to:'2028-01-01'}),TypeError);
 await assert.rejects(()=>simulatePlanning(db,A,input(purchase(50000,{dueOn:'2026-11-19'}))),TypeError);
 await assert.rejects(()=>simulatePlanning(db,A,input(purchase(50000,{purchaseOn:'2026-11-10'}))),TypeError);
 await assert.rejects(()=>simulatePlanning(db,A,input(purchase(60000,{intentionId:i.intentionId}))),SimulationConflict);
 await assert.rejects(()=>simulatePlanning(db,A,input(purchase(50000,{intentionId:outsider.intentionId}))),IntentionUnavailable);
}));
test('F2 simulation never mutates dashboard, timeline, exports, obligations, intentions or cash',()=>using(async db=>{
 const a=await wallet(db);await debt(db,A,30000,'2026-12-05');
 const i=await intention(db);await transitionIntention(db,A,i.intentionId,
  {idempotencyKey:key('reserve-only'),action:'reserve',reservedCents:25000},clock);
 const opts={from,to,asOf:from,status:'all'};
 const before={dashboard:await getDashboard(db,A,{from,to}),
  timeline:await readExportTimeline(db,A,opts),
  pdfRows:(await makeReport(db,A,{...opts,format:'pdf'})).rows,
  xlsxRows:(await makeReport(db,A,{...opts,format:'xlsx'})).rows,
  summary:await getPlanningSummary(db,A),
  movements:db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,
  debts:db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,
  events:db.raw.prepare('SELECT COUNT(*) n FROM purchase_intention_events').get().n,
 };
 await simulatePlanning(db,A,input(purchase(50000,{intentionId:i.intentionId})));
 await simulatePlanning(db,A,input());
 const after={dashboard:await getDashboard(db,A,{from,to}),
  timeline:await readExportTimeline(db,A,opts),
  pdfRows:(await makeReport(db,A,{...opts,format:'pdf'})).rows,
  xlsxRows:(await makeReport(db,A,{...opts,format:'xlsx'})).rows,
  summary:await getPlanningSummary(db,A),
  movements:db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,
  debts:db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,
  events:db.raw.prepare('SELECT COUNT(*) n FROM purchase_intention_events').get().n,
 };
 assert.deepEqual(after,before);
 assert.equal(a.balanceCents,120000);
}));
test('F2 A/B isolation: foreign incomes, debts and reserves never enter own scenario',()=>using(async db=>{
 await wallet(db,A,100000);await wallet(db,B,700000);
 const s=await freelancer(db,B);await expect(db,s,300000,'2026-11-28',B);
 await debt(db,B,200000,'2026-11-25');
 const it=await intention(db,B,'bob');await transitionIntention(db,B,it.intentionId,
  {idempotencyKey:key('reserve-bob'),action:'reserve',reservedCents:50000},clock);
 const al=await simulatePlanning(db,A,input()),bo=await simulatePlanning(db,B,input());
 assert.deepEqual([al.openingRealCashCents,al.existingOutstandingObligationsCents,
  al.unreceivedExplicitIncomeCents,al.activeVirtualReserveCents],[100000,0,0,0]);
 assert.deepEqual([bo.openingRealCashCents,bo.existingOutstandingObligationsCents,
  bo.unreceivedExplicitIncomeCents,bo.activeVirtualReserveCents],[700000,200000,300000,50000]);
}));
const BASE='http://127.0.0.1:8787',now=Date.parse('2026-11-11T13:00:00.000Z');
const session=async headers=>{const cookie=headers.get('cookie'),id=cookie==='u=alice'?'alice':cookie==='u=bob'?'bob':null;
 return id?{user:{id},session:{userId:id,expiresAt:new Date(now+120000)}}:null;};
async function http(db,path,user='alice',method='POST',body=null,origin=BASE){
 return handleFinancialHttp(new Request(BASE+path,{method,headers:{cookie:user?'u='+user:'',
  origin,'x-user-id':'bob',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),db,session,BASE,()=>now);
}
test('F2 HTTP POST is read-only, strict Better Auth/Origin, malformed/foreign reference rejected, no history inserted',()=>using(async db=>{
 await wallet(db);const i=await intention(db);await transitionIntention(db,A,i.intentionId,
  {idempotencyKey:key('reservation'),action:'reserve',reservedCents:20000},clock);
 const body={from,to,hypothetical:{amount:'500.00',purchaseOn:'2026-11-20',dueOn:'2026-12-15',intentionId:i.intentionId}};
 const p='/api/planning/simulate';
 assert.equal((await http(db,p,'')).status,401);
 assert.equal((await http(db,p,'alice','POST',body,'https://evil.invalid')).status,403);
 assert.equal((await http(db,p,'alice','GET')).status,405);
 assert.equal((await http(db,p+'?accountId=abc','alice','POST',body)).status,400);
 assert.equal((await http(db,p,'alice','POST',{...body,ownerId:'bob'})).status,400);
 assert.equal((await http(db,p,'alice','POST',{...body,hypothetical:{...body.hypothetical,ownerId:'bob'}})).status,400);
 assert.equal((await http(db,p,'alice','POST',{...body,hypothetical:{...body.hypothetical,amount:'foo'}})).status,400);
 assert.equal((await http(db,p,'bob','POST',body)).status,404);
 const result=await http(db,p,'alice','POST',body);
 assert.equal(result.status,200);
 const response=(await result.json()).simulation;
 assert.equal(response.hypothetical.replacedExistingReserveCents,20000);
 assert.equal(response.conservative.endingFreeMarginCents,70000);
 assert.equal((await http(db,p,'alice','POST',body)).status,200);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM purchase_intention_events').get().n,1);
}));
