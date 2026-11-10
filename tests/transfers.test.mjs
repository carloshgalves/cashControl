import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAccount, getAccount, listAccounts } from '../src/backend/accounts/accounts.ts';
import { postMovement, listMovements } from '../src/backend/movements/movements.ts';
import { createObligation, payObligation } from '../src/backend/obligations/obligations.ts';
import { createInternalTransfer, getInternalTransfer, listInternalTransfers } from '../src/backend/transfers/transfers.ts';
import { parseCents } from '../src/domain/money.ts';
import { handleFinancialHttp } from '../src/backend/http/accounts-handler.ts';

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() { return this.db.prepare(this.sql).run(...this.params); }
}
class Database {
  constructor() {
    this.raw = new DatabaseSync(':memory:');
    this.raw.exec('PRAGMA foreign_keys=ON');
    for (const file of [
      '0001_financial_accounts.sql', '0002_better_auth.sql', '0003_cash_movements.sql',
      '0004_financial_obligations.sql', '0005_internal_transfers.sql', '0006_cancellations_refunds.sql',
    ]) this.raw.exec(readFileSync(new URL('../migrations/'+file, import.meta.url), 'utf8'));
    this.queue = Promise.resolve();
  }
  prepare(sql) { return new Statement(this.raw, sql); }
  batch(statements) {
    const transaction = async () => {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        this.raw.exec('COMMIT');
        return result;
      } catch (err) { this.raw.exec('ROLLBACK'); throw err; }
    };
    const pending = this.queue.then(transaction);
    this.queue = pending.catch(() => {});
    return pending;
  }
  close() { this.raw.close(); }
}
const actor = userId => ({ userId });
const cents = parseCents;
const key = suffix => 'internal-transfer-test-'+suffix;
const clock = () => new Date('2026-11-10T16:00:00Z');
async function account(db, owner, suffix, initial='0', kind='bank') {
  return createAccount(db,actor(owner),{
    idempotencyKey:key('account-'+owner+'-'+suffix),name:suffix,kind,
    funding:{mode:'external',cents:cents(initial)},
  },clock);
}
async function pair(db, owner='alice', initial='100.00') {
  const from = await account(db,owner,'Source',initial,'general');
  const to = await account(db,owner,'Target','0','bank');
  return {from,to};
}
function request(from,to,suffix='a',overrides={}) {
  return {
    idempotencyKey:key('request-'+suffix),sourceAccountId:from.accountId,
    targetAccountId:to.accountId,amountCents:cents('25.55'),
    transferredOn:'2026-11-10',note:'Mover entre contas',...overrides,
  };
}
async function withDb(fn) {
  const db = new Database();
  try { return await fn(db); } finally { db.close(); }
}
async function balance(db,who,id) {
  return (await getAccount(db,actor(who),id)).balanceCents;
}
async function total(db,who) {
  return (await listAccounts(db,actor(who))).reduce((sum,a)=>sum+a.balanceCents,0);
}

test('one internal transfer debits source, credits destination and preserves consolidated cash',()=>withDb(async db=>{
  const {from,to}=await pair(db);
  const previous=await total(db,'alice');
  const result=await createInternalTransfer(db,actor('alice'),request(from,to),clock);
  assert.equal(result.amountCents,2555);
  assert.equal(result.note,'Mover entre contas');
  assert.equal(await balance(db,'alice',from.accountId),7445);
  assert.equal(await balance(db,'alice',to.accountId),2555);
  assert.equal(await total(db,'alice'),previous);
  assert.deepEqual(await listMovements(db,actor('alice')),[]);
  assert.equal((await listInternalTransfers(db,actor('alice'))).length,1);
}));

test('reverse transfers restore account balances without affecting result from genuine income and expense',()=>withDb(async db=>{
  const {from,to}=await pair(db);
  await postMovement(db,actor('alice'),{
    idempotencyKey:key('income'),accountId:from.accountId,direction:'income',
    amountCents:cents('11.02'),method:'pix',description:'External income',occurredOn:'2026-11-10',
  },clock);
  await postMovement(db,actor('alice'),{
    idempotencyKey:key('expense'),accountId:from.accountId,direction:'expense',
    amountCents:cents('4.01'),method:'debit',description:'Paid bill',occurredOn:'2026-11-10',
  },clock);
  const before=await total(db,'alice');
  await createInternalTransfer(db,actor('alice'),request(from,to,'out'),clock);
  await createInternalTransfer(db,actor('alice'),request(to,from,'back',{
    amountCents:cents('5.01'), note:null,
  }),clock);
  assert.equal(await balance(db,'alice',from.accountId),8647);
  assert.equal(await balance(db,'alice',to.accountId),2054);
  assert.equal(await total(db,'alice'),before);
  const movements=await listMovements(db,actor('alice'));
  assert.equal(movements.length,2);
  assert.equal(movements.reduce((n,m)=>n+(m.direction==='income'?m.amountCents:-m.amountCents),0),701);
}));

