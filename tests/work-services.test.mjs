import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAccount } from '../src/backend/accounts/accounts.ts';
import { createCard,createPurchase } from '../src/backend/cards/cards.ts';
import { payInvoice } from '../src/backend/cards/invoice-payments.ts';
import { postMovement } from '../src/backend/movements/movements.ts';
import { createWork,getWork,listWorks,changeWorkState,linkWorkMovement,getWorkHistory,getWorkMovements,availableWorkMovements,WorkConflict,WorkNotFound } from '../src/backend/work/work.ts';
import { getDashboard } from '../src/backend/dashboard/dashboard.ts';
import { makeReport, totalsOf } from '../src/backend/reports/report.ts';
import { readExportTimeline } from '../src/backend/timeline/timeline.ts';
import { handleFinancialHttp } from '../src/backend/http/accounts-handler.ts';
import { refundPaidExpense } from '../src/backend/compensations/compensations.ts';
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
    '0009_invoice_bank_reconciliation.sql','0010_work_services.sql']){
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
async function account(db,user='alice'){
 return createAccount(db,actor(user),{idempotencyKey:key('account-'+user),name:'Conta',kind:'general',funding:{mode:'external',cents:0}},clock);
}
async function move(db,a,tag,direction,cents,user='alice'){
 return postMovement(db,actor(user),{idempotencyKey:key(tag.replaceAll(' ','-')),accountId:a.accountId,direction,amountCents:cents,method:'pix',description:tag,occurredOn:'2026-11-11'},clock);
}
async function work(db,tag='service',user='alice',expectedCents=30000){
 return createWork(db,actor(user),{idempotencyKey:key(tag),title:'Freelancer',client:'Cliente',expectedCents,plannedOn:'2026-11-11',dueOn:'2026-11-25'},clock);
}
const link=(db,w,m,tag,user='alice')=>linkWorkMovement(db,actor(user),w.workId,{idempotencyKey:key(tag),movementId:m.movementId},clock);
test('E1 optional work and standalone income; receipt and execution states independent; costs R$40+60',()=>using(async db=>{
 const a=await account(db),w=await work(db);
 assert.equal(w.state,'planned');assert.equal(w.receivedCents,0);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.incomeCents,0);
 const standalone=await move(db,a,'standalone','income',7000);
 const partial=await move(db,a,'first receipt','income',10000);
 const next=await move(db,a,'second receipt','income',20000);
 const cost1=await move(db,a,'fuel','expense',4000);
 const cost2=await move(db,a,'material','expense',6000);
 const before=await getDashboard(db,actor('alice'),period);
 await changeWorkState(db,actor('alice'),w.workId,{idempotencyKey:key('realize'),state:'realized'},clock);
 let v=await link(db,w,partial,'link-first');
 assert.deepEqual([v.state,v.receiptState,v.receivedCents,v.remainingCents],['realized','partial',10000,20000]);
 await link(db,w,cost1,'link-fuel');await link(db,w,cost2,'link-material');
 v=await link(db,w,next,'link-second');
 assert.deepEqual([v.receiptState,v.receivedCents,v.costCents,v.netCents,v.remainingCents],['received',30000,10000,20000,0]);
 assert.deepEqual(await getDashboard(db,actor('alice'),period),before);
 assert.equal((await availableWorkMovements(db,actor('alice')))[0].movementId,standalone.movementId);
 assert.equal((await getWorkMovements(db,actor('alice'),w.workId)).length,4);
 assert.equal(db.raw.prepare('SELECT count(*) n FROM posted_cash_movements').get().n,5);
}));
test('E1 cancellation after partial receipt preserves reason, receipts and history without money',()=>using(async db=>{
 const a=await account(db),w=await work(db);
 const m=await move(db,a,'partial','income',10000);await link(db,w,m,'link');
 await changeWorkState(db,actor('alice'),w.workId,{idempotencyKey:key('confirm'),state:'confirmed'},clock);
 const payload={idempotencyKey:key('cancel'),state:'canceled',reason:'Cliente desistiu'};
 const result=await changeWorkState(db,actor('alice'),w.workId,payload,clock);
 assert.deepEqual([result.state,result.receiptState,result.receivedCents],['canceled','partial',10000]);
 assert.deepEqual(await changeWorkState(db,actor('alice'),w.workId,payload,clock),result);
 const history=await getWorkHistory(db,actor('alice'),w.workId);
 assert.deepEqual(history.map(h=>h.state),['canceled','confirmed','planned']);
 assert.equal(history[0].reason,'Cliente desistiu');
 await assert.rejects(()=>changeWorkState(db,actor('alice'),w.workId,{idempotencyKey:key('reopen'),state:'realized'},clock),WorkConflict);
 assert.equal(db.raw.prepare('SELECT count(*) n FROM posted_cash_movements').get().n,1);
}));
test('E1 immutable work and append-only histories, idempotent concurrent association, no cross-work or owner attribution',()=>using(async db=>{
 const a=await account(db),bob=await account(db,'bob'),w=await work(db),other=await work(db,'other'),wb=await work(db,'bob','bob');
 const m=await move(db,a,'one','income',1000),foreign=await move(db,bob,'foreign','income',1000,'bob');
 await assert.rejects(()=>getWork(db,actor('bob'),w.workId),WorkNotFound);
 await assert.rejects(()=>link(db,w,foreign,'foreign-link'),WorkNotFound);
 await assert.rejects(()=>link(db,wb,m,'foreign-work'),WorkNotFound);
 await Promise.all([link(db,w,m,'retry'),link(db,w,m,'retry'),link(db,w,m,'retry')]);
 assert.equal((await getWorkMovements(db,actor('alice'),w.workId)).length,1);
 await assert.rejects(()=>link(db,other,m,'double'),WorkConflict);
 assert.equal((await getWork(db,actor('alice'),other.workId)).receivedCents,0);
 assert.throws(()=>db.raw.exec("UPDATE work_services SET title='forged'"),/IMMUTABLE/);
 assert.throws(()=>db.raw.exec('DELETE FROM work_movement_links'),/IMMUTABLE/);
 assert.throws(()=>db.raw.exec('DELETE FROM work_state_events'),/IMMUTABLE/);
 assert.equal((await listWorks(db,actor('bob'))).length,1);
 assert.equal((await availableWorkMovements(db,actor('bob'))).length,1);
}));
test('E1 unknown expected value, zero agreed amount and surplus are distinct; invalid values rejected',()=>using(async db=>{
 const a=await account(db);
 const w=await work(db,'unknown','alice',null);
 assert.equal(w.receiptState,'unspecified');assert.equal(w.remainingCents,null);
 const z=await work(db,'zero','alice',0);
 const m=await move(db,a,'excess','income',1);
 const after=await link(db,z,m,'extra');
 assert.equal(after.receiptState,'above_expected');assert.equal(after.remainingCents,0);
 await assert.rejects(()=>work(db,'negative','alice',-1),RangeError);
 await assert.rejects(()=>createWork(db,actor('alice'),{idempotencyKey:key('date'),title:'X',plannedOn:'2026-02-30'},clock));
}));
const BASE='http://127.0.0.1:8787',now=Date.parse('2026-11-11T13:00:00Z');
const session=async h=>{const cookie=h.get('cookie');const u=cookie==='u=alice'?'alice':cookie==='u=bob'?'bob':null;return u?{user:{id:u},session:{userId:u,expiresAt:new Date(now+120000)}}:null;};
async function http(db,path,user='alice',method='GET',body=null,origin=BASE){
 return handleFinancialHttp(new Request(BASE+path,{method,headers:{cookie:user?'u='+user:'',origin,'x-user-id':'bob',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),db,session,BASE,()=>now);
}
test('E1 HTTP auth, origin, owner, allowlist, strict money and idempotency',()=>using(async db=>{
 assert.equal((await http(db,'/api/works','')).status,401);
 const payload={idempotencyKey:key('http'),title:'Serviço HTTP',expected:'300.00'};
 assert.equal((await http(db,'/api/works','alice','POST',payload,'https://evil.example')).status,403);
 assert.equal((await http(db,'/api/works','alice','POST',{...payload,ownerId:'bob'})).status,400);
 assert.equal((await http(db,'/api/works','alice','POST',{...payload,expected:'NaN'})).status,400);
 const res=await http(db,'/api/works','alice','POST',payload);assert.equal(res.status,201);
 const w=(await res.json()).work, path='/api/works/'+w.workId;
 assert.equal((await http(db,path,'bob')).status,404);
 assert.equal((await http(db,path+'/states','bob')).status,404);
 assert.equal((await http(db,path+'/movements','bob')).status,404);
 assert.equal((await http(db,path+'/states','bob','POST',{idempotencyKey:key('attack'),state:'canceled'})).status,404);
 assert.equal((await http(db,'/api/works?limit=1&limit=2')).status,400);
 assert.equal((await http(db,'/api/works','alice','POST',payload)).status,201);
 assert.equal((await http(db,'/api/works','alice','POST',{...payload,title:'Changed'})).status,409);
 assert.equal((await listWorks(db,actor('alice'))).length,1);
}));


test('E1 refund of a linked expense reduces its net cost and cannot be attributed as revenue',()=>using(async db=>{
 const a=await account(db),w=await work(db);
 const receipt=await move(db,a,'receipt','income',30000),expense=await move(db,a,'material','expense',6000);
 await link(db,w,receipt,'link-receipt');
 await link(db,w,expense,'link-expense');
 const refund=await refundPaidExpense(db,actor('alice'),{
  idempotencyKey:key('refund-material'),originalMovementId:expense.movementId,accountId:a.accountId,
  amountCents:2000,method:'pix',refundedOn:'2026-11-12',
 },clock);
 const result=await getWork(db,actor('alice'),w.workId);
 assert.deepEqual([result.receivedCents,result.costCents,result.netCents],[30000,4000,26000]);
 const linked=(await getWorkMovements(db,actor('alice'),w.workId)).find(m=>m.movementId===expense.movementId);
 assert.equal(linked.refundedCents,2000);
 assert.equal((await availableWorkMovements(db,actor('alice'))).length,0);
 await assert.rejects(()=>linkWorkMovement(db,actor('alice'),w.workId,{
  idempotencyKey:key('try-refund-credit'),movementId:refund.refundMovementId,
 },clock),WorkConflict);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.netCents,26000);
}));

test('E1 injected initial state failure rolls back the work itself; same request can retry',()=>using(async db=>{
 const payload={idempotencyKey:key('fault-work'),title:'Atomic work'};
 db.raw.exec("CREATE TRIGGER e1_fault BEFORE INSERT ON work_state_events BEGIN SELECT RAISE(ABORT,'E1_FAULT'); END");
 await assert.rejects(()=>createWork(db,actor('alice'),payload,clock),/E1_FAULT/);
 assert.equal(db.raw.prepare('SELECT count(*) n FROM work_services').get().n,0);
 db.raw.exec('DROP TRIGGER e1_fault');
 const result=await createWork(db,actor('alice'),payload,clock);
 assert.equal(result.state,'planned');
 assert.equal((await getWorkHistory(db,actor('alice'),result.workId)).length,1);
}));

test('E1 concurrent conflicting work attribution and final state transitions remain serialized',()=>using(async db=>{
 const a=await account(db),one=await work(db,'first'),two=await work(db,'second');
 const m=await move(db,a,'race','income',10000);
 const result=await Promise.allSettled([link(db,one,m,'race-one'),link(db,two,m,'race-two')]);
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(result.filter(x=>x.status==='rejected').length,1);
 assert.equal(db.raw.prepare('SELECT count(*) n FROM work_movement_links').get().n,1);
 assert.equal((await listWorks(db,actor('alice'))).reduce((s,w)=>s+w.receivedCents,0),10000);
 const transitions=await Promise.allSettled([
  changeWorkState(db,actor('alice'),one.workId,{idempotencyKey:key('cancel-first'),state:'canceled'},clock),
  changeWorkState(db,actor('alice'),one.workId,{idempotencyKey:key('cancel-second'),state:'canceled'},clock),
 ]);
 assert.equal(transitions.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await getWorkHistory(db,actor('alice'),one.workId)).filter(x=>x.state==='canceled').length,1);
}));


