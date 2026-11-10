import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAccount, getAccount } from '../src/backend/accounts/accounts.ts';
import { getMovement, listMovements, postMovement } from '../src/backend/movements/movements.ts';
import { createObligation, getObligation, payObligation } from '../src/backend/obligations/obligations.ts';
import {
  cancelUnpaidObligation, getObligationCancellation, refundPaidExpense,
  getExpenseRefund, listExpenseRefunds,
} from '../src/backend/compensations/compensations.ts';
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
    this.raw.exec('PRAGMA foreign_keys=ON');
    for(const file of [
      '0001_financial_accounts.sql','0002_better_auth.sql','0003_cash_movements.sql',
      '0004_financial_obligations.sql','0005_internal_transfers.sql','0006_cancellations_refunds.sql',
    ]) this.raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
    this.queue=Promise.resolve();
  }
  prepare(sql) { return new Statement(this.raw,sql); }
  batch(statements) {
    const exec=async()=>{
      this.raw.exec('BEGIN IMMEDIATE');
      try { const rows=[]; for(const s of statements)rows.push(await s.run());this.raw.exec('COMMIT');return rows; }
      catch(e){this.raw.exec('ROLLBACK');throw e;}
    };
    const op=this.queue.then(exec);this.queue=op.catch(()=>{});return op;
  }
  close(){this.raw.close();}
}
const act=userId=>({userId});
const cents=parseCents;
const key=s=>'compensation-test-'+s;
const clock=()=>new Date('2026-11-10T17:00:00.000Z');
async function withDb(fn){const db=new Database();try{return await fn(db);}finally{db.close();}}
async function wallet(db,owner='alice',name='Banco',initial='300.00') {
  return createAccount(db,act(owner),{
    idempotencyKey:key('wallet-'+owner+'-'+name),name,kind:'bank',
    funding:{mode:'external',cents:cents(initial)},
  },clock);
}
async function expense(db,owner,accountId,name='normal',amount='100.00') {
  return postMovement(db,act(owner),{
    idempotencyKey:key('expense-'+name),accountId,
    direction:'expense',amountCents:cents(amount),method:'pix',
    description:'Compra '+name,occurredOn:'2026-11-09',category:'Compras',
  },clock);
}
async function bill(db,owner='alice',amount='100.00',name='internet') {
  return createObligation(db,act(owner),{
    idempotencyKey:key('bill-'+name),title:'Internet',
    totalCents:cents(amount),dueOn:'2026-11-25',
  },clock);
}
const refund=(movementId,accountId,suffix='refund',amount='30.00',extra={})=>({
  idempotencyKey:key('refund-'+suffix),
  originalMovementId:movementId,accountId,amountCents:cents(amount),
  refundedOn:'2026-11-10',reason:'Devolução parcial',...extra,
});
const cancel=(obligationId,suffix='cancel',extra={})=>({
  idempotencyKey:key('cancel-'+suffix),obligationId,
  canceledOn:'2026-11-10',reason:'Compra desistida',...extra,
});
async function balance(db,user,id){return (await getAccount(db,act(user),id)).balanceCents;}

test('canceling unpaid obligation makes it canceled with zero due and does not credit any cash',()=>withDb(async db=>{
  const a=await wallet(db);
  const b=await bill(db);
  const before=await balance(db,'alice',a.accountId);
  const event=await cancelUnpaidObligation(db,act('alice'),cancel(b.obligationId),clock);
  assert.equal(event.canceledOn,'2026-11-10');
  const after=await getObligation(db,act('alice'),b.obligationId);
  assert.equal(after.state,'canceled');
  assert.equal(after.outstandingCents,0);
  assert.equal(after.paidCents,0);
  assert.equal(after.totalCents,10000);
  assert.equal(after.cancellationReason,'Compra desistida');
  assert.equal(after.canceledOn,'2026-11-10');
  assert.equal(await balance(db,'alice',a.accountId),before);
  assert.deepEqual(await listMovements(db,act('alice')),[]);
  const replay=await cancelUnpaidObligation(db,act('alice'),cancel(b.obligationId),clock);
  assert.equal(replay.cancellationId,event.cancellationId);
  assert.equal((await getObligationCancellation(db,act('alice'),b.obligationId)).cancellationId,event.cancellationId);
  await assert.rejects(()=>payObligation(db,act('alice'),{
    idempotencyKey:key('pay-canceled'),obligationId:b.obligationId,accountId:a.accountId,
    amountCents:cents('1'),method:'pix',paidOn:'2026-11-10',
  },clock));
  assert.equal(await balance(db,'alice',a.accountId),before);
}));

