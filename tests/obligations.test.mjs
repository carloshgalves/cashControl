import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAccount, getAccount } from '../src/backend/accounts/accounts.ts';
import { listMovements } from '../src/backend/movements/movements.ts';
import {
  createObligation, getObligation, listObligations,
  payObligation, getObligationPayment, listObligationPayments,
} from '../src/backend/obligations/obligations.ts';
import { parseCents } from '../src/domain/money.ts';
import { handleFinancialHttp } from '../src/backend/http/accounts-handler.ts';

class Statement {
  constructor(db, sql, args=[]) { this.db=db; this.sql=sql; this.args=args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return {results: this.db.prepare(this.sql).all(...this.args)}; }
  async run() { return this.db.prepare(this.sql).run(...this.args); }
}
class Database {
  constructor() {
    this.raw=new DatabaseSync(':memory:');
    this.raw.exec('PRAGMA foreign_keys=ON');
    for (const file of [
      '0001_financial_accounts.sql', '0002_better_auth.sql',
      '0003_cash_movements.sql', '0004_financial_obligations.sql',
    ]) this.raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
    this.queue=Promise.resolve();
  }
  prepare(sql) {return new Statement(this.raw,sql);}
  batch(statements) {
    const transaction=async()=>{
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const results=[];
        for(const statement of statements)results.push(await statement.run());
        this.raw.exec('COMMIT');
        return results;
      } catch(err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    };
    const op=this.queue.then(transaction);
    this.queue=op.catch(()=>{});
    return op;
  }
  close(){this.raw.close();}
}
const who = userId => ({userId});
const cents = parseCents;
const key = name => 'bill-test-key-'+name;
const now = () => new Date('2026-11-10T16:00:00Z');
async function wallet(db, owner='alice', opening='1200.00') {
  return createAccount(db,who(owner),{
    idempotencyKey:key('wallet-'+owner),
    name:'Carteira '+owner,kind:'general',
    funding:{mode:'external',cents:cents(opening)},
  },now);
}
const bill = (name='electric', overrides={}) => ({
  idempotencyKey:key('obligation-'+name), title:'Conta de energia',
  totalCents:cents('1000.00'),dueOn:'2026-11-25',category:'Serviços',
  ...overrides,
});
const payment = (obligationId, accountId, name='first', overrides={}) => ({
  idempotencyKey:key('payment-'+name),
  obligationId,accountId,amountCents:cents('300.00'),
  method:'pix',paidOn:'2026-11-10',...overrides,
});
const withDB = async fn => {
  const db=new Database();
  try{return await fn(db);}finally{db.close();}
};

test('creating an unpaid obligation does not move cash, and state begins open',()=>withDB(async db=>{
  const account=await wallet(db);
  const initial=(await getAccount(db,who('alice'),account.accountId)).balanceCents;
  const created=await createObligation(db,who('alice'),bill(),now);
  assert.equal(created.totalCents,100000);
  assert.equal(created.paidCents,0);
  assert.equal(created.outstandingCents,100000);
  assert.equal(created.state,'open');
  assert.equal(created.dueOn,'2026-11-25');
  assert.equal((await getAccount(db,who('alice'),account.accountId)).balanceCents,initial);
  assert.deepEqual(await listMovements(db,who('alice')),[]);
  assert.equal((await listObligations(db,who('alice'))).length,1);
}));

test('partial settlement debits only paid cash, full settlement closes balance without duplicate expense',()=>withDB(async db=>{
  const account=await wallet(db);
  const obligation=await createObligation(db,who('alice'),bill(),now);
  const first=await payObligation(db,who('alice'),payment(obligation.obligationId,account.accountId,'partial'),now);
  assert.equal(first.amountCents,30000);
  let pending=await getObligation(db,who('alice'),obligation.obligationId);
  assert.deepEqual([pending.paidCents,pending.outstandingCents,pending.state],[30000,70000,'partially_paid']);
  assert.equal((await getAccount(db,who('alice'),account.accountId)).balanceCents,90000);
  assert.equal((await listMovements(db,who('alice'))).length,1);
  const final=await payObligation(db,who('alice'),payment(obligation.obligationId,account.accountId,'final',{
    amountCents:cents('700.00'),method:'debit',
  }),now);
  assert.notEqual(first.paymentId,final.paymentId);
  pending=await getObligation(db,who('alice'),obligation.obligationId);
  assert.deepEqual([pending.paidCents,pending.outstandingCents,pending.state],[100000,0,'paid']);
  assert.equal((await getAccount(db,who('alice'),account.accountId)).balanceCents,20000);
  const movements=await listMovements(db,who('alice'));
  assert.equal(movements.length,2);
  assert.equal(movements.reduce((sum,m)=>sum+(m.direction==='expense'?m.amountCents:0),0),100000);
  const payments=await listObligationPayments(db,who('alice'),obligation.obligationId);
  assert.equal(payments.length,2);
  assert.deepEqual(payments.map(p=>p.amountCents).sort((a,b)=>a-b),[30000,70000]);
}));