test('zero source or insufficient recorded cash rejects transfer atomically',()=>withDb(async db=>{
  const {from,to}=await pair(db,'alice','0');
  await assert.rejects(()=>createInternalTransfer(db,actor('alice'),request(from,to,'zero'),clock),/SOURCE_BALANCE_INSUFFICIENT/);
  assert.deepEqual(await listInternalTransfers(db,actor('alice')),[]);
  assert.equal(await total(db,'alice'),0);
  assert.equal(await balance(db,'alice',to.accountId),0);
}));

test('same-account and zero amount are rejected before touching financial balances',()=>withDb(async db=>{
  const {from,to}=await pair(db);
  await assert.rejects(()=>createInternalTransfer(db,actor('alice'),request(from,from,'same'),clock),/Invalid transfer endpoints/);
  await assert.rejects(()=>createInternalTransfer(db,actor('alice'),request(from,to,'zero-value',{amountCents:cents('0')}),clock));
  await assert.rejects(()=>createInternalTransfer(db,actor('alice'),request(from,to,'fraction',{amountCents:0.2}),clock));
  await assert.rejects(()=>createInternalTransfer(db,actor('alice'),request(from,to,'huge',{amountCents:Number.MAX_SAFE_INTEGER}),clock));
  assert.equal(await total(db,'alice'),10000);
  assert.deepEqual(await listInternalTransfers(db,actor('alice')),[]);
}));

test('transfer cannot target another user account even knowing its UUID',()=>withDb(async db=>{
  const {from,to}=await pair(db,'alice');
  const bob=await account(db,'bob','Bob','0','general');
  await assert.rejects(()=>createInternalTransfer(db,actor('alice'),request(from,bob,'foreign-destination'),clock),/FOREIGN KEY/);
  await assert.rejects(()=>createInternalTransfer(db,actor('bob'),request(from,bob,'foreign-source'),clock),/SOURCE_BALANCE_INSUFFICIENT/);
  assert.equal(await balance(db,'alice',from.accountId),10000);
  assert.equal(await balance(db,'alice',to.accountId),0);
  assert.equal(await balance(db,'bob',bob.accountId),0);
  assert.deepEqual(await listInternalTransfers(db,actor('alice')),[]);
  assert.deepEqual(await listInternalTransfers(db,actor('bob')),[]);
}));

test('missing destination or source leaves no orphan transfer leg or partial balance update',()=>withDb(async db=>{
  const {from,to}=await pair(db);
  const invalid='11111111-1111-1111-1111-111111111111';
  await assert.rejects(()=>createInternalTransfer(db,actor('alice'),request(from,{accountId:invalid},'missing-target'),clock));
  await assert.rejects(()=>createInternalTransfer(db,actor('alice'),request({accountId:invalid},to,'missing-source'),clock));
  assert.equal(await balance(db,'alice',from.accountId),10000);
  assert.equal(await balance(db,'alice',to.accountId),0);
  assert.equal(await total(db,'alice'),10000);
  assert.deepEqual(await listInternalTransfers(db,actor('alice')),[]);
}));

test('identical retries keep a single transfer; changed payload with same key conflicts',()=>withDb(async db=>{
  const {from,to}=await pair(db);
  const input=request(from,to,'replay');
  const a=await createInternalTransfer(db,actor('alice'),input,clock);
  const b=await createInternalTransfer(db,actor('alice'),input,clock);
  assert.equal(a.transferId,b.transferId);
  await assert.rejects(()=>createInternalTransfer(db,actor('alice'),{...input,amountCents:cents('40.00')},clock),/Idempotency conflict/);
  assert.equal(await balance(db,'alice',from.accountId),7445);
  assert.equal(await balance(db,'alice',to.accountId),2555);
  assert.equal((await listInternalTransfers(db,actor('alice'))).length,1);
}));

