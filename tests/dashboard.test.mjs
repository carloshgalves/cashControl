import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { getDashboard } from '../src/backend/dashboard/dashboard.ts';
import { createAccount } from '../src/backend/accounts/accounts.ts';
import { postMovement } from '../src/backend/movements/movements.ts';
import { createObligation, payObligation, getObligation } from '../src/backend/obligations/obligations.ts';
import { cancelUnpaidObligation, refundPaidExpense } from '../src/backend/compensations/compensations.ts';
import { createInternalTransfer } from '../src/backend/transfers/transfers.ts';
import { parseCents } from '../src/domain/money.ts';
import { handleFinancialHttp } from '../src/backend/http/accounts-handler.ts';

class Statement {
  constructor(db, sql, args=[]) { this.db=db; this.sql=sql; this.args=args; }
  bind(...args) { return new Statement(this.db,this.sql,args); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return {results:this.db.prepare(this.sql).all(...this.args)}; }
  async run() { return this.db.prepare(this.sql).run(...this.args); }
}
class Database {
  constructor() {
    this.raw=new DatabaseSync(':memory:');
    this.raw.exec('PRAGMA foreign_keys = ON');
    for(const name of [
      '0001_financial_accounts.sql','0002_better_auth.sql',
      '0003_cash_movements.sql','0004_financial_obligations.sql',
      '0005_internal_transfers.sql','0006_cancellations_refunds.sql',
    ]) this.raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
    this.queue=Promise.resolve();
  }
  prepare(sql) { return new Statement(this.raw,sql); }
  batch(statements) {
    const task=async()=>{
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const result=[];
        for(const statement of statements) result.push(await statement.run());
        this.raw.exec('COMMIT');
        return result;
      }catch(e){this.raw.exec('ROLLBACK');throw e;}
    };
    const x=this.queue.then(task);this.queue=x.catch(()=>{});return x;
  }
  close(){this.raw.close();}
}
const cents=parseCents;
const actor=userId=>({userId});
const clock=()=>new Date('2026-11-10T19:00:00.000Z');
const key=label=>'dashboard-fixture-'+label.replace(/[^A-Za-z0-9_-]/g,'-');
const p=(from='2026-11-01',to='2026-11-30')=>({from,to});
async function withDb(fn){const db=new Database();try{return await fn(db);}finally{db.close();}}
async function wallet(db,owner='alice',label='Main',amount='100.00'){
  return createAccount(db,actor(owner),{
    idempotencyKey:key('wallet-'+owner+'-'+label),name:label,kind:'bank',
    funding:{mode:'external',cents:cents(amount)},
  },clock);
}
async function movement(db,accountId,label,direction,amount,when='2026-11-10',owner='alice'){
  return postMovement(db,actor(owner),{
    idempotencyKey:key('movement-'+label),accountId,direction,
    amountCents:cents(amount),method:'pix',description:label,occurredOn:when,
  },clock);
}
async function obligation(db,label,amount,due='2026-11-25',owner='alice'){
  return createObligation(db,actor(owner),{
    idempotencyKey:key('obligation-'+label+'-'+owner),
    title:label,totalCents:cents(amount),dueOn:due,
  },clock);
}

test('empty dashboard does not invent accounts, money, commitments or projected income',()=>withDb(async db=>{
  const view=await getDashboard(db,actor('alice'),p());
  assert.equal(view.balances.totalCents,0);
  assert.deepEqual(view.balances.accounts,[]);
  assert.deepEqual([view.cashFlow.incomeCents,view.cashFlow.expensesCents,
    view.cashFlow.refundsCents,view.cashFlow.netCents],[0,0,0,0]);
  assert.deepEqual([view.obligations.openCount,view.obligations.outstandingCents,
    view.obligations.dueInPeriodCount,view.obligations.dueInPeriodCents],[0,0,0,0]);
  assert.equal(view.expectations.status,'not_implemented');
  assert.equal(view.balances.basis,'current');
}));

test('opening balance is current cash but never counted as earned income',()=>withDb(async db=>{
  await wallet(db,'alice','General','123.45');
  const v=await getDashboard(db,actor('alice'),p());
  assert.equal(v.balances.totalCents,12345);
  assert.equal(v.balances.accounts.length,1);
  assert.equal(v.balances.accounts[0].balanceCents,12345);
  assert.equal(v.cashFlow.incomeCents,0);
  assert.equal(v.cashFlow.netCents,0);
}));