test('overpayment is rejected and its cash movement is rolled back atomically',()=>withDB(async db=>{
  const account=await wallet(db);
  const b=await createObligation(db,who('alice'),bill('small',{totalCents:cents('45.00')}),now);
  await assert.rejects(()=>payObligation(db,who('alice'),payment(b.obligationId,account.accountId,'too-much',{amountCents:cents('45.01')}),now));
  assert.equal((await listMovements(db,who('alice'))).length,0);
  assert.equal((await getAccount(db,who('alice'),account.accountId)).balanceCents,120000);
  assert.equal((await getObligation(db,who('alice'),b.obligationId)).outstandingCents,4500);
  await payObligation(db,who('alice'),payment(b.obligationId,account.accountId,'exact',{amountCents:cents('45.00')}),now);
  await assert.rejects(()=>payObligation(db,who('alice'),payment(b.obligationId,account.accountId,'already-paid',{amountCents:cents('0.01')}),now));
  assert.equal((await listMovements(db,who('alice'))).length,1);
}));

test('missing or foreign account rolls back settlement and does not change obligation',()=>withDB(async db=>{
  const own=await wallet(db),foreign=await wallet(db,'bob');
  const b=await createObligation(db,who('alice'),bill(),now);
  await assert.rejects(()=>payObligation(db,who('alice'),payment(b.obligationId,foreign.accountId,'foreign-account'),now),/FOREIGN KEY/);
  await assert.rejects(()=>payObligation(db,who('alice'),payment(b.obligationId,'11111111-1111-1111-1111-111111111111','nonexistent-account'),now));
  assert.equal((await listMovements(db,who('alice'))).length,0);
  assert.equal((await getObligation(db,who('alice'),b.obligationId)).outstandingCents,100000);
  assert.equal((await getAccount(db,who('alice'),own.accountId)).balanceCents,120000);
}));

test('cross-user obligation ID is hidden on read and cannot be settled by another principal',()=>withDB(async db=>{
  const a=await wallet(db),b=await wallet(db,'bob');
  const billA=await createObligation(db,who('alice'),bill(),now);
  assert.equal(await getObligation(db,who('bob'),billA.obligationId),null);
  assert.deepEqual(await listObligations(db,who('bob')),[]);
  assert.deepEqual(await listObligationPayments(db,who('bob'),billA.obligationId),[]);
  await assert.rejects(()=>payObligation(db,who('bob'),payment(billA.obligationId,b.accountId,'forbidden'),now),/unavailable/);
  assert.equal((await getAccount(db,who('alice'),a.accountId)).balanceCents,120000);
  assert.equal((await getAccount(db,who('bob'),b.accountId)).balanceCents,120000);
}));

test('identical payment retries return the same payment even after the bill is paid',()=>withDB(async db=>{
  const account=await wallet(db);
  const b=await createObligation(db,who('alice'),bill('once',{totalCents:cents('300.00')}),now);
  const input=payment(b.obligationId,account.accountId,'one-pay');
  const p=await payObligation(db,who('alice'),input,now);
  const same=await payObligation(db,who('alice'),input,now);
  assert.equal(same.paymentId,p.paymentId);
  assert.equal(same.movementId,p.movementId);
  assert.equal((await listMovements(db,who('alice'))).length,1);
  assert.equal((await getObligation(db,who('alice'),b.obligationId)).state,'paid');
  await assert.rejects(()=>payObligation(db,who('alice'),{...input,amountCents:cents('200.00')},now),/Idempotency conflict/);
}));