test('concurrent same-key retries return one transfer without a double debit',()=>withDb(async db=>{
  const {from,to}=await pair(db);
  const input=request(from,to,'concurrent-key');
  const [a,b]=await Promise.all([
    createInternalTransfer(db,actor('alice'),input,clock),
    createInternalTransfer(db,actor('alice'),input,clock),
  ]);
  assert.equal(a.transferId,b.transferId);
  assert.equal((await listInternalTransfers(db,actor('alice'))).length,1);
  assert.equal(await balance(db,'alice',from.accountId),7445);
}));

test('different concurrent transfers cannot consume the same source money twice',()=>withDb(async db=>{
  const {from,to}=await pair(db);
  const another=await account(db,'alice','Third','0');
  const attempts=await Promise.allSettled([
    createInternalTransfer(db,actor('alice'),request(from,to,'race-A',{amountCents:cents('75')}),clock),
    createInternalTransfer(db,actor('alice'),request(from,another,'race-B',{amountCents:cents('75')}),clock),
  ]);
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(attempts.filter(x=>x.status==='rejected').length,1);
  assert.equal((await listInternalTransfers(db,actor('alice'))).length,1);
  assert.equal(await balance(db,'alice',from.accountId),2500);
  assert.equal(await total(db,'alice'),10000);
}));

test('funds already spent on a bill cannot be transferred again',()=>withDb(async db=>{
  const {from,to}=await pair(db);
  const obligation=await createObligation(db,actor('alice'),{
    idempotencyKey:key('bill-1'),title:'Internet',totalCents:cents('80'),
    dueOn:'2026-11-25',
  },clock);
  await payObligation(db,actor('alice'),{
    idempotencyKey:key('bill-paid'),obligationId:obligation.obligationId,
    accountId:from.accountId,amountCents:cents('80'),
    method:'pix',paidOn:'2026-11-10',
  },clock);
  await assert.rejects(()=>createInternalTransfer(db,actor('alice'),request(from,to,'post-bill',{amountCents:cents('25')}),clock),/SOURCE_BALANCE_INSUFFICIENT/);
  assert.equal(await balance(db,'alice',from.accountId),2000);
  assert.equal(await total(db,'alice'),2000);
  assert.deepEqual(await listInternalTransfers(db,actor('alice')),[]);
}));

test('initial balance reallocation after a transfer cannot spend already transferred value',()=>withDb(async db=>{
  const {from,to}=await pair(db);
  await createInternalTransfer(db,actor('alice'),request(from,to,'before-reallocation',{amountCents:cents('70')}),clock);
  await assert.rejects(()=>createAccount(db,actor('alice'),{
    idempotencyKey:key('reallocate-too-much'),name:'Fourth',kind:'cash',
    funding:{mode:'reallocate',cents:cents('35'),fromAccountId:from.accountId},
  },clock));
  const remainder=await createAccount(db,actor('alice'),{
    idempotencyKey:key('reallocate-remainder'),name:'Fourth',kind:'cash',
    funding:{mode:'reallocate',cents:cents('30'),fromAccountId:from.accountId},
  },clock);
  assert.equal(remainder.balanceCents,3000);
  assert.equal(await balance(db,'alice',from.accountId),0);
  assert.equal(await balance(db,'alice',to.accountId),7000);
  assert.equal(await total(db,'alice'),10000);
}));