test('exact receipts and paid expenses reconcile with actual balances and period range',()=>withDb(async db=>{
  const a=await wallet(db,'alice','General','100.05');
  await movement(db,a.accountId,'income-nov','income','31.02','2026-11-10');
  await movement(db,a.accountId,'expense-nov','expense','14.01','2026-11-20');
  await movement(db,a.accountId,'income-oct','income','4.00','2026-10-31');
  let v=await getDashboard(db,actor('alice'),p());
  assert.equal(v.cashFlow.incomeCents,3102);
  assert.equal(v.cashFlow.expensesCents,1401);
  assert.equal(v.cashFlow.refundsCents,0);
  assert.equal(v.cashFlow.netCents,1701);
  assert.equal(v.balances.totalCents,12106);
  v=await getDashboard(db,actor('alice'),p('2026-10-01','2026-10-31'));
  assert.equal(v.cashFlow.incomeCents,400);
  assert.equal(v.cashFlow.expensesCents,0);
  assert.equal(v.balances.totalCents,12106,'period selection cannot change current balance');
}));

test('internal transfer preserves consolidated cash and is never period income/expense',()=>withDb(async db=>{
  const a=await wallet(db,'alice','Bank','100.00');
  const b=await wallet(db,'alice','Cash','0');
  await createInternalTransfer(db,actor('alice'),{
    idempotencyKey:key('transfer-01'),sourceAccountId:a.accountId,targetAccountId:b.accountId,
    amountCents:cents('27.55'),transferredOn:'2026-11-12',
  },clock);
  const v=await getDashboard(db,actor('alice'),p());
  assert.equal(v.balances.totalCents,10000);
  const byName=Object.fromEntries(v.balances.accounts.map(a=>[a.name,a.balanceCents]));
  assert.deepEqual(byName,{Bank:7245,Cash:2755});
  assert.deepEqual([v.cashFlow.incomeCents,v.cashFlow.expensesCents,v.cashFlow.netCents],[0,0,0]);
}));

test('unpaid bills stay out of cash, while current outstanding and due-in-period match',()=>withDb(async db=>{
  await wallet(db);
  await obligation(db,'November internet','70','2026-11-25');
  await obligation(db,'December service','30','2026-12-06');
  const v=await getDashboard(db,actor('alice'),p());
  assert.equal(v.balances.totalCents,10000);
  assert.equal(v.cashFlow.expensesCents,0);
  assert.equal(v.obligations.outstandingCents,10000);
  assert.equal(v.obligations.openCount,2);
  assert.equal(v.obligations.dueInPeriodCents,7000);
  assert.equal(v.obligations.dueInPeriodCount,1);
}));

test('bill settlement counts one cash expense and decreases open obligations',()=>withDb(async db=>{
  const account=await wallet(db,'alice','Main','100.00');
  const b=await obligation(db,'Paid bill','80');
  await payObligation(db,actor('alice'),{
    idempotencyKey:key('partial-pay'),obligationId:b.obligationId,accountId:account.accountId,
    amountCents:cents('30'),method:'debit',paidOn:'2026-11-11',
  },clock);
  const v=await getDashboard(db,actor('alice'),p());
  assert.equal(v.balances.totalCents,7000);
  assert.equal(v.cashFlow.expensesCents,3000);
  assert.equal(v.cashFlow.netCents,-3000);
  assert.equal(v.obligations.outstandingCents,5000);
  assert.equal(v.obligations.openCount,1);
  assert.equal(v.obligations.dueInPeriodCents,5000);
}));

test('partial refunded expense credits cash without becoming another wage/income',()=>withDb(async db=>{
  const account=await wallet(db,'alice','Main','200.00');
  const original=await movement(db,account.accountId,'groceries','expense','40','2026-11-09');
  await refundPaidExpense(db,actor('alice'),{
    idempotencyKey:key('cash-refund'),originalMovementId:original.movementId,
    accountId:account.accountId,amountCents:cents('12.05'),method:'bank_transfer',
    refundedOn:'2026-11-10',
  },clock);
  const v=await getDashboard(db,actor('alice'),p());
  assert.equal(v.cashFlow.incomeCents,0);
  assert.equal(v.cashFlow.expensesCents,4000);
  assert.equal(v.cashFlow.refundsCents,1205);
  assert.equal(v.cashFlow.netCents,-2795);
  assert.equal(v.balances.totalCents,17205);
}));

