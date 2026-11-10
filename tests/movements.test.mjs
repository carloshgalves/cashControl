import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAccount, getAccount, listAccounts } from '../src/backend/accounts/accounts.ts';
import { getMovement, listMovements, postMovement } from '../src/backend/movements/movements.ts';
import { parseCents } from '../src/domain/money.ts';
import { handleFinancialHttp } from '../src/backend/http/accounts-handler.ts';

class Statement {
  constructor(db, sql, args=[]) { this.db=db; this.sql=sql; this.args=args; }
  bind(...args) { return new Statement(this.db,this.sql,args); }
  async first() {return this.db.prepare(this.sql).get(...this.args)??null;}
  async all() {return {results:this.db.prepare(this.sql).all(...this.args)};}
  async run() {return this.db.prepare(this.sql).run(...this.args);}
}
class Database {
  constructor() {
    this.raw=new DatabaseSync(':memory:');
    this.raw.exec('PRAGMA foreign_keys=ON');
    for(const file of ['0001_financial_accounts.sql','0002_better_auth.sql','0003_cash_movements.sql']) {
      this.raw.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
    }
    this.queue=Promise.resolve();
  }
  prepare(sql){return new Statement(this.raw,sql);}
  batch(statements){
    const task=async()=>{
      this.raw.exec('BEGIN IMMEDIATE');
      try{const rows=[];for(const x of statements)rows.push(await x.run());this.raw.exec('COMMIT');return rows;}
      catch(e){this.raw.exec('ROLLBACK');throw e;}
    };
    const operation=this.queue.then(task);this.queue=operation.catch(()=>{});return operation;
  }
  close(){this.raw.close();}
}
const actor=userId=>({userId});
const cents=s=>parseCents(s);
const key=s=>'movement-request-'+s;
const make=(accountId,s,changes={})=>({
  accountId,idempotencyKey:key(s),direction:'income',amountCents:cents('30.01'),
  method:'pix',description:'Serviço realizado',occurredOn:'2026-11-10',
  sourceLabel:'Freelance',category:null,...changes,
});
async function wallet(db,who='alice',balance='0'){
  return createAccount(db,actor(who),{
    idempotencyKey:key('wallet-'+who),name:'Carteira geral',kind:'general',
    funding:{mode:'external',cents:cents(balance)},
  });
}
async function run(fn){const db=new Database();try{await fn(db);}finally{db.close();}}

test('confirmed receipts and paid expenses update exact cash balance once',()=>run(async db=>{
  const a=await wallet(db,'alice','100.05');
  await postMovement(db,actor('alice'),make(a.accountId,'income'));
  await postMovement(db,actor('alice'),make(a.accountId,'expense',{
    direction:'expense',amountCents:cents('25.99'),method:'debit',description:'Mercado',sourceLabel:null,
  }));
  assert.equal((await getAccount(db,actor('alice'),a.accountId)).balanceCents,10407);
  assert.deepEqual((await listMovements(db,actor('alice'))).map(x=>x.direction).sort(),['expense','income']);
}));

test('zero-balance cash wallet supports informal income without bank or employer',()=>run(async db=>{
  const a=await wallet(db);
  await postMovement(db,actor('alice'),make(a.accountId,'cash',{
    direction:'income',method:'cash',sourceLabel:null,amountCents:cents('11.02'),
  }));
  assert.equal((await getAccount(db,actor('alice'),a.accountId)).balanceCents,1102);
}));

test('actual paid expense can yield negative real balance; no imaginary obligation',()=>run(async db=>{
  const a=await wallet(db);
  await postMovement(db,actor('alice'),make(a.accountId,'negative',{
    direction:'expense',amountCents:cents('40'),sourceLabel:null,
  }));
  assert.equal((await getAccount(db,actor('alice'),a.accountId)).balanceCents,-4000);
}));

test('composite tenant foreign key blocks posting to a foreign account',()=>run(async db=>{
  const a=await wallet(db,'alice','100');
  await wallet(db,'bob');
  await assert.rejects(()=>postMovement(db,actor('bob'),make(a.accountId,'foreign')),/FOREIGN KEY/);
  assert.equal((await getAccount(db,actor('alice'),a.accountId)).balanceCents,10000);
  assert.deepEqual(await listMovements(db,actor('bob')),[]);
}));