test('cancellation after any payment is rejected even if the payment was fully refunded',()=>withDb(async db=>{
  const a=await wallet(db);
  const b=await bill(db,'alice','25.00','after-pay');
  const p=await payObligation(db,act('alice'),{
    idempotencyKey:key('paid-once'),obligationId:b.obligationId,accountId:a.accountId,
    amountCents:cents('25'),method:'pix',paidOn:'2026-11-09',
  },clock);
  await refundPaidExpense(db,act('alice'),refund(p.movementId,a.accountId,'returned', '25'),clock);
  assert.equal((await getObligation(db,act('alice'),b.obligationId)).outstandingCents,2500);
  await assert.rejects(()=>cancelUnpaidObligation(db,act('alice'),cancel(b.obligationId,'too-late'),clock),/OBLIGATION_HAS_PAYMENTS/);
  assert.equal(await getObligationCancellation(db,act('alice'),b.obligationId),null);
}));

test('generic paid expense refund changes actual cash and shows linked historical compensation',()=>withDb(async db=>{
  const a=await wallet(db);
  const e=await expense(db,'alice',a.accountId);
  assert.equal(await balance(db,'alice',a.accountId),20000);
  const r=await refundPaidExpense(db,act('alice'),refund(e.movementId,a.accountId),clock);
  assert.equal(r.originalMovementId,e.movementId);
  assert.equal(r.accountId,a.accountId);
  assert.equal(r.obligationId,null);
  assert.equal(await balance(db,'alice',a.accountId),23000);
  const history=await listMovements(db,act('alice'));
  const credit=history.find(x=>x.movementId===r.refundMovementId);
  const original=history.find(x=>x.movementId===e.movementId);
  assert.equal(credit.direction,'income');
  assert.equal(credit.eventKind,'refund');
  assert.equal(credit.refundOfMovementId,e.movementId);
  assert.equal(original.eventKind,'ordinary');
  assert.equal(original.refundedCents,3000);
  assert.equal(history.filter(x=>x.eventKind==='ordinary' && x.direction==='income').length,0);
  assert.equal(history.length,2);
}));

test('two partial refunds cannot exceed the original, and replays never credit twice',()=>withDb(async db=>{
  const a=await wallet(db);
  const e=await expense(db,'alice',a.accountId);
  const p=refund(e.movementId,a.accountId,'part-1','35');
  const x=await refundPaidExpense(db,act('alice'),p,clock);
  const y=await refundPaidExpense(db,act('alice'),p,clock);
  assert.equal(x.refundId,y.refundId);
  await refundPaidExpense(db,act('alice'),refund(e.movementId,a.accountId,'part-2','65'),clock);
  assert.equal(await balance(db,'alice',a.accountId),30000);
  assert.equal((await listExpenseRefunds(db,act('alice'),{originalMovementId:e.movementId})).length,2);
  await assert.rejects(()=>refundPaidExpense(db,act('alice'),
    refund(e.movementId,a.accountId,'over','0.01'),clock),/REFUND_EXCEEDS_ORIGINAL/);
  assert.equal((await listMovements(db,act('alice'))).length,3);
  assert.equal(await balance(db,'alice',a.accountId),30000);
  await assert.rejects(()=>refundPaidExpense(db,act('alice'),{...p,amountCents:cents('34')},clock),/Idempotency conflict/);
}));

test('partially refunding a bill payment increases only the net outstanding amount',()=>withDb(async db=>{
  const a=await wallet(db);
  const b=await bill(db);
  const p=await payObligation(db,act('alice'),{
    idempotencyKey:key('bill-paid'),obligationId:b.obligationId,accountId:a.accountId,
    amountCents:cents('80'),method:'pix',paidOn:'2026-11-09',
  },clock);
  assert.equal((await getObligation(db,act('alice'),b.obligationId)).outstandingCents,2000);
  const r=await refundPaidExpense(db,act('alice'),refund(p.movementId,a.accountId,'bill','30'),clock);
  assert.equal(r.obligationId,b.obligationId);
  const changed=await getObligation(db,act('alice'),b.obligationId);
  assert.equal(changed.paidCents,5000);
  assert.equal(changed.outstandingCents,5000);
  assert.equal(changed.state,'partially_paid');
  assert.equal(await balance(db,'alice',a.accountId),25000);
  await payObligation(db,act('alice'),{
    idempotencyKey:key('bill-final'),obligationId:b.obligationId,accountId:a.accountId,
    amountCents:cents('50'),method:'debit',paidOn:'2026-11-10',
  },clock);
  assert.equal((await getObligation(db,act('alice'),b.obligationId)).state,'paid');
  assert.equal(await balance(db,'alice',a.accountId),20000);
}));