test('reimbursement dated in another period changes only that period cash flow, never invents income',()=>withDb(async db=>{
  const account=await wallet(db,'alice','Main','200.00');
  const original=await movement(db,account.accountId,'old-expense','expense','50','2026-10-20');
  await refundPaidExpense(db,actor('alice'),{
    idempotencyKey:key('nov-refund'),originalMovementId:original.movementId,
    accountId:account.accountId,amountCents:cents('30'),method:'pix',
    refundedOn:'2026-11-10',
  },clock);
  const nov=await getDashboard(db,actor('alice'),p());
  const oct=await getDashboard(db,actor('alice'),p('2026-10-01','2026-10-31'));
  assert.deepEqual([nov.cashFlow.incomeCents,nov.cashFlow.expensesCents,nov.cashFlow.refundsCents,nov.cashFlow.netCents],[0,0,3000,3000]);
  assert.deepEqual([oct.cashFlow.incomeCents,oct.cashFlow.expensesCents,oct.cashFlow.refundsCents,oct.cashFlow.netCents],[0,5000,0,-5000]);
  assert.equal(nov.balances.totalCents,18000);
  assert.equal(oct.balances.totalCents,18000);
}));

test('refund of a bill payment restores pending amount; canceled bills disappear from open total',()=>withDb(async db=>{
  const account=await wallet(db,'alice','Main','200.00');
  const b=await obligation(db,'Refunded bill','100');
  const canceled=await obligation(db,'Canceled future bill','25');
  await cancelUnpaidObligation(db,actor('alice'),{
    idempotencyKey:key('cancel-1'),obligationId:canceled.obligationId,canceledOn:'2026-11-10',
  },clock);
  const paid=await payObligation(db,actor('alice'),{
    idempotencyKey:key('pay-refund-bill'),obligationId:b.obligationId,
    accountId:account.accountId,amountCents:cents('80'),
    method:'pix',paidOn:'2026-11-09',
  },clock);
  await refundPaidExpense(db,actor('alice'),{
    idempotencyKey:key('refund-bill'),originalMovementId:paid.movementId,
    accountId:account.accountId,amountCents:cents('30'),method:'pix',
    refundedOn:'2026-11-10',
  },clock);
  const v=await getDashboard(db,actor('alice'),p());
  const current=await getObligation(db,actor('alice'),b.obligationId);
  assert.equal(current.outstandingCents,5000);
  assert.equal(v.obligations.outstandingCents,5000);
  assert.equal(v.obligations.openCount,1);
  assert.equal(v.obligations.dueInPeriodCents,5000);
  assert.equal(v.cashFlow.refundsCents,3000);
  assert.equal(v.cashFlow.expensesCents,8000);
  assert.equal(v.balances.totalCents,15000);
}));

test('historically negative account balance remains signed, not coerced or hidden',()=>withDb(async db=>{
  const a=await wallet(db,'alice','Main','0');
  await movement(db,a.accountId,'expense-after-overdraft','expense','12.10');
  const v=await getDashboard(db,actor('alice'),p());
  assert.equal(v.balances.totalCents,-1210);
  assert.equal(v.balances.accounts[0].balanceCents,-1210);
  assert.equal(v.cashFlow.netCents,-1210);
}));

test('separate principals receive only own accounts, movements and obligation amounts',()=>withDb(async db=>{
  const a=await wallet(db,'alice','A','200');
  const b=await wallet(db,'bob','B','75');
  await movement(db,a.accountId,'alice-salary','income','40');
  await movement(db,b.accountId,'bob-expense','expense','4','2026-11-10','bob');
  await obligation(db,'A bill','99','2026-11-25','alice');
  await obligation(db,'B bill','11','2026-11-29','bob');
  const alice=await getDashboard(db,actor('alice'),p());
  const bob=await getDashboard(db,actor('bob'),p());
  assert.equal(alice.balances.totalCents,24000);
  assert.equal(alice.cashFlow.incomeCents,4000);
  assert.equal(alice.cashFlow.expensesCents,0);
  assert.equal(alice.obligations.outstandingCents,9900);
  assert.deepEqual(alice.balances.accounts.map(x=>x.name),['A']);
  assert.equal(bob.balances.totalCents,7100);
  assert.equal(bob.cashFlow.incomeCents,0);
  assert.equal(bob.cashFlow.expensesCents,400);
  assert.equal(bob.obligations.outstandingCents,1100);
  assert.deepEqual(bob.balances.accounts.map(x=>x.name),['B']);
}));

