import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleAccountsHttp } from '../src/backend/http/accounts-handler.ts';

class Statement {
  constructor(db, sql, args=[]) { this.db=db; this.sql=sql; this.args=args; }
  bind(...args) { return new Statement(this.db,this.sql,args); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return {results:this.db.prepare(this.sql).all(...this.args)}; }
  async run() {return this.db.prepare(this.sql).run(...this.args);}
}
class Database {
  constructor() {
    this.sql=new DatabaseSync(':memory:');
    this.sql.exec('PRAGMA foreign_keys=ON');
    this.sql.exec(readFileSync(new URL('../migrations/0001_financial_accounts.sql',import.meta.url),'utf8'));
    this.sql.exec(readFileSync(new URL('../migrations/0003_cash_movements.sql',import.meta.url),'utf8'));
    this.sql.exec(readFileSync(new URL('../migrations/0002_better_auth.sql',import.meta.url),'utf8'));
    this.sql.exec(readFileSync(new URL('../migrations/0004_financial_obligations.sql',import.meta.url),'utf8'));
    this.sql.exec(readFileSync(new URL('../migrations/0005_internal_transfers.sql',import.meta.url),'utf8'));
    this.sql.exec(readFileSync(new URL('../migrations/0006_cancellations_refunds.sql',import.meta.url),'utf8'));
    this.queue=Promise.resolve();
  }
  prepare(sql){return new Statement(this.sql,sql);}
  batch(statements){
    const task=async()=>{
      this.sql.exec('BEGIN IMMEDIATE');
      try {const result=[];for(const s of statements)result.push(await s.run());this.sql.exec('COMMIT');return result;}
      catch(err){this.sql.exec('ROLLBACK');throw err;}
    };
    const current=this.queue.then(task);this.queue=current.catch(()=>{});return current;
  }
  close(){this.sql.close();}
}
const url='https://cash.example';
const now=Date.parse('2026-11-10T14:00:00Z');
const resolver=async h => {
  const cookie = h.get('cookie');
  if (cookie==='valid=a')return {user:{id:'alice'},session:{userId:'alice',expiresAt:new Date(now+60000)}};
  if (cookie==='valid=b')return {user:{id:'bob'},session:{userId:'bob',expiresAt:new Date(now+60000)}};
  if (cookie==='valid=expired')return {user:{id:'alice'},session:{userId:'alice',expiresAt:new Date(now-1)}};
  if (cookie==='valid=mismatch')return {user:{id:'alice'},session:{userId:'bob',expiresAt:new Date(now+60000)}};
  return null;
};
function post(path,cookie,body,origin=url){return new Request(url+path,{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-user-id':'alice'},body:JSON.stringify(body)});}
function get(path,cookie,headers={}){return new Request(url+path,{headers:{cookie,'x-user-id':'alice',...headers}});}
async function perform(db,request,lookup=resolver){const response=await handleAccountsHttp(request,db,lookup,url,()=>now);return {status:response.status,body:await response.json(),headers:response.headers};}
const payload=(id='account-request-alice')=>({idempotencyKey:id,name:'Carteira',kind:'general',funding:{mode:'external',amount:'100.25'},ownerId:'bob'});

const withDb=async fn=>{const db=new Database();try{await fn(db);}finally{db.close();}};

test('no session or invalid/expired/mismatched session is denied, even if x-user-id claims a known user',async()=>withDb(async db=>{
  for(const cookie of ['','forged=alice','valid=expired','valid=mismatch']){
    const r=await perform(db,get('/api/accounts',cookie));assert.equal(r.status,401,cookie);
  }
  const r=await perform(db,get('/api/accounts','valid=a'),async()=>{throw new Error('db offline')});assert.equal(r.status,401);
}));

test('auth principal owns creation; forged ownerId and x-user-id cannot switch ownership',async()=>withDb(async db=>{
  const a=await perform(db,post('/api/accounts','valid=a',payload()));
  assert.equal(a.status,201);
  const acc=a.body.account.accountId;
  const own=await perform(db,get('/api/accounts','valid=a'));
  assert.equal(own.body.accounts.length,1);
  const other=await perform(db,get('/api/accounts','valid=b'));
  assert.equal(other.body.accounts.length,0);
  const foreign=await perform(db,get('/api/accounts/'+acc,'valid=b'));
  assert.equal(foreign.status,404);
  assert.equal((await perform(db,get('/api/accounts/'+acc,'valid=a'))).status,200);
}));

test('cross-origin POST rejected, even with a valid cookie',async()=>withDb(async db=>{
  assert.equal((await perform(db,post('/api/accounts','valid=a',payload(),'https://evil.example'))).status,403);
  assert.equal((await perform(db,post('/api/accounts','valid=a',payload(),''))).status,403);
  assert.equal((await perform(db,new Request(url+'/api/accounts',{method:'POST',headers:{cookie:'valid=a'},body:JSON.stringify(payload())}))).status,403);
  assert.equal((await perform(db,new Request('https://evil.example/api/accounts',{headers:{cookie:'valid=a'}}))).status,403);
  assert.equal((await perform(db,get('/api/accounts','valid=a'))).body.accounts.length,0);
}));

test('invalid request body, money, and method rejected without mutation',async()=>withDb(async db=>{
  const malformed=await perform(db,post('/api/accounts','valid=a',{...payload(),funding:{mode:'external',amount:'10.001'}}));
  assert.equal(malformed.status,400);
  const oversized=await perform(db,post('/api/accounts','valid=a',{...payload(),name:'a'.repeat(5000)}));
  assert.equal(oversized.status,413);
  const json=await perform(db,new Request(url+'/api/accounts',{method:'POST',headers:{cookie:'valid=a',origin:url},body:'{' }));
  assert.equal(json.status,400);
  const invalidMethod=await perform(db,new Request(url+'/api/accounts',{method:'DELETE',headers:{cookie:'valid=a',origin:url}}));
  assert.equal(invalidMethod.status,405);
  assert.equal((await perform(db,get('/api/accounts','valid=a'))).body.accounts.length,0);
}));

test('same owner retry is idempotent; replay with different payload returns generic conflict without raw SQL',async()=>withDb(async db=>{
  const a=await perform(db,post('/api/accounts','valid=a',payload()));
  const b=await perform(db,post('/api/accounts','valid=a',payload()));
  assert.equal(a.status,201);assert.equal(b.status,201);
  assert.equal(a.body.account.accountId,b.body.account.accountId);
  const failed=await perform(db,post('/api/accounts','valid=a',{...payload(),name:'Changed'}));
  assert.equal(failed.status,409);assert.deepEqual(failed.body,{error:'CONFLICT'});
}));

test('owner of reallocation and insufficient funds never leak through error text',async()=>withDb(async db=>{
  const a=await perform(db,post('/api/accounts','valid=a',payload('request-alice-unique')));
  const id=a.body.account.accountId;
  const target={idempotencyKey:'request-bob-target',name:'Other',kind:'cash',funding:{mode:'reallocate',amount:'30',fromAccountId:id}};
  const err=await perform(db,post('/api/accounts','valid=b',target));
  assert.equal(err.status,409);assert.deepEqual(err.body,{error:'OPERATION_REJECTED'});
  assert(!JSON.stringify(err.body).includes('alice'));
  const overdraft=await perform(db,post('/api/accounts','valid=a',{...target,idempotencyKey:'request-alice-overdraw',funding:{...target.funding,amount:'200'}}));
  assert.equal(overdraft.status,409);
  assert.equal((await perform(db,get('/api/accounts','valid=a'))).body.accounts.length,1);
  assert.equal((await perform(db,get('/api/accounts','valid=b'))).body.accounts.length,0);
}));