test('refund of fully paid bill reopens outstanding amount, not a fictitious income',()=>withDb(async db=>{
  const a=await wallet(db);
  const b=await bill(db,'alice','20','fully');
  const p=await payObligation(db,act('alice'),{
    idempotencyKey:key('fully-paid'),obligationId:b.obligationId,accountId:a.accountId,
    amountCents:cents('20'),method:'pix',paidOn:'2026-11-09',
  },clock);
  assert.equal((await getObligation(db,act('alice'),b.obligationId)).state,'paid');
  await refundPaidExpense(db,act('alice'),refund(p.movementId,a.accountId,'full-reopen','5'),clock);
  const state=await getObligation(db,act('alice'),b.obligationId);
  assert.deepEqual([state.state,state.paidCents,state.outstandingCents],['partially_paid',1500,500]);
}));

test('refund may credit another owned account without changing initial expense or other users',()=>withDb(async db=>{
  const a=await wallet(db),b=await wallet(db,'alice','Savings','0');
  const e=await expense(db,'alice',a.accountId);
  await refundPaidExpense(db,act('alice'),refund(e.movementId,b.accountId,'different','10'),clock);
  assert.equal(await balance(db,'alice',a.accountId),20000);
  assert.equal(await balance(db,'alice',b.accountId),1000);
  assert.equal((await listExpenseRefunds(db,act('alice'))).length,1);
}));

test('foreign expense and foreign credited destination cannot be refunded across owners',()=>withDb(async db=>{
  const a=await wallet(db),b=await wallet(db,'bob');
  const expenseAlice=await expense(db,'alice',a.accountId);
  await assert.rejects(()=>refundPaidExpense(db,act('bob'),
    refund(expenseAlice.movementId,b.accountId,'steal','10'),clock),/unavailable/);
  await assert.rejects(()=>refundPaidExpense(db,act('alice'),
    refund(expenseAlice.movementId,b.accountId,'foreign-credit','10'),clock),/FOREIGN KEY/);
  assert.equal(await balance(db,'alice',a.accountId),20000);
  assert.equal(await balance(db,'bob',b.accountId),30000);
  assert.deepEqual(await listExpenseRefunds(db,act('bob')) ,[]);
}));

test('an ordinary income cannot be refunded as if it were a paid expense',()=>withDb(async db=>{
  const a=await wallet(db);
  const inc=await postMovement(db,act('alice'),{
    idempotencyKey:key('normal-income'),accountId:a.accountId,direction:'income',
    amountCents:cents('9.75'),method:'pix',description:'Salary',occurredOn:'2026-11-09',
  },clock);
  await assert.rejects(()=>refundPaidExpense(db,act('alice'),refund(inc.movementId,a.accountId,'income','3'),clock),/unavailable/);
  assert.equal(await balance(db,'alice',a.accountId),30975);
}));

