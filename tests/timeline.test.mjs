import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAccount } from '../src/backend/accounts/accounts.ts';
import { postMovement } from '../src/backend/movements/movements.ts';
import { createInternalTransfer } from '../src/backend/transfers/transfers.ts';
import { createObligation, payObligation } from '../src/backend/obligations/obligations.ts';
import { cancelUnpaidObligation, refundPaidExpense } from '../src/backend/compensations/compensations.ts';
import { listDueAlerts, listTimeline, daysBetween, validateDate } from '../src/backend/timeline/timeline.ts';
import { handleFinancialHttp } from '../src/backend/http/accounts-handler.ts';
import { parseCents } from '../src/domain/money.ts';

class Statement {
  constructor(db,sql,args=[]) {this.db=db;this.sql=sql;this.args=args;}
  bind(...values){return new Statement(this.db,this.sql,values);}
  async first(){return this.db.prepare(this.sql).get(...this.args) ?? null;}
  async all(){return {results:this.db.prepare(this.sql).all(...this.args)};}
  async run(){return this.db.prepare(this.sql).run(...this.args);}
}
class Db {
  constructor(){
    this.raw=new DatabaseSync(':memory:');
    this.raw.exec('PRAGMA foreign_keys=ON');
    for(const name of [
      '0001_financial_accounts.sql','0002_better_auth.sql','0003_cash_movements.sql',
      '0004_financial_obligations.sql','0005_internal_transfers.sql','0006_cancellations_refunds.sql', '0007_credit_cards_installments.sql', '0008_card_invoice_payments.sql',
    ])this.raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
    this.queue=Promise.resolve();
  }
  prepare(sql){return new Statement(this.raw,sql);}
  batch(items){
    const task=async()=>{this.raw.exec('BEGIN IMMEDIATE');try{
      const result=[];for(const item of items)result.push(await item.run());this.raw.exec('COMMIT');return result;
    }catch(cause){this.raw.exec('ROLLBACK');throw cause;}};
    const running=this.queue.then(task);this.queue=running.catch(()=>{});return running;
  }
  close(){this.raw.close();}
}
async function using(fn){const db=new Db();try{return await fn(db);}finally{db.close();}}
const actor=userId=>({userId});
const clock=()=>new Date('2026-11-11T15:00:00.000Z');
const key=x=>'timeline-fixture-'+x.replace(/[^A-Za-z0-9_-]/g,'-');
const cents=parseCents;
const period=(extra={})=>({
  from:'2026-11-01',to:'2026-11-30',asOf:'2026-11-11',...extra,
});
async function wallet(db,owner='alice',suffix='Main'){
  return createAccount(db,actor(owner),{
    idempotencyKey:key('wallet-'+owner+'-'+suffix),name:suffix,kind:'bank',
    funding:{mode:'external',cents:cents('300')},
  },clock);
}
async function bill(db,title,dueOn,owner='alice',amount='100.00'){
  return createObligation(db,actor(owner),{
    idempotencyKey:key('bill-'+owner+'-'+title),title,
    totalCents:cents(amount),dueOn,
  },clock);
}
async function movement(db,a,name,direction,amount='20.00',owner='alice',when='2026-11-10'){
  return postMovement(db,actor(owner),{
    idempotencyKey:key('movement-'+owner+'-'+name),accountId:a.accountId,
    direction,amountCents:cents(amount),method:'pix',description:name,occurredOn:when,
  },clock);
}
test('date validation detects leap years and D-10/D-5 boundaries via civil calendar UTC',()=>{
  for(const value of ['2026-02-29','2026-11-31','2026-13-01','2026-11-11T12:00Z','0010-01-01']){
    assert.throws(()=>validateDate(value),TypeError);
  }
  assert.doesNotThrow(()=>validateDate('2024-02-29'));
  assert.equal(daysBetween('2026-11-11','2026-11-21'),10);
  assert.equal(daysBetween('2026-11-11','2026-11-16'),5);
  assert.equal(daysBetween('2026-11-16','2026-11-11'),-5);
  assert.equal(daysBetween('2024-02-28','2024-03-01'),2);
  assert.equal(daysBetween('2024-02-29','2024-03-01'),1);
});

test('in-app alert window D-10 and D-5 includes exact edges, today and overdue',()=>using(async db=>{
  await bill(db,'Far','2026-11-22');
  await bill(db,'D10','2026-11-21');
  await bill(db,'D6','2026-11-17');
  await bill(db,'D5','2026-11-16');
  await bill(db,'D1','2026-11-12');
  await bill(db,'Today','2026-11-11');
  await bill(db,'Overdue','2026-11-10');
  const result=await listDueAlerts(db,actor('alice'),{asOf:'2026-11-11'});
  assert.deepEqual(new Map(result.alerts.map(x=>[x.title,[x.daysUntil,x.level]])).get('D10'),[10,'D-10']);
  assert.deepEqual(new Map(result.alerts.map(x=>[x.title,[x.daysUntil,x.level]])).get('D6'),[6,'D-10']);
  assert.deepEqual(new Map(result.alerts.map(x=>[x.title,[x.daysUntil,x.level]])).get('D5'),[5,'D-5']);
  assert.deepEqual(new Map(result.alerts.map(x=>[x.title,[x.daysUntil,x.level]])).get('D1'),[1,'D-5']);
  assert.deepEqual(new Map(result.alerts.map(x=>[x.title,[x.daysUntil,x.level]])).get('Today'),[0,'D-5']);
  assert.deepEqual(new Map(result.alerts.map(x=>[x.title,[x.daysUntil,x.level]])).get('Overdue'),[-1,'overdue']);
  assert.equal(result.alerts.some(x=>x.title==='Far'),false);
  assert.equal(result.alerts.length,6);
}));

