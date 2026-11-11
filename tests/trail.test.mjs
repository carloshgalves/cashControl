import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createAccount } from '../src/backend/accounts/accounts.ts';
import { postMovement } from '../src/backend/movements/movements.ts';
import { createObligation, payObligation } from '../src/backend/obligations/obligations.ts';
import { cancelUnpaidObligation, refundPaidExpense } from '../src/backend/compensations/compensations.ts';
import { createInternalTransfer } from '../src/backend/transfers/transfers.ts';
import { listTrail, listDueAlerts } from '../src/backend/trail/trail.ts';
import { parseCents } from '../src/domain/money.ts';
import { handleFinancialHttp } from '../src/backend/http/accounts-handler.ts';

class Statement {
  constructor(db,sql,args=[]) { this.db=db;this.sql=sql;this.args=args; }
  bind(...args) { return new Statement(this.db,this.sql,args); }
  async first() { return this.db.prepare(this.sql).get(...this.args)??null; }
  async all() { return {results:this.db.prepare(this.sql).all(...this.args)}; }
  async run() { return this.db.prepare(this.sql).run(...this.args); }
}
class DB {
  constructor() {
    this.raw=new DatabaseSync(':memory:');
    this.raw.exec('PRAGMA foreign_keys=ON');
    for(const name of ['0001_financial_accounts.sql','0002_better_auth.sql',
      '0003_cash_movements.sql','0004_financial_obligations.sql',
      '0005_internal_transfers.sql','0006_cancellations_refunds.sql']) {
      this.raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
    }
    this.queue=Promise.resolve();
  }
  prepare(sql){return new Statement(this.raw,sql);}
  batch(stmts){
    const transaction=async()=>{this.raw.exec('BEGIN IMMEDIATE');try{
      const out=[];for(const s of stmts)out.push(await s.run());this.raw.exec('COMMIT');return out;
    }catch(e){this.raw.exec('ROLLBACK');throw e;}};
    const task=this.queue.then(transaction);this.queue=task.catch(()=>{});return task;
  }
  close(){this.raw.close();}
}
const actor=userId=>({userId});
const cents=parseCents;
const key=s=>'trail-fixture-'+s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9_-]/g,'-');
const clock=()=>new Date('2026-11-11T12:00:00.000Z');
const range=(overrides={})=>({from:'2026-11-01',to:'2026-11-30',asOf:'2026-11-11',...overrides});
async function withDb(fn){const db=new DB();try{return await fn(db)}finally{db.close()}}
async function wallet(db,who='alice',name='Principal',balance='200') {
  return createAccount(db,actor(who),{idempotencyKey:key('acc-'+who+'-'+name),
    name,kind:'bank',funding:{mode:'external',cents:cents(balance)}},clock);
}
async function bill(db,who,title,dueOn='2026-11-21',amount='50') {
  return createObligation(db,actor(who),{idempotencyKey:key('bill-'+who+'-'+title),
    title,totalCents:cents(amount),dueOn},clock);
}
async function movement(db,who,accountId,direction,tag,amount='10',date='2026-11-11') {
  return postMovement(db,actor(who),{
    idempotencyKey:key('move-'+who+'-'+tag),accountId,direction,
    amountCents:cents(amount),method:'pix',description:tag,occurredOn:date,
  },clock);
}

test('empty accounts and events produce empty, owner-scoped trail and alerts',()=>withDb(async db=>{
  const page=await listTrail(db,actor('alice'),range());
  assert.deepEqual(page.events,[]);
  assert.equal(page.hasMore,false);
  assert.deepEqual((await listDueAlerts(db,actor('alice'),{asOf:'2026-11-11'})).alerts,[]);
}));

