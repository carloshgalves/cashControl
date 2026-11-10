import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAccount, listAccounts, getAccount } from '../src/backend/accounts/accounts.ts';
import { parseCents, asDecimal } from '../src/domain/money.ts';

class SQLiteD1Statement {
  constructor(database, sql, params = []) {
    this.database = database; this.sql = sql; this.params = params;
  }
  bind(...params) { return new SQLiteD1Statement(this.database, this.sql, params); }
  async first() { return this.database.prepare(this.sql).get(...this.params) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.params) }; }
  async run() { return this.database.prepare(this.sql).run(...this.params); }
}
class SQLiteD1 {
  constructor() {
    this.raw = new DatabaseSync(':memory:');
    this.raw.exec('PRAGMA foreign_keys=ON');
    this.raw.exec(readFileSync(new URL('../migrations/0001_financial_accounts.sql', import.meta.url), 'utf8'));
    this.batchQueue = Promise.resolve();
  }
  prepare(sql) { return new SQLiteD1Statement(this.raw, sql); }
  batch(statements) {
    const execute = async () => {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const stmt of statements) results.push(await stmt.run());
        this.raw.exec('COMMIT');
        return results;
      } catch (error) { this.raw.exec('ROLLBACK'); throw error; }
    };
    const op = this.batchQueue.then(execute);
    this.batchQueue = op.catch(() => {});
    return op;
  }
  close() { this.raw.close(); }
}
const actor = userId => ({userId});
const external = s => ({mode:'external',cents:parseCents(s)});
const transfer = (s, fromAccountId) => ({mode:'reallocate',cents:parseCents(s),fromAccountId});
const req = (key, name, funding, kind='bank') => ({idempotencyKey:key,name,kind,funding});
const key = suffix => `request-key-${suffix}`;

async function withDb(fn) {
  const db = new SQLiteD1();
  try { return await fn(db); } finally { db.close(); }
}

test('cents parser never rounds IEEE-754 floats and enforces safe range', () => {
  assert.equal(parseCents('0.01'),1);
  assert.equal(parseCents('0.02')+parseCents('0.01'),3);
  assert.equal(asDecimal(parseCents('125.9')),'125.90');
  for (const bad of ['1,25','1e2','0.001','-1','+1',' 1','01.00','NaN','90000000000.01']) {
    assert.throws(()=>parseCents(bad), RangeError, bad);
  }
});

test('zero-balance general wallet works without a bank or card', async () => withDb(async db => {
  const a=await createAccount(db,actor('u1'),req(key('zero'),'Carteira geral',external('0'),'general'));
  assert.equal(a.balanceCents,0);
  assert.deepEqual((await listAccounts(db,actor('u1'))).map(x=>x.kind),['general']);
  assert.deepEqual(await listAccounts(db,actor('u2')),[]);
  assert.equal(await getAccount(db,actor('u2'),a.accountId),null);
}));

test('separate external openings are explicit and sum as true new starting balances', async () => withDb(async db=>{
  await createAccount(db,actor('u1'),req(key('one'),'Banco A',external('1200.55')));
  await createAccount(db,actor('u1'),req(key('two'),'Banco B',external('400.05')));
  const accounts=await listAccounts(db,actor('u1'));
  assert.equal(accounts.reduce((sum,a)=>sum+a.balanceCents,0),160060);
}));

test('reallocate from general wallet without inflating consolidated balance', async () => withDb(async db=>{
  const original=await createAccount(db,actor('u1'),req(key('general'),'Saldo geral',external('2000.00'),'general'));
  const bank=await createAccount(db,actor('u1'),req(key('bank'),'Banco',transfer('700.25',original.accountId)));
  const general=await getAccount(db,actor('u1'),original.accountId);
  assert.equal(general.balanceCents,129975);
  assert.equal(bank.balanceCents,70025);
  assert.equal((await listAccounts(db,actor('u1'))).reduce((s,a)=>s+a.balanceCents,0),200000);
}));

test('insufficient reallocation aborts account creation atomically', async () => withDb(async db => {
  const general=await createAccount(db,actor('u1'),req(key('gen'),'Saldo',external('50.00'),'general'));
  await assert.rejects(()=>createAccount(db,actor('u1'),req(key('too-much'),'Another',transfer('50.01',general.accountId))));
  const accounts=await listAccounts(db,actor('u1'));
  assert.equal(accounts.length,1);
  assert.equal(accounts[0].balanceCents,5000);
}));

test('cannot reallocate or query another owner resource even with a known account UUID', async () => withDb(async db=>{
  const a=await createAccount(db,actor('alice'),req(key('alice'),'A',external('500')));
  await assert.rejects(()=>createAccount(db,actor('bob'),req(key('attempt'),'B',transfer('100',a.accountId))));
  assert.deepEqual(await listAccounts(db,actor('bob')),[]);
  assert.equal(await getAccount(db,actor('bob'),a.accountId),null);
  assert.equal((await getAccount(db,actor('alice'),a.accountId)).balanceCents,50000);
}));