test('upcoming due alerts precede overdue, with newest missed bills before older ones',()=>using(async db=>{
  await bill(db,'OldLate','2026-09-01');
  await bill(db,'RecentLate','2026-11-10');
  await bill(db,'Now','2026-11-11');
  await bill(db,'Soon','2026-11-13');
  const all=await listDueAlerts(db,actor('alice'),{asOf:'2026-11-11'});
  assert.deepEqual(all.alerts.map(x=>x.title),['Now','Soon','RecentLate','OldLate']);
  const first=await listDueAlerts(db,actor('alice'),{asOf:'2026-11-11',limit:2});
  const second=await listDueAlerts(db,actor('alice'),{asOf:'2026-11-11',limit:2,offset:2});
  assert.equal(first.hasMore,true);assert.equal(second.hasMore,false);
  assert.deepEqual([...first.alerts,...second.alerts].map(x=>x.title),all.alerts.map(x=>x.title));
}));

test('partial settlement reduces warning amount, full settlement removes alert without rewriting cash',()=>using(async db=>{
  const a=await wallet(db);
  const b=await bill(db,'Electricity','2026-11-16');
  await payObligation(db,actor('alice'),{
    idempotencyKey:key('pay-electricity-1'),obligationId:b.obligationId,
    accountId:a.accountId,amountCents:cents('35'),method:'pix',paidOn:'2026-11-11',
  },clock);
  let alerts=await listDueAlerts(db,actor('alice'),{asOf:'2026-11-11'});
  assert.equal(alerts.alerts.length,1);
  assert.equal(alerts.alerts[0].outstandingCents,6500);
  await payObligation(db,actor('alice'),{
    idempotencyKey:key('pay-electricity-2'),obligationId:b.obligationId,
    accountId:a.accountId,amountCents:cents('65'),method:'pix',paidOn:'2026-11-11',
  },clock);
  alerts=await listDueAlerts(db,actor('alice'),{asOf:'2026-11-11'});
  assert.deepEqual(alerts.alerts,[]);
  const chronology=await listTimeline(db,actor('alice'),period());
  assert.equal(chronology.events.filter(x=>x.kind==='payment').length,2);
  assert.equal(chronology.events.filter(x=>x.kind==='obligation').length,0);
}));

test('canceling unpaid obligation removes active due notice and preserves cancel event only',()=>using(async db=>{
  const b=await bill(db,'Canceled','2026-11-16');
  await cancelUnpaidObligation(db,actor('alice'),{
    idempotencyKey:key('cancel-canceled'),obligationId:b.obligationId,
    canceledOn:'2026-11-11',reason:'Desistência',
  },clock);
  assert.deepEqual((await listDueAlerts(db,actor('alice'),{asOf:'2026-11-11'})).alerts,[]);
  const events=(await listTimeline(db,actor('alice'),period())).events;
  assert.deepEqual(events.map(x=>[x.kind,x.status,x.amountCents]),[['cancellation','canceled',0]]);
}));

test('union ledger counts each payment, refund and transfer exactly once, with correct phase',()=>using(async db=>{
  const a=await wallet(db);
  const b=await wallet(db,'alice','Reserve');
  const expense=await movement(db,a,'Groceries','expense','25');
  await movement(db,a,'Work','income','100');
  const obligation=await bill(db,'Internet','2026-11-21');
  const payment=await payObligation(db,actor('alice'),{
    idempotencyKey:key('bill-paid'),obligationId:obligation.obligationId,
    accountId:a.accountId,amountCents:cents('40'),method:'pix',paidOn:'2026-11-11',
  },clock);
  await refundPaidExpense(db,actor('alice'),{
    idempotencyKey:key('return-groceries'),originalMovementId:expense.movementId,
    accountId:a.accountId,amountCents:cents('5'),method:'pix',refundedOn:'2026-11-11',
  },clock);
  await createInternalTransfer(db,actor('alice'),{
    idempotencyKey:key('transfer'),sourceAccountId:a.accountId,targetAccountId:b.accountId,
    amountCents:cents('12'),transferredOn:'2026-11-11',
  },clock);
  const v=await listTimeline(db,actor('alice'),period());
  const dates=v.events.map(x=>x.date);
  assert.deepEqual(dates,[...dates].sort(),'event rail must be chronological');
  const kinds=v.events.map(x=>x.kind).sort();
  assert.deepEqual(kinds,['expense','income','obligation','payment','refund','transfer']);
  assert.equal(v.events.filter(x=>x.id==='movement:'+payment.movementId).length,1);
  assert.equal(v.events.find(x=>x.kind==='obligation').amountCents,6000);
  assert.equal(v.events.find(x=>x.kind==='obligation').status,'planned');
  assert.equal(v.events.find(x=>x.kind==='refund').status,'realized');
  assert.equal(v.events.find(x=>x.kind==='transfer').status,'realized');
  assert.equal(v.events.find(x=>x.kind==='payment').obligationId,obligation.obligationId);
}));