test('confirmed cash income and expense appear exactly once and do not duplicate balance',()=>withDb(async db=>{
  const a=await wallet(db);
  const income=await movement(db,'alice',a.accountId,'income','Salário','31.01');
  const expense=await movement(db,'alice',a.accountId,'expense','Mercado','12.05');
  const page=await listTrail(db,actor('alice'),range());
  assert.deepEqual(page.events.map(x=>x.kind).sort(),['expense','income']);
  assert.deepEqual(page.events.map(x=>x.id).sort(),[income.movementId,expense.movementId].sort());
  assert.equal(page.events.filter(x=>x.timing==='scheduled').length,0);
  assert(page.events.every(x=>x.status==='realized'));
}));

test('obligations are scheduled, never confirmed cash, with pending vs overdue state',()=>withDb(async db=>{
  await bill(db,'alice','Próxima','2026-11-21','40');
  await bill(db,'alice','Atrasada','2026-11-10','25');
  const view=await listTrail(db,actor('alice'),range());
  assert.deepEqual(view.events.filter(x=>x.kind==='obligation').map(x=>[x.title,x.status]),
    [['Próxima','pending'],['Atrasada','overdue']]);
  assert(view.events.filter(x=>x.kind==='obligation').every(x=>x.timing==='scheduled'));
  assert.equal(view.events.reduce((sum,x)=>sum+(x.status==='realized'?x.amountCents:0),0),0);
}));

test('paid bill has one payment event and never remains a live scheduled obligation',()=>withDb(async db=>{
  const a=await wallet(db);
  const o=await bill(db,'alice','Internet','2026-11-21','20');
  const p=await payObligation(db,actor('alice'),{
    idempotencyKey:key('pay-internet'),obligationId:o.obligationId,accountId:a.accountId,
    amountCents:cents('20'),method:'pix',paidOn:'2026-11-11',
  },clock);
  const view=await listTrail(db,actor('alice'),range());
  assert.deepEqual(view.events.map(x=>x.kind),['payment']);
  assert.equal(view.events[0].id,p.movementId);
  assert.equal(view.events[0].obligationId,o.obligationId);
  assert.equal((await listDueAlerts(db,actor('alice'),{asOf:'2026-11-11'})).alerts.length,0);
}));

test('partial payment only leaves remaining due amount; refund restores exact outstanding',()=>withDb(async db=>{
  const a=await wallet(db);
  const o=await bill(db,'alice','Serviço','2026-11-21','100');
  const p=await payObligation(db,actor('alice'),{
    idempotencyKey:key('partial-pay'),obligationId:o.obligationId,accountId:a.accountId,
    amountCents:cents('80'),method:'pix',paidOn:'2026-11-11',
  },clock);
  let page=await listTrail(db,actor('alice'),range());
  assert.equal(page.events.find(x=>x.kind==='obligation').amountCents,2000);
  await refundPaidExpense(db,actor('alice'),{
    idempotencyKey:key('refund-bill'),originalMovementId:p.movementId,
    accountId:a.accountId,amountCents:cents('30'),refundedOn:'2026-11-11',method:'pix',
  },clock);
  page=await listTrail(db,actor('alice'),range());
  assert.equal(page.events.find(x=>x.kind==='obligation').amountCents,5000);
  assert.equal(page.events.filter(x=>x.kind==='refund').length,1);
  assert.equal(page.events.filter(x=>x.kind==='payment').length,1);
  const alert=(await listDueAlerts(db,actor('alice'),{asOf:'2026-11-11'})).alerts[0];
  assert.equal(alert.outstandingCents,5000);
}));

test('canceled bill remains an actual cancellation event, not an active due',()=>withDb(async db=>{
  const o=await bill(db,'alice','Cancelável','2026-11-21','30');
  await cancelUnpaidObligation(db,actor('alice'),{
    idempotencyKey:key('cancel-pending'),obligationId:o.obligationId,canceledOn:'2026-11-11',
  },clock);
  const page=await listTrail(db,actor('alice'),range());
  assert.deepEqual(page.events.map(x=>x.kind),['cancellation']);
  assert.equal(page.events[0].status,'canceled');
  assert.equal(page.events[0].amountCents,0);
  assert.deepEqual((await listDueAlerts(db,actor('alice'),{asOf:'2026-11-11'})).alerts,[]);
}));