test('same idempotency key never produces second account or reallocates twice', async () => withDb(async db=>{
  const a=await createAccount(db,actor('u1'),req(key('parent'),'G',external('120'),'general'));
  const params=req(key('child'),'Cash',transfer('90',a.accountId),'cash');
  const first=await createAccount(db,actor('u1'),params);
  const second=await createAccount(db,actor('u1'),params);
  assert.equal(first.accountId,second.accountId);
  assert.equal((await getAccount(db,actor('u1'),a.accountId)).balanceCents,3000);
  assert.equal((await listAccounts(db,actor('u1'))).length,2);
  await assert.rejects(()=>createAccount(db,actor('u1'),req(key('child'),'Other',external('90'))),/Idempotency key reused/);
}));

test('forbid ambiguous wallet duplication, malformed names, zero or floating reallocation', async () => withDb(async db=>{
  await createAccount(db,actor('u1'),req(key('master'),'General',external('0'),'general'));
  await assert.rejects(()=>createAccount(db,actor('u1'),req(key('second'),'General 2',external('0'),'general')));
  await assert.rejects(()=>createAccount(db,actor('u1'),req(key('newline'),'abc\nsecond',external('0'))));
  await assert.rejects(()=>createAccount(db,actor('u1'),req(key('zero-transfer'),'A',transfer('0','00000000-0000-0000-0000-000000000000'))));
  await assert.rejects(()=>createAccount(db,actor('u1'),req(key('fraction'),'A',{mode:'external',cents:0.1})));
}));

test('account labels use parameter binding, not SQL string concatenation', async ()=>withDb(async db=>{
  const name="Nubank'); DROP TABLE financial_accounts; --";
  const a=await createAccount(db,actor('u1'),req(key('injection'),name,external('100')));
  assert.equal(a.name,name);
  assert.equal((await listAccounts(db,actor('u1'))).length,1);
}));


test('concurrent retries commit exactly one account and one reallocation', async () => withDb(async db=>{
  const parent=await createAccount(db,actor('u1'),req(key('concurrent-source'),'G',external('200'),'general'));
  const body=req(key('concurrent-target'),'Savings',transfer('75.20',parent.accountId));
  const [left,right]=await Promise.all([
    createAccount(db,actor('u1'),body),
    createAccount(db,actor('u1'),body),
  ]);
  assert.equal(left.accountId,right.accountId);
  assert.equal((await listAccounts(db,actor('u1'))).length,2);
  assert.equal((await getAccount(db,actor('u1'),parent.accountId)).balanceCents,12480);
  assert.equal((await getAccount(db,actor('u1'),left.accountId)).balanceCents,7520);
}));

test('same retry key from different users is independently scoped', async ()=>withDb(async db=>{
  const same=key('shared');
  const a=await createAccount(db,actor('alice'),req(same,'A',external('10')));
  const b=await createAccount(db,actor('bob'),req(same,'B',external('40')));
  assert.notEqual(a.accountId,b.accountId);
  assert.equal((await getAccount(db,actor('alice'),a.accountId)).balanceCents,1000);
  assert.equal((await getAccount(db,actor('bob'),b.accountId)).balanceCents,4000);
}));

test('malicious caller cannot exceed owner scope through binding parameter values', async ()=>withDb(async db=>{
  const a=await createAccount(db,actor('a'),req(key('isolation-a'),'A',external('100')));
  const own=await listAccounts(db,actor('a'));
  assert.equal(own.length,1);
  assert.equal((await listAccounts(db,actor('a\u0027 OR 1=1 --'))).length,0);
  assert.equal(await getAccount(db,actor('b'),a.accountId),null);
  await assert.rejects(()=>listAccounts(db,{userId:''}),/Verified user required/);
}));

test('concurrent distinct reallocation requests cannot overdraw the same balance', async ()=>withDb(async db=>{
  const original=await createAccount(db,actor('u1'),req(key('competition-source'),'Saldo',external('100'),'general'));
  const attempts=await Promise.allSettled([
    createAccount(db,actor('u1'),req(key('race-left'),'Bank A',transfer('60',original.accountId))),
    createAccount(db,actor('u1'),req(key('race-right'),'Bank B',transfer('60',original.accountId))),
  ]);
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(attempts.filter(x=>x.status==='rejected').length,1);
  assert.equal((await listAccounts(db,actor('u1'))).reduce((sum,x)=>sum+x.balanceCents,0),10000);
  assert.equal((await listAccounts(db,actor('u1'))).length,2);
}));