test('E1 INSERT OR REPLACE cannot rewrite immutable work, reassign links or forge state chronology',()=>using(async db=>{
 const a=await account(db),one=await work(db,'one'),two=await work(db,'two');
 const m=await move(db,a,'linked','income',10000);await link(db,one,m,'immutable-link');
 db.raw.exec('PRAGMA recursive_triggers=OFF');
 assert.throws(()=>db.raw.prepare("INSERT OR REPLACE INTO work_services(owner_user_id,work_id,creation_key,title,created_at) VALUES(?,?,?,?,?)").run('alice',one.workId,key('other'),'Rewritten',clock().toISOString()),/WORK_HISTORY_IMMUTABLE/);
 assert.throws(()=>db.raw.prepare('INSERT OR REPLACE INTO work_movement_links(owner_user_id,work_id,movement_id,creation_key,created_at) VALUES(?,?,?,?,?)').run('alice',two.workId,m.movementId,key('different'),clock().toISOString()),/WORK_LINK_ALREADY_USED/);
 assert.throws(()=>db.raw.prepare("INSERT INTO work_state_events(seq,owner_user_id,work_id,creation_key,state,created_at) VALUES(?,?,?,?,?,?)").run(99,'alice',one.workId,key('fake-seq'),'confirmed',clock().toISOString()),/WORK_HISTORY_IMMUTABLE/);
 assert.equal((await getWork(db,actor('alice'),one.workId)).receivedCents,10000);
 assert.equal((await getWork(db,actor('alice'),two.workId)).receivedCents,0);
 assert.equal((await getWork(db,actor('alice'),one.workId)).state,'planned');
}));