test('internal transfer appears once, not as income or expense',()=>withDb(async db=>{
  const a=await wallet(db);
  const b=await wallet(db,'alice','Reserva','0');
  await createInternalTransfer(db,actor('alice'),{
    idempotencyKey:key('transfer-01'),sourceAccountId:a.accountId,targetAccountId:b.accountId,
    amountCents:cents('40'),transferredOn:'2026-11-11',
  },clock);
  const page=await listTrail(db,actor('alice'),range());
  assert.equal(page.events.length,1);
  assert.equal(page.events[0].kind,'transfer');
  assert.equal(page.events[0].amountCents,4000);
}));

test('D-10, D-5 and TODAY window boundaries are deterministic, outside excluded',()=>withDb(async db=>{
  const cases=[
    ['D11','2026-11-22'],['D10','2026-11-21'],['D6','2026-11-17'],
    ['D5','2026-11-16'],['D1','2026-11-12'],['Today','2026-11-11'],
    ['Past','2026-11-10'],
  ];
  for(const [title,date]of cases)await bill(db,'alice',title,date,'20');
  const a=(await listDueAlerts(db,actor('alice'),{asOf:'2026-11-11'})).alerts;
  assert.deepEqual(a.map(x=>[x.title,x.daysUntilDue,x.stage]),[
    ['Today',0,'TODAY'],['D1',1,'D-5'],['D5',5,'D-5'],
    ['D6',6,'D-10'],['D10',10,'D-10'],
  ]);
  assert(!a.some(x=>x.title==='D11'||x.title==='Past'));
}));

test('leap day and year boundary distances follow civil calendar, not server clock',()=>withDb(async db=>{
  await bill(db,'alice','Bissexto','2024-02-29');
  await bill(db,'alice','Ano Novo','2027-01-01');
  const leap=(await listDueAlerts(db,actor('alice'),{asOf:'2024-02-19'})).alerts;
  assert.deepEqual(leap.map(x=>[x.title,x.daysUntilDue,x.stage]),[['Bissexto',10,'D-10']]);
  const boundary=(await listDueAlerts(db,actor('alice'),{asOf:'2026-12-27'})).alerts;
  assert.deepEqual(boundary.map(x=>[x.title,x.daysUntilDue,x.stage]),[['Ano Novo',5,'D-5']]);
}));

test('global pagination over mixed event types has no holes, duplicates or overfetch leakage',()=>withDb(async db=>{
  const a=await wallet(db);
  await bill(db,'alice','Due','2026-11-11');
  await movement(db,'alice',a.accountId,'income','Cash','30');
  await createInternalTransfer(db,actor('alice'),{
    idempotencyKey:key('pagination-transfer'),
    sourceAccountId:a.accountId,targetAccountId:(await wallet(db,'alice','Target','0')).accountId,
    amountCents:cents('5'),transferredOn:'2026-11-11',
  },clock);
  const all=await listTrail(db,actor('alice'),range());
  assert.equal(all.events.length,3);
  const first=await listTrail(db,actor('alice'),range({limit:1,offset:0}));
  const second=await listTrail(db,actor('alice'),range({limit:1,offset:1}));
  const third=await listTrail(db,actor('alice'),range({limit:1,offset:2}));
  assert.equal(first.hasMore,true);assert.equal(second.hasMore,true);assert.equal(third.hasMore,false);
  assert.deepEqual([first.events[0].id,second.events[0].id,third.events[0].id],all.events.map(x=>x.id));
  assert.equal(new Set(all.events.map(x=>x.id)).size,3);
  assert.deepEqual((await listTrail(db,actor('alice'),range({status:'realized'}))).events.map(x=>x.kind).sort(),
    ['income','transfer']);
  assert.deepEqual((await listTrail(db,actor('alice'),range({status:'scheduled'}))).events.map(x=>x.kind),
    ['obligation']);
}));