test('same-key simultaneous payments commit only one expense',()=>withDB(async db=>{
  const account=await wallet(db);
  const b=await createObligation(db,who('alice'),bill('race',{totalCents:cents('300.00')}),now);
  const input=payment(b.obligationId,account.accountId,'same-race');
  const [x,y]=await Promise.all([payObligation(db,who('alice'),input,now),payObligation(db,who('alice'),input,now)]);
  assert.equal(x.paymentId,y.paymentId);
  assert.equal((await listObligationPayments(db,who('alice'),b.obligationId)).length,1);
  assert.equal((await listMovements(db,who('alice'))).length,1);
}));

test('two different concurrent payments cannot settle beyond outstanding balance',()=>withDB(async db=>{
  const account=await wallet(db);
  const b=await createObligation(db,who('alice'),bill('race-distinct',{totalCents:cents('100.00')}),now);
  const attempts=await Promise.allSettled([
    payObligation(db,who('alice'),payment(b.obligationId,account.accountId,'r1',{amountCents:cents('75.00')}),now),
    payObligation(db,who('alice'),payment(b.obligationId,account.accountId,'r2',{amountCents:cents('75.00')}),now),
  ]);
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(attempts.filter(r=>r.status==='rejected').length,1);
  assert.equal((await getObligation(db,who('alice'),b.obligationId)).outstandingCents,2500);
  assert.equal((await listMovements(db,who('alice'))).length,1);
  assert.equal((await getAccount(db,who('alice'),account.accountId)).balanceCents,112500);
}));

test('creating the same obligation twice is idempotent and divergent replay is rejected',()=>withDB(async db=>{
  const input=bill('repeat');
  const a=await createObligation(db,who('alice'),input,now);
  const b=await createObligation(db,who('alice'),input,now);
  assert.equal(a.obligationId,b.obligationId);
  await assert.rejects(()=>createObligation(db,who('alice'),{...input,totalCents:cents('400.00')},now),/Idempotency conflict/);
  assert.equal((await listObligations(db,who('alice'))).length,1);
}));

test('real but insufficient recorded cash can go negative without inventing additional debt',()=>withDB(async db=>{
  const a=await wallet(db,'alice','0');
  const b=await createObligation(db,who('alice'),bill('negative',{totalCents:cents('2.00')}),now);
  await payObligation(db,who('alice'),payment(b.obligationId,a.accountId,'negative',{amountCents:cents('2.00')}),now);
  assert.equal((await getAccount(db,who('alice'),a.accountId)).balanceCents,-200);
  assert.equal((await getObligation(db,who('alice'),b.obligationId)).state,'paid');
}));

test('dates, amounts, labels, and pagination reject malformed or impossible values',()=>withDB(async db=>{
  const b0=bill('bad');
  for(const dueOn of ['2026-02-29','2026-11-31','2026-00-01','2026-11-10T16:00:00Z']){
    await assert.rejects(()=>createObligation(db,who('alice'),{...b0,dueOn},now));
  }
  for(const value of [0,-1,1.5,9007199254740991]){
    await assert.rejects(()=>createObligation(db,who('alice'),{...b0,totalCents:value},now));
  }
  for(const text of ['', 'bad\nlabel', 'a'.repeat(121)]){
    await assert.rejects(()=>createObligation(db,who('alice'),{...b0,title:text},now));
  }
  await assert.rejects(()=>listObligations(db,who('alice'),{limit:101}));
  const account=await wallet(db);
  const b=await createObligation(db,who('alice'),bill('valid'),now);
  await assert.rejects(()=>listObligationPayments(db,who('alice'),b.obligationId,{offset:-1}));
  for(const paidOn of ['2026-02-29','2026-04-31']){
    await assert.rejects(()=>payObligation(db,who('alice'),payment(b.obligationId,account.accountId,'bad-date',{paidOn}),now));
  }
  await assert.rejects(()=>payObligation(db,who('alice'),payment(b.obligationId,account.accountId,'zero',{amountCents:cents('0')}),now));
}));