test('SQLite trigger and foreign keys guard direct SQL writes, and transfer history is immutable',()=>withDb(async db=>{
  const {from,to}=await pair(db);
  const insert=(source,target,amount,nonce)=>db.raw.prepare(
    'INSERT INTO internal_transfers (owner_user_id, transfer_id, creation_key, source_account_id, target_account_id, amount_cents, transferred_on, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('alice',crypto.randomUUID(),key(nonce),source,target,amount,'2026-11-10',null,clock().toISOString());
  assert.throws(()=>insert(from.accountId,to.accountId,10001,'sql-insufficient'),/SOURCE_BALANCE_INSUFFICIENT/);
  assert.throws(()=>insert(from.accountId,from.accountId,2000,'sql-self'),/CHECK/);
  const result=await createInternalTransfer(db,actor('alice'),request(from,to,'immutable'),clock);
  assert.throws(()=>db.raw.prepare('UPDATE internal_transfers SET amount_cents = ? WHERE transfer_id = ?').run(1,result.transferId),/TRANSFER_IMMUTABLE/);
  assert.throws(()=>db.raw.prepare('DELETE FROM internal_transfers WHERE transfer_id = ?').run(result.transferId),/TRANSFER_IMMUTABLE/);
  assert.equal(await total(db,'alice'),10000);
}));

test('historical list is filtered by owner, source or target, with bounds on pagination',()=>withDb(async db=>{
  const {from,to}=await pair(db);
  const bob=await pair(db,'bob');
  await createInternalTransfer(db,actor('bob'),request(bob.from,bob.to,'bob-only'),clock);
  await createInternalTransfer(db,actor('alice'),request(from,to,'old',{transferredOn:'2026-11-09'}),clock);
  await createInternalTransfer(db,actor('alice'),request(to,from,'new',{amountCents:cents('10'),transferredOn:'2026-11-10'}),clock);
  assert.deepEqual((await listInternalTransfers(db,actor('alice'))).map(x=>x.transferredOn),['2026-11-10','2026-11-09']);
  assert.equal((await listInternalTransfers(db,actor('alice'),{accountId:to.accountId,offset:1,limit:1})).length,1);
  assert.deepEqual(await listInternalTransfers(db,actor('alice'),{accountId:bob.from.accountId}),[]);
  const foreignId=(await listInternalTransfers(db,actor('bob')))[0].transferId;
  assert.equal(await getInternalTransfer(db,actor('alice'),foreignId),null);
}));

test('invalid dates, notes, keys and pagination fail with no persisted transfer',()=>withDb(async db=>{
  const {from,to}=await pair(db);
  for(const d of ['2026-02-29','2026-04-31','2026-11-00','2026-13-02','2026-11-10T00:00:00Z']){
    await assert.rejects(()=>createInternalTransfer(db,actor('alice'),request(from,to,'invalid-date',{transferredOn:d}),clock));
  }
  const leap=await createInternalTransfer(db,actor('alice'),request(from,to,'leap',{transferredOn:'2024-02-29',amountCents:cents('1')}),clock);
  assert.equal(leap.transferredOn,'2024-02-29');
  for(const note of ['', 'evil\nnewline','a'.repeat(121)]){
    await assert.rejects(()=>createInternalTransfer(db,actor('alice'),request(from,to,'invalid-note',{note}),clock));
  }
  await assert.rejects(()=>createInternalTransfer(db,actor('alice'),request(from,to,'bad-key',{idempotencyKey:'short'}),clock));
  for(const filter of [{limit:0},{limit:101},{offset:-1},{offset:1.2},{accountId:'bad'}]){
    await assert.rejects(()=>listInternalTransfers(db,actor('alice'),filter));
  }
  assert.equal((await listInternalTransfers(db,actor('alice'))).length,1);
}));

test('note containing SQL syntax remains data and cannot alter financial tables',()=>withDb(async db=>{
  const {from,to}=await pair(db);
  const note="Source'); DROP TABLE internal_transfers; --";
  const result=await createInternalTransfer(db,actor('alice'),request(from,to,'sql',{note}),clock);
  assert.equal(result.note,note);
  assert.equal((await listInternalTransfers(db,actor('alice'))).length,1);
}));

test('same creation key can be independently used by two owners',()=>withDb(async db=>{
  const alice=await pair(db),bob=await pair(db,'bob');
  const a=await createInternalTransfer(db,actor('alice'),request(alice.from,alice.to,'shared'),clock);
  const b=await createInternalTransfer(db,actor('bob'),request(bob.from,bob.to,'shared'),clock);
  assert.notEqual(a.transferId,b.transferId);
  assert.equal(await total(db,'alice'),10000);
  assert.equal(await total(db,'bob'),10000);
}));

const base='https://cash.example', now=Date.parse('2026-11-10T16:00:00Z');
const lookup=async headers=>{
  const id=headers.get('cookie')==='session=alice'?'alice':
    headers.get('cookie')==='session=bob'?'bob':null;
  return id?{user:{id},session:{userId:id,expiresAt:new Date(now+60000)}}:null;
};
function http(path,cookie,body,origin=base) {
  return new Request(base+path,{
    method:body===undefined?'GET':'POST',
    headers:{cookie,origin,'content-type':'application/json','x-user-id':'bob'},
    body:body===undefined?undefined:JSON.stringify(body),
  });
}
async function call(db,req) {
  const res=await handleFinancialHttp(req,db,lookup,base,()=>now);
  return {status:res.status,body:await res.json()};
}
const httpAccount=(name,amount,idemp)=>({
  idempotencyKey:key(idemp),name,kind:'bank',funding:{mode:'external',amount},
});
const httpTransfer=(source,target,overrides={})=>({
  idempotencyKey:key('http-primary'),
  sourceAccountId:source,targetAccountId:target,amount:'20.05',
  transferredOn:'2026-11-10',note:'Reserva interna',ownerId:'bob',
  ...overrides,
});

test('authenticated HTTP transfer changes both accounts exactly and never creates cash income/expense',()=>withDb(async db=>{
  assert.equal((await call(db,http('/api/transfers','',{}))).status,401);
  const source=(await call(db,http('/api/accounts','session=alice',httpAccount('Source','100.00','http-source')))).body.account.accountId;
  const target=(await call(db,http('/api/accounts','session=alice',httpAccount('Target','0.00','http-target')))).body.account.accountId;
  const p=await call(db,http('/api/transfers','session=alice',httpTransfer(source,target)));
  assert.equal(p.status,201);
  assert.equal((await call(db,http('/api/accounts/'+source,'session=alice'))).body.account.balanceCents,7995);
  assert.equal((await call(db,http('/api/accounts/'+target,'session=alice'))).body.account.balanceCents,2005);
  assert.deepEqual((await call(db,http('/api/movements','session=alice'))).body.movements,[]);
  assert.equal((await call(db,http('/api/transfers','session=alice'))).body.transfers.length,1);
  assert.equal((await call(db,http('/api/transfers/'+p.body.transfer.transferId,'session=bob'))).status,404);
  assert.deepEqual((await call(db,http('/api/transfers','session=bob'))).body.transfers,[]);
  assert.equal((await call(db,http('/api/transfers?accountId='+source,'session=alice'))).body.transfers.length,1);
}));

test('HTTP rejects cross-origin, invalid amount, foreign target and invalid/identical endpoints',()=>withDb(async db=>{
  const source=(await call(db,http('/api/accounts','session=alice',httpAccount('Source','100.00','http-source')))).body.account.accountId;
  const target=(await call(db,http('/api/accounts','session=alice',httpAccount('Target','0.00','http-target')))).body.account.accountId;
  const bob=(await call(db,http('/api/accounts','session=bob',httpAccount('Foreign','0.00','http-bob')))).body.account.accountId;
  assert.equal((await call(db,http('/api/transfers','session=alice',httpTransfer(source,target),'https://evil.invalid'))).status,403);
  assert.equal((await call(db,http('/api/transfers','session=alice',httpTransfer(source,target,{amount:'1.001'})))).status,400);
  assert.equal((await call(db,http('/api/transfers','session=alice',httpTransfer(source,target,{sourceAccountId:target,targetAccountId:target})))).status,400);
  assert.deepEqual(await call(db,http('/api/transfers','session=alice',httpTransfer(source,bob))),{status:409,body:{error:'OPERATION_REJECTED'}});
  assert.equal((await call(db,http('/api/transfers?limit=500','session=alice'))).status,400);
  assert.equal((await call(db,http('/api/transfers','session=alice'))).body.transfers.length,0);
  assert.equal((await call(db,http('/api/accounts/'+source,'session=alice'))).body.account.balanceCents,10000);
}));

test('HTTP retries are idempotent, conflicting reuse fails and concurrent overdraw leaves both endpoints consistent',()=>withDb(async db=>{
  const source=(await call(db,http('/api/accounts','session=alice',httpAccount('Source','100.00','http-source')))).body.account.accountId;
  const target=(await call(db,http('/api/accounts','session=alice',httpAccount('Target','0.00','http-target')))).body.account.accountId;
  const body=httpTransfer(source,target);
  const first=await call(db,http('/api/transfers','session=alice',body));
  const second=await call(db,http('/api/transfers','session=alice',body));
  assert.equal(first.body.transfer.transferId,second.body.transfer.transferId);
  assert.deepEqual(await call(db,http('/api/transfers','session=alice',{...body,amount:'35.00'})),{
    status:409,body:{error:'OPERATION_REJECTED'},
  });
  const competitors=await Promise.all([
    call(db,http('/api/transfers','session=alice',{...body,idempotencyKey:key('race-x'),amount:'60.00'})),
    call(db,http('/api/transfers','session=alice',{...body,idempotencyKey:key('race-y'),amount:'60.00'})),
  ]);
  assert.deepEqual(competitors.map(x=>x.status).sort(),[201,409]);
  assert.equal((await call(db,http('/api/accounts/'+source,'session=alice'))).body.account.balanceCents,1995);
  assert.equal((await call(db,http('/api/accounts/'+target,'session=alice'))).body.account.balanceCents,8005);
}));