test('retries are idempotent and conflicting reused keys cannot alter money',()=>run(async db=>{
  const a=await wallet(db);
  const req=make(a.accountId,'replay');
  const x=await postMovement(db,actor('alice'),req);
  const y=await postMovement(db,actor('alice'),req);
  assert.equal(x.movementId,y.movementId);
  await assert.rejects(()=>postMovement(db,actor('alice'),{...req,amountCents:cents('90')}),/Idempotency conflict/);
  assert.equal((await getAccount(db,actor('alice'),a.accountId)).balanceCents,3001);
}));

test('two simultaneous same-key posts become exactly one receipt',()=>run(async db=>{
  const a=await wallet(db),p=make(a.accountId,'concurrency');
  const [x,y]=await Promise.all([postMovement(db,actor('alice'),p),postMovement(db,actor('alice'),p)]);
  assert.equal(x.movementId,y.movementId);
  assert.equal((await listMovements(db,actor('alice'))).length,1);
}));

test('idempotency key scope is per authenticated user',()=>run(async db=>{
  const a=await wallet(db,'alice'),b=await wallet(db,'bob');
  const x=await postMovement(db,actor('alice'),make(a.accountId,'shared'));
  const y=await postMovement(db,actor('bob'),make(b.accountId,'shared'));
  assert.notEqual(x.movementId,y.movementId);
}));

test('timeline pagination and account filter never return a foreign tenant row',()=>run(async db=>{
  const a=await wallet(db,'alice'),b=await wallet(db,'bob');
  await postMovement(db,actor('bob'),make(b.accountId,'foreign-movement'));
  await postMovement(db,actor('alice'),make(a.accountId,'old',{occurredOn:'2026-11-09'}));
  await postMovement(db,actor('alice'),make(a.accountId,'new',{occurredOn:'2026-11-10'}));
  assert.deepEqual((await listMovements(db,actor('alice'))).map(x=>x.occurredOn),['2026-11-10','2026-11-09']);
  assert.equal((await listMovements(db,actor('alice'),{offset:1,limit:1})).length,1);
  assert.deepEqual(await listMovements(db,actor('alice'),{accountId:b.accountId}),[]);
  assert.equal(await getMovement(db,actor('bob'),(await listMovements(db,actor('alice')))[0].movementId),null);
}));

test('dates reject nonexistent days and tolerate leap years',()=>run(async db=>{
  const a=await wallet(db);
  for(const d of ['2026-02-29','2026-04-31','2026-13-01','2026-11-00','2026-11-10T14:00Z']){
    await assert.rejects(()=>postMovement(db,actor('alice'),make(a.accountId,'invalid-calendar',{occurredOn:d})),/occurredOn/);
  }
  const leap=await postMovement(db,actor('alice'),make(a.accountId,'leap',{occurredOn:'2024-02-29'}));
  assert.equal(leap.occurredOn,'2024-02-29');
}));

test('zero, negative, fractional, oversized and invalid pagination are rejected',()=>run(async db=>{
  const a=await wallet(db);
  for(const v of [0,-1,1.5,9007199254740991]){
    await assert.rejects(()=>postMovement(db,actor('alice'),make(a.accountId,'invalid-amount',{amountCents:v})));
  }
  for(const filter of [{limit:101},{limit:0},{offset:-1},{offset:1.2},{accountId:'forged'}]){
    await assert.rejects(()=>listMovements(db,actor('alice'),filter));
  }
  assert.equal((await listMovements(db,actor('alice'))).length,0);
}));

test('SQL injection text is data, not an executable statement',()=>run(async db=>{
  const a=await wallet(db);
  const label="Food'); DROP TABLE financial_accounts; --";
  const r=await postMovement(db,actor('alice'),make(a.accountId,'sql-text',{description:label,category:"x';--"}));
  assert.equal(r.description,label);
  assert.equal((await listAccounts(db,actor('alice'))).length,1);
}));