test('E1 work attribution never duplicates timeline or XLSX/PDF cashflow',()=>using(async db=>{
 const a=await account(db),w=await work(db);
 const income=await move(db,a,'received','income',30000),f=await move(db,a,'fuel','expense',4000),m=await move(db,a,'materials','expense',6000);
 const filter={...period,asOf:'2026-11-11',status:'all'};
 const before=await readExportTimeline(db,actor('alice'),filter);
 await link(db,w,income,'l-income');await link(db,w,f,'l-fuel');await link(db,w,m,'l-material');
 const after=await readExportTimeline(db,actor('alice'),filter);
 assert.deepEqual(after,before);
 assert.deepEqual(totalsOf(after),{incomeCents:30000,expensesCents:10000,refundsCents:0,transfersCents:0,outstandingCents:0,netCents:20000});
 for(const format of ['xlsx','pdf']){
  const doc=await makeReport(db,actor('alice'),{...filter,format});
  assert.equal(doc.rows,3);assert.ok(doc.bytes.length>100);
 }
}));
test('E1 notes accept ordinary line breaks but reject unsafe control characters',()=>using(async db=>{
 const w=await createWork(db,actor('alice'),{idempotencyKey:key('notes'),title:'Notes',notes:'Etapa 1\r\nEtapa 2'},clock);
 assert.equal(w.notes,'Etapa 1\nEtapa 2');
 await assert.rejects(()=>createWork(db,actor('alice'),{idempotencyKey:key('control'),title:'Notes',notes:'A\u0000B'},clock),TypeError);
}));


