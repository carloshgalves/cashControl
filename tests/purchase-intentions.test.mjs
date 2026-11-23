import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createIntention,getIntention,listIntentions,listIntentionEvents,transitionIntention,getPlanningSummary,IntentionConflict,IntentionUnavailable} from '../src/backend/planning/intentions.ts';
import {createAccount} from '../src/backend/accounts/accounts.ts';
import {createObligation,getObligation,payObligation} from '../src/backend/obligations/obligations.ts';
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





const period={from:'2026-11-01',to:'2026-11-30'};
const u=actor('alice'),bob=actor('bob');
const newIntent=(tag='laptop',amountCents=50000)=>({
 idempotencyKey:key('intent-'+tag),title:'Notebook',description:'Planejamento de notebook',
 amountCents,plannedOn:'2026-11-30',
});
const step=(action,tag,overrides={})=>({idempotencyKey:key('action-'+tag),action,...(action==='convert'?{dueOn:'2026-11-30'}:{}),...overrides});
async function intent(db,tag='laptop',amountCents=50000){return createIntention(db,u,newIntent(tag,amountCents),clock);}
async function wallet(db,amount=120000){
 return createAccount(db,u,{idempotencyKey:key('bank'),name:'Carteira principal',
  kind:'general',funding:{mode:'external',cents:amount}},clock);
}
test('F1 planning an R$500 intention is neither bank outflow nor obligation/reservation',()=>using(async db=>{
 const a=await wallet(db),initial=await getDashboard(db,u,period);
 const i=await intent(db),s=await getPlanningSummary(db,u),after=await getDashboard(db,u,period);
 assert.deepEqual([i.state,i.amountCents,i.reservedCents,i.obligationId],['planning',50000,0,null]);
 assert.deepEqual([s.cashBalanceCents,s.activeReserveCents,s.obligationsCents,s.freeMarginCents],[120000,0,0,120000]);
 assert.deepEqual(after,initial);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
 assert.equal(a.balanceCents,120000);
}));
test('F1 partial or full reserve changes only free projected margin; removing reservation restores it',()=>using(async db=>{
 await wallet(db);const i=await intent(db);
 await transitionIntention(db,u,i.intentionId,step('reserve','part',{reservedCents:25000}),clock);
 let s=await getPlanningSummary(db,u);
 assert.deepEqual([s.activeReserveCount,s.activeReserveCents,s.freeMarginCents],[1,25000,95000]);
 await transitionIntention(db,u,i.intentionId,step('reserve','full',{reservedCents:50000}),clock);
 s=await getPlanningSummary(db,u);
 assert.deepEqual([s.activeReserveCents,s.freeMarginCents],[50000,70000]);
 await assert.rejects(()=>transitionIntention(db,u,i.intentionId,step('reserve','redundant',{reservedCents:50000}),clock),IntentionConflict);
 await transitionIntention(db,u,i.intentionId,step('plan','return'),clock);
 s=await getPlanningSummary(db,u);
 assert.deepEqual([s.activeReserveCount,s.activeReserveCents,s.freeMarginCents],[0,0,120000]);
 assert.equal((await getIntention(db,u,i.intentionId)).state,'planning');
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
}));
test('F1 reserve R$500 → confirmed purchase R$500 replaces reserve with obligation, no duplicated commitment',()=>using(async db=>{
 await wallet(db);const i=await intent(db);
 await transitionIntention(db,u,i.intentionId,step('reserve','r500',{reservedCents:50000}),clock);
 const before=await getPlanningSummary(db,u),cashBefore=await getDashboard(db,u,period);
 assert.deepEqual([before.activeReserveCents,before.obligationsCents,before.freeMarginCents],[50000,0,70000]);
 const result=await transitionIntention(db,u,i.intentionId,step('convert','buy'),clock);
 const after=await getPlanningSummary(db,u),cashAfter=await getDashboard(db,u,period);
 assert.deepEqual([result.intention.state,result.intention.reservedCents],['converted',0]);
 assert.deepEqual([after.activeReserveCents,after.obligationsCents,after.freeMarginCents],[0,50000,70000]);
 assert.deepEqual(cashAfter.balances,cashBefore.balances);
 assert.equal(cashAfter.cashFlow.expensesCents,0);
 const obligation=await getObligation(db,u,result.intention.obligationId);
 assert.deepEqual([obligation.title,obligation.totalCents,obligation.dueOn,obligation.state],['Notebook',50000,'2026-11-30','open']);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,1);
 const events=await listIntentionEvents(db,u,i.intentionId);
 assert.deepEqual(events.map(x=>x.action),['convert','reserve']);
}));
test('F1 partial R$200 reserve replaced by full R$500 payable, never R$700',()=>using(async db=>{
 await wallet(db);const i=await intent(db);
 await transitionIntention(db,u,i.intentionId,step('reserve','r200',{reservedCents:20000}),clock);
 assert.equal((await getPlanningSummary(db,u)).freeMarginCents,100000);
 await transitionIntention(db,u,i.intentionId,step('convert','purchase'),clock);
 assert.equal((await getPlanningSummary(db,u)).freeMarginCents,70000);
 assert.equal((await getPlanningSummary(db,u)).activeReserveCents,0);
}));
test('F1 purchased intention cannot be deleted/reused and paying obligation makes only ONE cash expense',()=>using(async db=>{
 const a=await wallet(db);const i=await intent(db);
 const conversion=await transitionIntention(db,u,i.intentionId,step('convert','purchase'),clock);
 for(const action of ['exclude','plan','reserve','convert']){
  await assert.rejects(()=>transitionIntention(db,u,i.intentionId,
   step(action,'forbidden-'+action,action==='reserve'?{reservedCents:100}:{}),clock),IntentionConflict);
 }
 const paid=await payObligation(db,u,{idempotencyKey:key('paid'),obligationId:conversion.intention.obligationId,
  accountId:a.accountId,amountCents:50000,paidOn:'2026-11-30',method:'pix'},clock);
 assert.equal(paid.amountCents,50000);
 assert.deepEqual([(await getDashboard(db,u,period)).cashFlow.expensesCents,
  (await getPlanningSummary(db,u)).freeMarginCents],[50000,70000]);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,1);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,1);
 assert.equal((await getIntention(db,u,i.intentionId)).state,'converted');
 const trail=await readExportTimeline(db,u,{...period,asOf:'2026-11-30',status:'all'});
 assert.equal(trail.filter(e=>e.kind==='payment'&&e.status==='realized').length,1);
 for(const format of ['pdf','xlsx'])assert.equal((await makeReport(db,u,{...period,asOf:'2026-11-30',status:'all',format})).rows,1);
}));
test('F1 removing unpurchased intention preserves audit, no money or obligations are removed',()=>using(async db=>{
 await wallet(db);const i=await intent(db);
 await transitionIntention(db,u,i.intentionId,step('reserve','save',{reservedCents:35000}),clock);
 await transitionIntention(db,u,i.intentionId,step('exclude','delete'),clock);
 assert.equal((await getIntention(db,u,i.intentionId)).state,'excluded');
 assert.equal((await getPlanningSummary(db,u)).activeReserveCents,0);
 await assert.rejects(()=>transitionIntention(db,u,i.intentionId,step('convert','too-late'),clock),IntentionConflict);
 assert.equal((await listIntentionEvents(db,u,i.intentionId)).length,2);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
}));
test('F1 active reserves accumulate across intentions but never as new bank movements',()=>using(async db=>{
 await wallet(db);const a=await intent(db,'a'),b=await intent(db,'b');
 await transitionIntention(db,u,a.intentionId,step('reserve','a',{reservedCents:30000}),clock);
 await transitionIntention(db,u,b.intentionId,step('reserve','b',{reservedCents:50000}),clock);
 const s=await getPlanningSummary(db,u);
 assert.deepEqual([s.activeReserveCount,s.activeReserveCents,s.freeMarginCents],[2,80000,40000]);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
}));
test('F1 existing outstanding bills and card invoices remain distinct from active reserves',()=>using(async db=>{
 await wallet(db);await createObligation(db,u,{
  idempotencyKey:key('independent'),title:'Energia',totalCents:40000,dueOn:'2026-11-30'},clock);
 const i=await intent(db);await transitionIntention(db,u,i.intentionId,step('reserve','r',{reservedCents:50000}),clock);
 const s=await getPlanningSummary(db,u);
 assert.deepEqual([s.cashBalanceCents,s.obligationsCents,s.activeReserveCents,s.freeMarginCents],[120000,40000,50000,30000]);
}));
test('F1 warning state negative margin is allowed and never blocks commitment automatically',()=>using(async db=>{
 await wallet(db,0);const i=await intent(db);await transitionIntention(db,u,i.intentionId,step('reserve','negative',{reservedCents:50000}),clock);
 assert.equal((await getPlanningSummary(db,u)).freeMarginCents,-50000);
 const result=await transitionIntention(db,u,i.intentionId,step('convert','negative-purchase'),clock);
 assert.equal(result.intention.state,'converted');
 assert.equal((await getPlanningSummary(db,u)).freeMarginCents,-50000);
}));
test('F1 repeated requests return same event/obligation while conflicting reused key fails',()=>using(async db=>{
 await wallet(db);const request=newIntent(),xs=await Promise.all(Array.from({length:3},()=>createIntention(db,u,request,clock)));
 assert.equal(new Set(xs.map(x=>x.intentionId)).size,1);
 await assert.rejects(()=>createIntention(db,u,{...request,amountCents:45000},clock),IntentionConflict);
 const i=xs[0];const reserve=step('reserve','r',{reservedCents:50000});
 const ys=await Promise.all(Array.from({length:3},()=>transitionIntention(db,u,i.intentionId,reserve,clock)));
 assert.equal(new Set(ys.map(x=>x.event.eventId)).size,1);
 await assert.rejects(()=>transitionIntention(db,u,i.intentionId,step('reserve','r',{reservedCents:49000}),clock),IntentionConflict);
 const conversion=step('convert','conversion');
 const zz=await Promise.all(Array.from({length:3},()=>transitionIntention(db,u,i.intentionId,conversion,clock)));
 assert.equal(new Set(zz.map(x=>x.intention.obligationId)).size,1);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,1);
}));
test('F1 competing conversion keys produce one payable and no orphan commitment',()=>using(async db=>{
 await wallet(db);const i=await intent(db);
 await transitionIntention(db,u,i.intentionId,step('reserve','start',{reservedCents:50000}),clock);
 const attempts=await Promise.allSettled([
  transitionIntention(db,u,i.intentionId,step('convert','race1'),clock),
  transitionIntention(db,u,i.intentionId,step('convert','race2'),clock),
 ]);
 assert.deepEqual(attempts.map(x=>x.status).sort(),['fulfilled','rejected']);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,1);
 assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM purchase_intention_events WHERE action='convert'").get().n,1);
 assert.equal((await getPlanningSummary(db,u)).activeReserveCents,0);
}));
test('F1 SQL injection failure on conversion event rolls back newly created payable (D1 batch)',()=>using(async db=>{
 await wallet(db);const i=await intent(db);
 db.raw.exec("CREATE TRIGGER f1_fault BEFORE INSERT ON purchase_intention_events WHEN NEW.action='convert' BEGIN SELECT RAISE(ABORT,'F1_INJECTED_FAILURE'); END");
 await assert.rejects(()=>transitionIntention(db,u,i.intentionId,step('convert','retry'),clock),/F1_INJECTED_FAILURE/);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,0);
 assert.equal((await getIntention(db,u,i.intentionId)).state,'planning');
 db.raw.exec('DROP TRIGGER f1_fault');
 const success=await transitionIntention(db,u,i.intentionId,step('convert','retry'),clock);
 assert.equal(success.intention.state,'converted');
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,1);
}));
test('F1 cross-tenant ownership and enumeration never expose another user intention or commitment',()=>using(async db=>{
 const a=await intent(db),b=await createIntention(db,bob,{...newIntent('b'),title:'Compra de Bob'},clock);
 assert.equal(await getIntention(db,bob,a.intentionId),null);
 assert.equal(await getIntention(db,u,b.intentionId),null);
 assert.deepEqual((await listIntentions(db,u)).map(i=>i.intentionId),[a.intentionId]);
 await assert.rejects(()=>listIntentionEvents(db,bob,a.intentionId),IntentionUnavailable);
 await assert.rejects(()=>transitionIntention(db,bob,a.intentionId,step('reserve','intrude',{reservedCents:50000}),clock),IntentionUnavailable);
 assert.equal((await getPlanningSummary(db,bob)).activeReserveCents,0);
}));
test('F1 direct SQLite forged conversion, double conversion, REPLACE, UPDATE and DELETE cannot rewrite history',()=>using(async db=>{
 const i=await intent(db);const j=await intent(db,'second');
 const insert="INSERT INTO purchase_intention_events(owner_user_id,event_id,creation_key,intention_id,action,reserved_cents,obligation_id,created_at) VALUES(?,?,?,?,'reserve',?,NULL,?)";
 assert.throws(()=>db.raw.prepare(insert).run('bob',crypto.randomUUID(),key('forged'),i.intentionId,100,clock().toISOString()));
 await transitionIntention(db,u,i.intentionId,step('reserve','legit',{reservedCents:50000}),clock);
 db.raw.exec('PRAGMA recursive_triggers=OFF');
 assert.throws(()=>db.raw.exec('UPDATE purchase_intentions SET amount_cents=1'),/INTENTION_IMMUTABLE/);
 assert.throws(()=>db.raw.exec('DELETE FROM purchase_intention_events'),/INTENTION_EVENT_IMMUTABLE/);
 const raw=db.raw.prepare("INSERT OR REPLACE INTO purchase_intentions(owner_user_id,intention_id,creation_key,title,amount_cents,planned_on,created_at) VALUES(?,?,?,?,?,?,?)");
 assert.throws(()=>raw.run('alice',i.intentionId,key('rewritten'), 'Alterado',40000,'2026-11-30',clock().toISOString()),/INTENTION_IMMUTABLE/);
 const orig=db.raw.prepare('SELECT event_id,creation_key FROM purchase_intention_events LIMIT 1').get();
 const replacer=db.raw.prepare("INSERT OR REPLACE INTO purchase_intention_events(owner_user_id,event_id,creation_key,intention_id,action,reserved_cents,created_at) VALUES(?,?,?,?,'reserve',?,?)");
 assert.throws(()=>replacer.run('alice',orig.event_id,key('hijack'),j.intentionId,100,clock().toISOString()),/INTENTION_EVENT_INVALID/);
 assert.equal((await getIntention(db,u,i.intentionId)).reservedCents,50000);
}));
test('F1 user confirmation actions enforce idempotency and invalid amount, planned date, overreserve',()=>using(async db=>{
 await assert.rejects(()=>createIntention(db,u,{...newIntent(),plannedOn:'2026-02-30'},clock),TypeError);
 await assert.rejects(()=>createIntention(db,u,{...newIntent(),amountCents:0},clock),RangeError);
 const i=await intent(db);
 await assert.rejects(()=>transitionIntention(db,u,i.intentionId,step('reserve','overflow',{reservedCents:50001}),clock),IntentionConflict);
 await assert.rejects(()=>transitionIntention(db,u,i.intentionId,step('plan','no-active-reserve'),clock),IntentionConflict);
 await assert.rejects(()=>transitionIntention(db,u,i.intentionId,step('exclude','extra',{reservedCents:0}),clock),TypeError);
}));
const BASE='http://127.0.0.1:8787',now=Date.parse('2026-11-11T13:00:00Z');
const session=async headers=>{const cookie=headers.get('cookie'),who=cookie==='u=alice'?'alice':cookie==='u=bob'?'bob':null;return who?{user:{id:who},session:{userId:who,expiresAt:new Date(now+120000)}}:null;};
async function http(db,path,user='alice',method='GET',body=null,origin=BASE){
 return handleFinancialHttp(new Request(BASE+path,{method,headers:{cookie:user?'u='+user:'',origin,'x-user-id':'bob',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),db,session,BASE,()=>now);
}
test('F1 HTTP Better Auth session, Origin, unknown JSON fields, exact decimal, A/B and state transitions',()=>using(async db=>{
 const body={idempotencyKey:key('api'),title:'Celular',description:'Planejo comprar',
  amount:'500.00',plannedOn:'2026-11-30'};
 assert.equal((await http(db,'/api/intentions','')).status,401);
 assert.equal((await http(db,'/api/intentions','alice','POST',body,'https://evil.example')).status,403);
 assert.equal((await http(db,'/api/intentions','alice','POST',{...body,ownerUserId:'bob'})).status,400);
 assert.equal((await http(db,'/api/intentions','alice','POST',{...body,amount:'foo'})).status,400);
 const res=await http(db,'/api/intentions','alice','POST',body);
 assert.equal(res.status,201);
 const obj=(await res.json()).intention;assert.equal(obj.amountCents,50000);
 assert.equal((await http(db,'/api/intentions','alice','POST',body)).status,201);
 assert.equal((await http(db,'/api/intentions?limit=1&limit=2')).status,400);
 assert.equal((await http(db,'/api/intentions/'+obj.intentionId,'bob')).status,404);
 assert.equal((await http(db,'/api/intentions/'+obj.intentionId+'/events','bob')).status,404);
 const reserve='/api/intentions/'+obj.intentionId+'/events';
 assert.equal((await http(db,reserve,'alice','POST',{idempotencyKey:key('http-no-action'),action:'reserve',reserveAmount:'500.00',ownerId:'bob'})).status,400);
 assert.equal((await http(db,reserve,'alice','POST',{idempotencyKey:key('http-reserve'),action:'reserve',reserveAmount:'500.00'})).status,201);
 assert.equal((await (await http(db,'/api/planning-summary')).json()).summary.activeReserveCents,50000);
 assert.equal((await http(db,reserve,'alice','POST',{idempotencyKey:key('http-convert'),action:'convert',dueOn:'2026-11-30'})).status,201);
 assert.equal((await (await http(db,'/api/planning-summary')).json()).summary.activeReserveCents,0);
 assert.equal((await (await http(db,'/api/intentions/'+obj.intentionId)).json()).intention.state,'converted');
 assert.equal((await (await http(db,'/api/obligations')).json()).obligations.length,1);
 assert.equal((await http(db,reserve,'bob','POST',{idempotencyKey:key('cross'),action:'plan'})).status,404);
}));


test('F1 intended purchase date and actual obligation due date are independent and explicitly recorded',()=>using(async db=>{
 await wallet(db);
 const i=await intent(db,'future-date');
 const converted=await transitionIntention(db,u,i.intentionId,
  step('convert','due-next-month',{dueOn:'2026-12-15'}),clock);
 const obligation=await getObligation(db,u,converted.intention.obligationId);
 assert.equal(i.plannedOn,'2026-11-30');
 assert.equal(obligation.dueOn,'2026-12-15');
 assert.equal(converted.event.conversionDueOn,'2026-12-15');
 assert.equal((await getPlanningSummary(db,u)).obligationsCents,50000);
 assert.equal((await getPlanningSummary(db,u)).activeReserveCents,0);
 await assert.rejects(()=>transitionIntention(db,u,i.intentionId,step('convert','due-next-month',
  {dueOn:'2026-11-30'}),clock),IntentionConflict);
 await assert.rejects(()=>transitionIntention(db,u,i.intentionId,step('convert','invalid-date',
  {dueOn:'2026-02-30'}),clock),TypeError);
}));