test('opening reallocations observe expenses posted after starting balance',()=>run(async db=>{
  const a=await wallet(db,'alice','100');
  await postMovement(db,actor('alice'),make(a.accountId,'paid',{
    direction:'expense',amountCents:cents('80'),sourceLabel:null,
  }));
  const funding=amount=>({mode:'reallocate',cents:cents(amount),fromAccountId:a.accountId});
  await assert.rejects(()=>createAccount(db,actor('alice'),{idempotencyKey:key('overdraw'),name:'Bank A',kind:'bank',funding:funding('30')}));
  const b=await createAccount(db,actor('alice'),{idempotencyKey:key('valid'),name:'Bank B',kind:'bank',funding:funding('15')});
  assert.equal(b.balanceCents,1500);
  assert.equal((await getAccount(db,actor('alice'),a.accountId)).balanceCents,500);
  assert.equal((await listAccounts(db,actor('alice'))).reduce((v,r)=>v+r.balanceCents,0),2000);
}));

const base='http://127.0.0.1:8787',time=Date.parse('2026-11-10T14:00:00Z');
const lookup=async h=>{
  const who=h.get('cookie')==='session=alice'?'alice':h.get('cookie')==='session=bob'?'bob':null;
  return who?{user:{id:who},session:{userId:who,expiresAt:new Date(time+60000)}}:null;
};
const req=(path,cookie,body,origin=base)=>new Request(base+path,{
  method:body===undefined?'GET':'POST',
  headers:{cookie,origin,'content-type':'application/json','x-user-id':'bob'},
  body:body===undefined?undefined:JSON.stringify(body),
});
async function call(db,r){const result=await handleFinancialHttp(r,db,lookup,base,()=>time);return {status:result.status,body:await result.json()};}
const accountBody={idempotencyKey:key('create-account'),name:'Wallet',kind:'general',funding:{mode:'external',amount:'0.00'}};
const posted=id=>({idempotencyKey:key('via-http'),accountId:id,direction:'income',amount:'27.25',method:'pix',description:'Payment received',occurredOn:'2026-11-10',ownerId:'bob'});

test('HTTP authenticated receipts and expenses update account view with strict tenant isolation',()=>run(async db=>{
  assert.equal((await call(db,req('/api/movements','',{}))).status,401);
  const c=await call(db,req('/api/accounts','session=alice',accountBody));
  assert.equal(c.status,201);
  const id=c.body.account.accountId;
  const income=await call(db,req('/api/movements','session=alice',posted(id)));
  assert.equal(income.status,201);
  assert.equal((await call(db,req('/api/movements/'+income.body.movement.movementId,'session=bob'))).status,404);
  assert.equal((await call(db,req('/api/movements?accountId='+id,'session=bob'))).body.movements.length,0);
  const expense=await call(db,req('/api/movements','session=alice',{...posted(id),idempotencyKey:key('expense-http'),direction:'expense',method:'debit',amount:'7.05'}));
  assert.equal(expense.status,201);
  assert.equal((await call(db,req('/api/accounts/'+id,'session=alice'))).body.account.balanceCents,2020);
  assert.equal((await call(db,req('/api/movements','session=alice'))).body.movements.length,2);
  assert.equal((await call(db,req('/api/movements','session=bob'))).body.movements.length,0);
}));

test('HTTP rejects cross-origin posting and foreign account links without disclosing internals',()=>run(async db=>{
  const c=await call(db,req('/api/accounts','session=alice',accountBody));
  const id=c.body.account.accountId;
  assert.equal((await call(db,req('/api/movements','session=alice',posted(id),'https://evil.example'))).status,403);
  const bad=await call(db,req('/api/movements','session=bob',posted(id)));
  assert.deepEqual(bad,{status:409,body:{error:'OPERATION_REJECTED'}});
  assert.equal((await call(db,req('/api/movements','session=alice',{...posted(id),amount:'12.345'}))).status,400);
}));

test('HTTP repeated requests do not credit money twice; mismatch is rejected',()=>run(async db=>{
  const c=await call(db,req('/api/accounts','session=alice',accountBody));
  const id=c.body.account.accountId;
  const data=posted(id);
  const x=await call(db,req('/api/movements','session=alice',data));
  const y=await call(db,req('/api/movements','session=alice',data));
  assert.equal(x.body.movement.movementId,y.body.movement.movementId);
  assert.deepEqual(await call(db,req('/api/movements','session=alice',{...data,amount:'28.00'})),{
    status:409,body:{error:'OPERATION_REJECTED'},
  });
  assert.equal((await call(db,req('/api/accounts/'+id,'session=alice'))).body.account.balanceCents,2725);
}));