test('owner boundary prevents cross-tenant history and alerts, even with known IDs',()=>withDb(async db=>{
  const alice=await wallet(db,'alice');
  await movement(db,'alice',alice.accountId,'income','Alice wage','43');
  await bill(db,'alice','Secret Bill','2026-11-16');
  const bob=await wallet(db,'bob','Bob','10');
  await movement(db,'bob',bob.accountId,'expense','Bob expense','2');
  await bill(db,'bob','Bob Due','2026-11-17');
  const a=await listTrail(db,actor('alice'),range());
  const b=await listTrail(db,actor('bob'),range());
  assert.deepEqual(a.events.map(x=>x.title).sort(),['Alice wage','Secret Bill']);
  assert.deepEqual(b.events.map(x=>x.title).sort(),['Bob Due','Bob expense']);
  assert.deepEqual((await listDueAlerts(db,actor('alice'),{asOf:'2026-11-11'})).alerts.map(x=>x.title),['Secret Bill']);
  assert.deepEqual((await listDueAlerts(db,actor('bob'),{asOf:'2026-11-11'})).alerts.map(x=>x.title),['Bob Due']);
}));

test('invalid filters dates and bounds fail without disclosing ledger',()=>withDb(async db=>{
  for(const bad of [
    {from:'2026-11-31'}, {to:'2026-02-29'}, {asOf:'2026-00-01'},
    {from:'2026-12-01',to:'2026-11-30'}, {status:'owner:all'},
    {limit:0}, {limit:101}, {offset:-1}, {offset:1.3},
  ]) await assert.rejects(()=>listTrail(db,actor('alice'),range(bad)));
  for(const bad of [{asOf:'2026-11-31'}, {asOf:'2026-11-11',limit:101},
    {asOf:'2026-11-11',offset:-1}])
    await assert.rejects(()=>listDueAlerts(db,actor('alice'),bad));
}));

const base='https://cash.example',now=Date.parse('2026-11-11T12:00:00Z');
const session=async h=>{
  const user=h.get('cookie')==='session=alice'?'alice':h.get('cookie')==='session=bob'?'bob':null;
  return user?{user:{id:user},session:{userId:user,expiresAt:new Date(now+60_000)}}:null;
};
async function call(db,path,cookie){
  const response=await handleFinancialHttp(new Request(base+path,{headers:{cookie,'x-user-id':'bob'}}),
    db,session,base,()=>now);
  return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};
}
test('HTTP rejects unauthenticated, spoofed and duplicate filters and returns no-store',()=>withDb(async db=>{
  const a=await wallet(db);
  await movement(db,'alice',a.accountId,'income','Private','10');
  const qs='?from=2026-11-01&to=2026-11-30&asOf=2026-11-11';
  assert.equal((await call(db,'/api/trail'+qs,'')).status,401);
  assert.equal((await call(db,'/api/trail'+qs+'&ownerId=bob','session=alice')).status,400);
  assert.equal((await call(db,'/api/trail'+qs+'&status=realized&status=overdue','session=alice')).status,400);
  assert.equal((await call(db,'/api/trail'+qs+'&limit=500','session=alice')).status,400);
  const aView=await call(db,'/api/trail'+qs,'session=alice');
  assert.equal(aView.status,200);assert.equal(aView.cache,'no-store');
  assert.equal(aView.body.events.length,1);
  assert.deepEqual((await call(db,'/api/trail'+qs,'session=bob')).body.events,[]);
  assert.equal((await call(db,'/api/due-alerts?asOf=2026-11-11&ownerId=alice','session=bob')).status,400);
  assert.equal((await call(db,'/api/due-alerts?asOf=2026-11-11','session=bob')).status,200);
}));