test('E1 safe centavo aggregate guard rejects the overflowing link before persisting',()=>using(async db=>{
 const a=await account(db),w=await work(db);
 const raw=db.raw.prepare("INSERT INTO posted_cash_movements(owner_user_id,movement_id,creation_key,account_id,direction,amount_cents,payment_method,description,occurred_on,created_at) VALUES(?,?,?,?,'income',?,'pix','Test large receipt','2026-11-11',?)");
 const attach=db.raw.prepare('INSERT INTO work_movement_links(owner_user_id,work_id,movement_id,creation_key,created_at) VALUES(?,?,?,?,?)');
 db.raw.exec('BEGIN IMMEDIATE');
 for(let n=0;n<1000;n++){
  const mid=crypto.randomUUID();
  raw.run('alice',mid,key('large-'+n),a.accountId,9000000000000,clock().toISOString());
  attach.run('alice',w.workId,mid,key('link-'+n),clock().toISOString());
 }
 const extra=crypto.randomUUID();
 raw.run('alice',extra,key('extra-large'),a.accountId,9000000000000,clock().toISOString());
 db.raw.exec('COMMIT');
 await assert.rejects(()=>linkWorkMovement(db,actor('alice'),w.workId,{idempotencyKey:key('overflow'),movementId:extra},clock),WorkConflict);
 assert.equal((await getWork(db,actor('alice'),w.workId)).receivedCents,9000000000000000);
 assert.equal(db.raw.prepare('SELECT count(*) n FROM work_movement_links').get().n,1000);
}));

test('E1 card invoice settlement is not an individualized work cost and cannot be linked',()=>using(async db=>{
 const a=await account(db),w=await work(db);
 const card=await createCard(db,actor('alice'),{idempotencyKey:key('card'),name:'Cartão E1',limitCents:100000,closingDay:25,dueDay:5},clock);
 await createPurchase(db,actor('alice'),{idempotencyKey:key('purchase'),cardId:card.cardId,title:'Compra de cartão',purchasedOn:'2026-11-11',totalCents:10000,installments:1},clock);
 const payment=await payInvoice(db,actor('alice'),{idempotencyKey:key('pay-card'),cardId:card.cardId,cycle:'2026-11',accountId:a.accountId,amountCents:10000,method:'pix',paidOn:'2026-11-11'},clock);
 assert.deepEqual(await availableWorkMovements(db,actor('alice')),[]);
 await assert.rejects(()=>linkWorkMovement(db,actor('alice'),w.workId,{idempotencyKey:key('link-card'),movementId:payment.movementId},clock),WorkConflict);
 assert.equal((await getWork(db,actor('alice'),w.workId)).costCents,0);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.expensesCents,10000);
}));
