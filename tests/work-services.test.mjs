import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAccount } from '../src/backend/accounts/accounts.ts';
import { postMovement } from '../src/backend/movements/movements.ts';
import { createWork,getWork,listWorks,changeWorkState,linkWorkMovement,getWorkHistory,getWorkMovements,availableWorkMovements,WorkConflict,WorkNotFound } from '../src/backend/work/work.ts';
import { getDashboard } from '../src/backend/dashboard/dashboard.ts';
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
    '0004_financial_obligations.sql','0005_internal_transfers.sql','0006_cancellations_refunds.sql',
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
 return postMovement(db,actor(user),{idempotencyKey:key(tag),accountId:a.accountId,direction,amountCents:cents,method:'pix',description:tag,occurredOn:'2026-11-11'},clock);
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