test('status filters distinguish future, today, overdue and realized without speculative cash',()=>using(async db=>{
  await bill(db,'Future','2026-11-21');
  await bill(db,'Today','2026-11-11');
  await bill(db,'Late','2026-11-10');
  const planned=await listTimeline(db,actor('alice'),period({status:'planned'}));
  const pending=await listTimeline(db,actor('alice'),period({status:'pending'}));
  const overdue=await listTimeline(db,actor('alice'),period({status:'overdue'}));
  assert.deepEqual(planned.events.map(x=>x.title),['Future']);
  assert.deepEqual(pending.events.map(x=>x.title),['Today']);
  assert.deepEqual(overdue.events.map(x=>x.title),['Late']);
  assert.deepEqual((await listTimeline(db,actor('alice'),period({status:'realized'}))).events,[]);
}));

test('stable pagination/limit, date bounds and owner isolation work with many events',()=>using(async db=>{
  const a=await wallet(db),b=await wallet(db,'bob');
  for(let i=0;i<9;i++){
    await movement(db,a,'A-'+i,'income','1','alice','2026-11-'+String(10+i).padStart(2,'0'));
  }
  await movement(db,b,'Bob-private','income','999','bob');
  const seen=new Set();
  for(const offset of [0,3,6]){
    const page=await listTimeline(db,actor('alice'),period({offset,limit:3}));
    assert.equal(page.events.length,3);
    assert.equal(page.hasMore,offset<6);
    page.events.forEach(event=>{assert(!seen.has(event.id));seen.add(event.id);});
  }
  assert.equal(seen.size,9);
  assert.equal((await listTimeline(db,actor('bob'),period())).events.length,1);
  assert(!JSON.stringify((await listTimeline(db,actor('alice'),period()))).includes('Bob-private'));
  await assert.rejects(()=>listTimeline(db,actor('alice'),period({limit:101})),TypeError);
  await assert.rejects(()=>listTimeline(db,actor('alice'),period({offset:-1})),TypeError);
  await assert.rejects(()=>listTimeline(db,actor('alice'),period({from:'2026-12-01'})),TypeError);
  await assert.rejects(()=>listTimeline(db,actor('alice'),period({status:'injected'})),TypeError);
  await assert.rejects(()=>listDueAlerts(db,actor('alice'),{asOf:'2026-02-29'}),TypeError);
}));

const base='https://cash.example',time=Date.parse('2026-11-11T12:00:00Z');
const session=async headers=>{
  const id=headers.get('cookie')==='session=alice'?'alice':headers.get('cookie')==='session=bob'?'bob':null;
  return id?{user:{id},session:{userId:id,expiresAt:new Date(time+60000)}}:null;
};
async function call(db,path,cookie){
  const response=await handleFinancialHttp(new Request(base+path,{headers:{cookie,'x-user-id':'bob'}}),db,session,base,()=>time);
  return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};
}
test('HTTP financial timeline and alerts require valid cookie and reject forged filters',()=>using(async db=>{
  const b=await bill(db,'Sensitive','2026-11-16');
  await bill(db,'Other','2026-11-21','bob');
  const query='/api/timeline?from=2026-11-01&to=2026-11-30&asOf=2026-11-11';
  const alerts='/api/alerts?asOf=2026-11-11';
  assert.equal((await call(db,query,'')).status,401);
  assert.equal((await call(db,alerts,'')).status,401);
  const own=await call(db,query,'session=alice');
  assert.equal(own.status,200);assert.equal(own.cache,'no-store');
  assert.equal(own.body.events.length,1);
  assert.equal(own.body.events[0].obligationId,b.obligationId);
  assert.equal((await call(db,alerts,'session=alice')).body.alerts[0].level,'D-5');
  const foreign=await call(db,alerts,'session=bob');
  assert.equal(foreign.body.alerts.length,1);
  assert.equal(foreign.body.alerts[0].title,'Other');
  for(const path of [
    query+'&ownerId=bob',query+'&status=not-valid',query+'&limit=500',
    query+'&asOf=2026-11-10',query.replace('2026-11-11','2026-02-29'),
    alerts+'&ownerId=bob',alerts+'&asOf=2026-11-11',alerts+'&offset=-1',
  ])assert.equal((await call(db,path,'session=alice')).status,400,path);
}));