test('payment links to exactly one expense with the same amount and ownership',()=>withDB(async db=>{
  const account=await wallet(db);
  const b=await createObligation(db,who('alice'),bill('ledger'),now);
  const result=await payObligation(db,who('alice'),payment(b.obligationId,account.accountId,'ledger'),now);
  const row=db.raw.prepare('SELECT p.*,m.owner_user_id as movement_owner,m.account_id,m.direction,m.amount_cents as movement_amount FROM financial_obligation_payments p JOIN posted_cash_movements m ON p.owner_user_id=m.owner_user_id AND p.movement_id=m.movement_id WHERE p.owner_user_id=?').get('alice');
  assert.equal(row.amount_cents,30000);
  assert.equal(row.movement_amount,30000);
  assert.equal(row.direction,'expense');
  assert.equal(row.movement_owner,'alice');
  assert.equal(row.account_id,account.accountId);
  assert.equal((await getObligationPayment(db,who('alice'),result.paymentId)).paymentId,result.paymentId);
  assert.equal(await getObligationPayment(db,who('bob'),result.paymentId),null);
}));

const base='https://cash.example', epoch=Date.parse('2026-11-10T16:00:00Z');
const lookup=async h=>{
  const principal=h.get('cookie')==='session=alice'?'alice':
    h.get('cookie')==='session=bob'?'bob':null;
  return principal?{user:{id:principal},session:{userId:principal,expiresAt:new Date(epoch+60000)}}:null;
};
function request(path,cookie,body,origin=base) {
  return new Request(base+path,{
    method:body===undefined?'GET':'POST',
    headers:{cookie,origin,'content-type':'application/json','x-user-id':'bob'},
    body:body===undefined?undefined:JSON.stringify(body),
  });
}
async function call(db,req) {
  const res=await handleFinancialHttp(req,db,lookup,base,()=>epoch);
  return {status:res.status,body:await res.json()};
}
const opening = {idempotencyKey:'account-key-0001',name:'Wallet',kind:'general',funding:{mode:'external',amount:'200.00'}};
const obligationBody = {idempotencyKey:'obligation-key-0001',title:'Fatura internet',amount:'75.00',dueOn:'2026-11-25',category:'Internet'};

test('HTTP: two authenticated users, create bill, partial pay, final pay, zero cross-user access',()=>withDB(async db=>{
  assert.equal((await call(db,request('/api/obligations','',obligationBody))).status,401);
  const a=await call(db,request('/api/accounts','session=alice',opening));
  assert.equal(a.status,201);
  const accountId=a.body.account.accountId;
  const b=await call(db,request('/api/obligations','session=alice',obligationBody));
  assert.equal(b.status,201);
  const obligationId=b.body.obligation.obligationId;
  assert.equal(b.body.obligation.state,'open');
  assert.equal((await call(db,request('/api/accounts/'+accountId,'session=alice'))).body.account.balanceCents,20000);
  assert.equal((await call(db,request('/api/obligations','session=bob'))).body.obligations.length,0);
  assert.equal((await call(db,request('/api/obligations/'+obligationId,'session=bob'))).status,404);
  const data={idempotencyKey:'payment-key-first',accountId,amount:'25.50',method:'pix',paidOn:'2026-11-10',ownerId:'bob'};
  const p=await call(db,request('/api/obligations/'+obligationId+'/payments','session=alice',data));
  assert.equal(p.status,201);
  assert.equal((await call(db,request('/api/obligations/'+obligationId,'session=alice'))).body.obligation.outstandingCents,4950);
  assert.equal((await call(db,request('/api/accounts/'+accountId,'session=alice'))).body.account.balanceCents,17450);
  assert.equal((await call(db,request('/api/obligations/'+obligationId+'/payments','session=bob'))).status,404);
  const foreign=await call(db,request('/api/obligations/'+obligationId+'/payments','session=bob',data));
  assert.deepEqual(foreign,{status:409,body:{error:'OPERATION_REJECTED'}});
  assert.equal((await call(db,request('/api/obligations/'+obligationId+'/payments','session=alice'))).body.payments.length,1);
  const same=await call(db,request('/api/obligations/'+obligationId+'/payments','session=alice',data));
  assert.equal(same.body.payment.paymentId,p.body.payment.paymentId);
  const last=await call(db,request('/api/obligations/'+obligationId+'/payments','session=alice',{
    ...data,idempotencyKey:'payment-key-final',amount:'49.50',
  }));
  assert.equal(last.status,201);
  assert.equal((await call(db,request('/api/obligations/'+obligationId,'session=alice'))).body.obligation.state,'paid');
  assert.equal((await call(db,request('/api/accounts/'+accountId,'session=alice'))).body.account.balanceCents,12500);
  assert.equal((await call(db,request('/api/movements','session=alice'))).body.movements.length,2);
}));