test('reject invalid calendar ranges, missing or reversed dates without database access',()=>withDb(async db=>{
  const bad=[['2026-02-29','2026-11-30'],['2026-11-01','2026-11-31'],
    ['2026-12-01','2026-11-30'],['2026-00-01','2026-11-30'],
    ['2026-11-01T00:00:00Z','2026-11-30'],['2026-11-01',''],
  ];
  for(const [from,to] of bad) await assert.rejects(()=>getDashboard(db,actor('alice'),{from,to}),TypeError);
  const leap=await getDashboard(db,actor('alice'),p('2024-02-29','2024-02-29'));
  assert.equal(leap.period.to,'2024-02-29');
}));

test('dashboard retrieval runs exactly one SQL statement for coherent snapshot',()=>withDb(async db=>{
  await wallet(db);
  let queries=0;
  const adapter={prepare(sql){queries++;return db.prepare(sql);},batch(stmts){return db.batch(stmts);}};
  const result=await getDashboard(adapter,actor('alice'),p());
  assert.equal(result.balances.totalCents,10000);
  assert.equal(queries,1);
}));

test('reject unsafe aggregate cents rather than silently rounding monetary totals',async()=>{
  const impossible={
    income_cents:Number.MAX_SAFE_INTEGER+1,expense_cents:0,refund_cents:0,
    outstanding_cents:0,open_count:0,due_in_period_cents:0,due_in_period_count:0,
    account_id:null,display_name:null,kind:null,currency:null,balance_cents:null,
  };
  const db={prepare(){return{bind(){return{all:async()=>({results:[impossible]})}}}}};
  await assert.rejects(()=>getDashboard(db,actor('alice'),p()),RangeError);
});

const origin='https://cash.example', epoch=Date.parse('2026-11-10T19:00:00.000Z');
const session=async h=>{
  const who=h.get('cookie')==='session=alice'?'alice':h.get('cookie')==='session=bob'?'bob':null;
  return who?{user:{id:who},session:{userId:who,expiresAt:new Date(epoch+60000)}}:null;
};
const http=(path,cookie)=>new Request(origin+path,{headers:{cookie,'x-user-id':'alice'}});
async function call(db,req){
  const r=await handleFinancialHttp(req,db,session,origin,()=>epoch);
  return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};
}
test('HTTP dashboard validates period, owner session, no-store and cross-user privacy',()=>withDb(async db=>{
  await wallet(db,'alice','Sensitive','131.32');
  await wallet(db,'bob','Other','7.01');
  const path='/api/dashboard?from=2026-11-01&to=2026-11-30';
  assert.equal((await call(db,http(path,''))).status,401);
  assert.equal((await call(db,http('/api/dashboard?from=2026-11-01','session=alice'))).status,400);
  assert.equal((await call(db,http('/api/dashboard?from=2026-11-01&to=2026-02-30','session=alice'))).status,400);
  assert.equal((await call(db,http('/api/dashboard?from=2026-11-01&from=2026-10-01&to=2026-11-30','session=alice'))).status,400);
  const alice=await call(db,http(path+'&ownerId=bob','session=alice'));
  assert.equal(alice.status,200);
  assert.equal(alice.cache,'no-store');
  assert.equal(alice.body.dashboard.balances.totalCents,13132);
  assert.deepEqual(alice.body.dashboard.balances.accounts.map(a=>a.name),['Sensitive']);
  const bob=await call(db,http(path,'session=bob'));
  assert.equal(bob.body.dashboard.balances.totalCents,701);
  assert.deepEqual(bob.body.dashboard.balances.accounts.map(a=>a.name),['Other']);
  assert(!JSON.stringify(bob.body).includes('Sensitive'));
}));