test('two competing refunds serialize; only one can consume the remaining refundable amount',()=>withDb(async db=>{
  const a=await wallet(db);
  const e=await expense(db,'alice',a.accountId);
  const candidates=await Promise.allSettled([
    refundPaidExpense(db,act('alice'),refund(e.movementId,a.accountId,'race-a','75'),clock),
    refundPaidExpense(db,act('alice'),refund(e.movementId,a.accountId,'race-b','75'),clock),
  ]);
  assert.equal(candidates.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(candidates.filter(x=>x.status==='rejected').length,1);
  assert.equal((await listExpenseRefunds(db,act('alice'))).length,1);
  assert.equal((await listMovements(db,act('alice'))).length,2);
  assert.equal(await balance(db,'alice',a.accountId),27500);
}));

test('concurrent same-key refunds produce one credit with one linked record',()=>withDb(async db=>{
  const a=await wallet(db);
  const e=await expense(db,'alice',a.accountId);
  const input=refund(e.movementId,a.accountId,'same-key','30');
  const [x,y]=await Promise.all([
    refundPaidExpense(db,act('alice'),input,clock),
    refundPaidExpense(db,act('alice'),input,clock),
  ]);
  assert.equal(x.refundId,y.refundId);
  assert.equal((await listExpenseRefunds(db,act('alice'))).length,1);
  assert.equal(await balance(db,'alice',a.accountId),23000);
}));

test('cancellation and payment racing cannot both succeed on an unpaid bill',()=>withDb(async db=>{
  const a=await wallet(db);
  const b=await bill(db,'alice','25','cancel-race');
  const results=await Promise.allSettled([
    cancelUnpaidObligation(db,act('alice'),cancel(b.obligationId,'race'),clock),
    payObligation(db,act('alice'),{
      idempotencyKey:key('pay-race'),obligationId:b.obligationId,accountId:a.accountId,
      amountCents:cents('25'),method:'pix',paidOn:'2026-11-10',
    },clock),
  ]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected').length,1);
  const current=await getObligation(db,act('alice'),b.obligationId);
  assert(['canceled','paid'].includes(current.state));
  assert.equal((await listMovements(db,act('alice'))).length,current.state==='paid'?1:0);
}));

test('invalid dates, cents, reasons, keys and refunds before original expense are rejected',()=>withDb(async db=>{
  const a=await wallet(db),b=await bill(db);
  for(const d of ['2026-02-29','2026-04-31','2026-00-01','2026-11-10T18:00Z']){
    await assert.rejects(()=>cancelUnpaidObligation(db,act('alice'),cancel(b.obligationId,'bad-date',{canceledOn:d}),clock));
  }
  const e=await expense(db,'alice',a.accountId);
  for(const amount of [0,-1,1.2,Number.MAX_SAFE_INTEGER]){
    await assert.rejects(()=>refundPaidExpense(db,act('alice'),{
      ...refund(e.movementId,a.accountId),amountCents:amount,
    },clock));
  }
  for(const d of ['2026-02-29','2026-11-08']){
    await assert.rejects(()=>refundPaidExpense(db,act('alice'),{
      ...refund(e.movementId,a.accountId),refundedOn:d,
    },clock));
  }
  await assert.rejects(()=>refundPaidExpense(db,act('alice'),{...refund(e.movementId,a.accountId),idempotencyKey:'short'},clock));
  await assert.rejects(()=>refundPaidExpense(db,act('alice'),{...refund(e.movementId,a.accountId),reason:'abc\nnew'},clock));
  assert.deepEqual(await listExpenseRefunds(db,act('alice')),[]);
}));

test('raw SQL cannot forge refund from an income, wrong amount, or exceed the original',()=>withDb(async db=>{
  const a=await wallet(db);
  const e=await expense(db,'alice',a.accountId,'raw','10');
  const createCredit=(tag,amount,method='income')=>{
    const id=crypto.randomUUID(), k=key('raw-'+tag);
    db.raw.prepare('INSERT INTO posted_cash_movements (owner_user_id,movement_id,creation_key,account_id,direction,amount_cents,payment_method,description,source_label,category,occurred_on,created_at) VALUES (?,?,?,?,?,? ,?, ?,NULL,NULL,?,?)')
      .run('alice',id,'cash-refund:'+k,a.accountId,method,amount,'pix','Raw','2026-11-10',clock().toISOString());
    return {id,key:k};
  };
  const direct=(credit,original,amount,tag)=>db.raw.prepare(
    'INSERT INTO cash_refunds (owner_user_id,refund_id,creation_key,original_movement_id,refund_movement_id,amount_cents,refunded_on,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('alice',crypto.randomUUID(),credit.key,original,credit.id,amount,'2026-11-10',null,clock().toISOString());
  const credit=createCredit('wrong-amount',500);
  assert.throws(()=>direct(credit,e.movementId,501,'wrong'),/REFUND_MOVEMENT_MISMATCH/);
  const credit2=createCredit('over-amount',2000);
  assert.throws(()=>direct(credit2,e.movementId,2000,'over'),/REFUND_EXCEEDS_ORIGINAL/);
  const credit3=createCredit('expense-credit',500,'expense');
  assert.throws(()=>direct(credit3,e.movementId,500,'expense'),/REFUND_MOVEMENT_MISMATCH/);
  const income=await postMovement(db,act('alice'),{
    idempotencyKey:key('salary'),accountId:a.accountId,direction:'income',amountCents:cents('5'),
    method:'pix',description:'Salary',occurredOn:'2026-11-09',
  },clock);
  const credit4=createCredit('original-income',500);
  assert.throws(()=>direct(credit4,income.movementId,500,'original-income'),/REFUND_MOVEMENT_MISMATCH/);
}));

test('compensations and original cash movement are append-only and cannot be rewritten',()=>withDb(async db=>{
  const a=await wallet(db);
  const e=await expense(db,'alice',a.accountId);
  const r=await refundPaidExpense(db,act('alice'),refund(e.movementId,a.accountId),clock);
  const b=await bill(db);
  const c=await cancelUnpaidObligation(db,act('alice'),cancel(b.obligationId),clock);
  assert.throws(()=>db.raw.prepare('UPDATE posted_cash_movements SET amount_cents=1 WHERE movement_id=?').run(e.movementId),/MOVEMENT_IMMUTABLE/);
  assert.throws(()=>db.raw.prepare('DELETE FROM posted_cash_movements WHERE movement_id=?').run(r.refundMovementId),/MOVEMENT_IMMUTABLE/);
  assert.throws(()=>db.raw.prepare('DELETE FROM cash_refunds WHERE refund_id=?').run(r.refundId),/REFUND_IMMUTABLE/);
  assert.throws(()=>db.raw.prepare('UPDATE obligation_cancellations SET reason=? WHERE cancellation_id=?').run('Changed',c.cancellationId),/CANCELLATION_IMMUTABLE/);
}));

const base='https://cash.example',now=Date.parse('2026-11-10T16:00:00Z');
const resolve=async h=>{
  const id=h.get('cookie')==='session=alice'?'alice':h.get('cookie')==='session=bob'?'bob':null;
  return id?{user:{id},session:{userId:id,expiresAt:new Date(now+60000)}}:null;
};
function http(path,cookie,body,origin=base){
  return new Request(base+path,{
    method:body===undefined?'GET':'POST',
    headers:{cookie,origin,'content-type':'application/json','x-user-id':'bob'},
    body:body===undefined?undefined:JSON.stringify(body),
  });
}
async function call(db,req){
  const r=await handleFinancialHttp(req,db,resolve,base,()=>now);
  return {status:r.status,body:await r.json()};
}
const postAccount=(name,keyName)=>({
  idempotencyKey:key(keyName),name,kind:'bank',funding:{mode:'external',amount:'200.00'},
});
const postExpense=id=>({
  idempotencyKey:key('http-expense'),accountId:id,
  direction:'expense',amount:'50.00',method:'pix',
  description:'Compra',occurredOn:'2026-11-09',
});
test('HTTP: authenticated refund history linked to expense; forged owner blocked',()=>withDb(async db=>{
  assert.equal((await call(db,http('/api/refunds','',{}))).status,401);
  const a=(await call(db,http('/api/accounts','session=alice',postAccount('A','http-account')))).body.account;
  const e=await call(db,http('/api/movements','session=alice',postExpense(a.accountId)));
  assert.equal(e.status,201);
  const body={
    idempotencyKey:key('http-refund'),originalMovementId:e.body.movement.movementId,
    accountId:a.accountId,amount:'20.00',refundedOn:'2026-11-10',
    reason:'Devolvido',ownerId:'bob',
  };
  const refund=await call(db,http('/api/refunds','session=alice',body));
  assert.equal(refund.status,201);
  assert.equal(refund.body.refund.amountCents,2000);
  const again=await call(db,http('/api/refunds','session=alice',body));
  assert.equal(again.body.refund.refundId,refund.body.refund.refundId);
  assert.equal((await call(db,http('/api/refunds','session=bob'))).body.refunds.length,0);
  assert.equal((await call(db,http('/api/refunds/'+refund.body.refund.refundId,'session=bob'))).status,404);
  const mov=(await call(db,http('/api/movements','session=alice'))).body.movements;
  assert.equal(mov.length,2);
  assert.equal(mov.filter(x=>x.eventKind==='refund').length,1);
  assert.equal((await call(db,http('/api/accounts/'+a.accountId,'session=alice'))).body.account.balanceCents,17000);
}));

test('HTTP: cancel unpaid bill without any cash event; reject cross-origin and duplicate mutation',()=>withDb(async db=>{
  const b=await call(db,http('/api/obligations','session=alice',{
    idempotencyKey:key('http-bill'),title:'Internet',amount:'100.00',dueOn:'2026-11-25',
  }));
  assert.equal(b.status,201);
  const path='/api/obligations/'+b.body.obligation.obligationId+'/cancel';
  const body={idempotencyKey:key('http-cancel'),canceledOn:'2026-11-10',reason:'Desistência'};
  assert.equal((await call(db,http(path,'session=alice',body,'https://evil.example'))).status,403);
  assert.equal((await call(db,http(path,'session=bob',body))).status,409);
  const x=await call(db,http(path,'session=alice',body));
  assert.equal(x.status,201);
  const y=await call(db,http(path,'session=alice',body));
  assert.equal(y.body.cancellation.cancellationId,x.body.cancellation.cancellationId);
  const state=(await call(db,http('/api/obligations/'+b.body.obligation.obligationId,'session=alice'))).body.obligation;
  assert.equal(state.state,'canceled');
  assert.equal(state.outstandingCents,0);
  assert.deepEqual((await call(db,http('/api/movements','session=alice'))).body.movements,[]);
}));