test('HTTP: reject cross-origin payment, overpay and malformed body without mutating the ledger',()=>withDB(async db=>{
  const account=(await call(db,request('/api/accounts','session=alice',opening))).body.account;
  const bill=(await call(db,request('/api/obligations','session=alice',obligationBody))).body.obligation;
  const path='/api/obligations/'+bill.obligationId+'/payments';
  const data={idempotencyKey:'payment-key-1111',accountId:account.accountId,amount:'500.00',method:'pix',paidOn:'2026-11-10'};
  assert.equal((await call(db,request(path,'session=alice',data,'https://evil.invalid'))).status,403);
  assert.equal((await call(db,request(path,'session=alice',{...data,amount:'1.002'}))).status,400);
  const over=await call(db,request(path,'session=alice',data));
  assert.deepEqual(over,{status:409,body:{error:'OPERATION_REJECTED'}});
  assert.equal((await call(db,request('/api/movements','session=alice'))).body.movements.length,0);
  assert.equal((await call(db,request('/api/obligations/'+bill.obligationId,'session=alice'))).body.obligation.outstandingCents,7500);
}));


test('database trigger rejects associating an income or mismatched amount to a bill payment',()=>withDB(async db=>{
  const account=await wallet(db);
  const b=await createObligation(db,who('alice'),bill('trigger',{totalCents:cents('10')}),now);
  const insertExpense=(direction,amount,tag)=>{
    const id=crypto.randomUUID();
    db.raw.prepare("INSERT INTO posted_cash_movements (owner_user_id,movement_id,creation_key,account_id,direction,amount_cents,payment_method,description,source_label,category,occurred_on,created_at) VALUES (?,?,?, ?,?,?,?, ?,NULL,NULL,?,?)")
      .run('alice',id,key('direct-'+tag),account.accountId,direction,amount,'pix','Test expense','2026-11-10',now().toISOString());
    return id;
  };
  const insertPayment=(movementId,amount,tag)=>db.raw.prepare('INSERT INTO financial_obligation_payments (owner_user_id,payment_id,creation_key,obligation_id,movement_id,amount_cents,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('alice',crypto.randomUUID(),key('linked-'+tag),b.obligationId,movementId,amount,now().toISOString());
  const income=insertExpense('income',500,'income');
  assert.throws(()=>insertPayment(income,500,'income'),/PAYMENT_MOVEMENT_MISMATCH/);
  const expense=insertExpense('expense',500,'expense');
  assert.throws(()=>insertPayment(expense,501,'different'),/PAYMENT_MOVEMENT_MISMATCH/);
  assert.equal((await getObligation(db,who('alice'),b.obligationId)).paidCents,0);
}));

test('database trigger refuses bypassing the service to overpay',()=>withDB(async db=>{
  const account=await wallet(db);
  const b=await createObligation(db,who('alice'),bill('trigger-over',{totalCents:cents('10')}),now);
  const id=crypto.randomUUID();
  db.raw.prepare("INSERT INTO posted_cash_movements (owner_user_id,movement_id,creation_key,account_id,direction,amount_cents,payment_method,description,source_label,category,occurred_on,created_at) VALUES (?,?,?, ?, 'expense',?, ?,?,NULL,NULL,?,?)")
    .run('alice',id,key('raw-over-movement'),account.accountId,1001,'pix','Posted','2026-11-10',now().toISOString());
  assert.throws(()=>db.raw.prepare('INSERT INTO financial_obligation_payments (owner_user_id,payment_id,creation_key,obligation_id,movement_id,amount_cents,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('alice',crypto.randomUUID(),key('raw-over-payment'),b.obligationId,id,1001,now().toISOString()),/PAYMENT_EXCEEDS_OBLIGATION/);
  assert.equal((await getObligation(db,who('alice'),b.obligationId)).outstandingCents,1000);
}));

test('simultaneous same-key obligation creations return a single record',()=>withDB(async db=>{
  const input=bill('create-race');
  const [first,second]=await Promise.all([
    createObligation(db,who('alice'),input,now),
    createObligation(db,who('alice'),input,now),
  ]);
  assert.equal(first.obligationId,second.obligationId);
  assert.equal((await listObligations(db,who('alice'))).length,1);
}));
