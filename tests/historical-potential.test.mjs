import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createAccount,getAccount} from '../src/backend/accounts/accounts.ts';
import {postMovement} from '../src/backend/movements/movements.ts';
import {getDashboard} from '../src/backend/dashboard/dashboard.ts';
import {createSource,createManualExpectation,linkIncomeReceipt,changeExpectation} from '../src/backend/income/income.ts';
import {estimatePotential,PotentialNotApplicable} from '../src/backend/planning/historical-potential.ts';
import {handleFinancialHttp} from '../src/backend/http/accounts-handler.ts';
class Stmt{
 constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args;}
 bind(...args){return new Stmt(this.db,this.sql,args);}
 async first(){return this.db.prepare(this.sql).get(...this.args)??null;}
 async all(){return {results:this.db.prepare(this.sql).all(...this.args)};}
 async run(){return this.db.prepare(this.sql).run(...this.args);}
}
class Db{
 constructor(){this.raw=new DatabaseSync(':memory:');this.raw.exec('PRAGMA foreign_keys=ON');
  const dir=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(dir).filter(n=>/^\d{4}_.+\.sql$/.test(n)).sort())this.raw.exec(readFileSync(new URL(name,dir),'utf8'));
  this.queue=Promise.resolve();}
 prepare(s){return new Stmt(this.raw,s);}
 batch(statements){const tx=async()=>{this.raw.exec('BEGIN IMMEDIATE');try{const out=[];for(const s of statements)out.push(await s.run());this.raw.exec('COMMIT');return out;}catch(e){this.raw.exec('ROLLBACK');throw e;}};
  const op=this.queue.then(tx);this.queue=op.catch(()=>{});return op;}
 close(){this.raw.close();}
}
const actor=userId=>({userId});
const key=s=>'f3-regression-key-'+s;
const now=()=>new Date('2026-11-23T12:00:00Z');
const params={asOf:'2026-11-23',from:'2026-11-23',to:'2026-12-13',include:true};
const day=(n)=>new Date(Date.UTC(2026,7,31)+n*86400000).toISOString().slice(0,10);
async function fixture(db,user='alice',kind='variable'){
 const who=actor(user);
 const wallet=await createAccount(db,who,{idempotencyKey:key('wallet-'+user),name:'Saldo '+user,
  kind:'general',funding:{mode:'external',cents:100000}},now);
 const source=await createSource(db,who,{idempotencyKey:key('source-'+user),name:'Freelas',
  relationship:'freelance',payKind:kind,periodicity:'none'},now);
 return {wallet,source,who};
}
async function receipt(db,ctx,week,j=0,amount=1000,tag='history'){
 const date=day(week*7+1+j);
 const exp=await createManualExpectation(db,ctx.who,ctx.source.sourceId,{
  idempotencyKey:key(tag+'-exp-'+week+'-'+j),expectedOn:date,amountCents:amount},now);
 const mov=await postMovement(db,ctx.who,{idempotencyKey:key(tag+'-cash-'+week+'-'+j),
  accountId:ctx.wallet.accountId,direction:'income',amountCents:amount,method:'pix',description:'Trabalho eventual',occurredOn:date},now);
 await linkIncomeReceipt(db,ctx.who,ctx.source.sourceId,exp,{
  idempotencyKey:key(tag+'-link-'+week+'-'+j),movementId:mov.movementId},now);
 return mov;
}
async function withDb(fn){const db=new Db();try{return await fn(db);}finally{db.close();}}
test('F3 P25 explicit forecast deducted per full week; zero weeks, three tasks, canceled expectation, no cash change',()=>withDb(async db=>{
 const a=await fixture(db);
 for(let w=0;w<12;w++)if(w!==2&&w!==9)await receipt(db,a,w);
 await receipt(db,a,8,1,500,'extra');
 await receipt(db,a,8,2,500,'extra');
 const cancelDate=day(2*7+1);
 const cancel=await createManualExpectation(db,a.who,a.source.sourceId,{
  idempotencyKey:key('cancel-exp'),expectedOn:cancelDate,amountCents:2000},now);
 await changeExpectation(db,a.who,a.source.sourceId,cancel,{idempotencyKey:key('cancel-action'),state:'canceled',reason:'Serviço cancelado'},now);
 const next=await createManualExpectation(db,a.who,a.source.sourceId,{
  idempotencyKey:key('future-expected'),expectedOn:'2026-11-24',amountCents:1000},now);
 const less=await createManualExpectation(db,a.who,a.source.sourceId,{
  idempotencyKey:key('future-second'),expectedOn:'2026-12-01',amountCents:400},now);
 const original=await getDashboard(db,a.who,{from:'2026-11-01',to:'2026-12-31'});
 const result=await estimatePotential(db,a.who,{...params,sourceId:a.source.sourceId},now);
 assert.deepEqual([result.status,result.observedWeeks,result.positiveWeeks,result.zeroWeeks,result.canceledExpectations],['estimated',12,10,2,1]);
 assert.equal(result.p25WeeklyCents,1000);
 assert.deepEqual(result.weekly.map(x=>x.explicitExpectedCents),[1000,400,0]);
 assert.deepEqual(result.weekly.map(x=>x.potentialAdditionalCents),[0,600,1000]);
 assert.equal(result.potentialAdditionalCents,1600);
 assert.deepEqual(await getDashboard(db,a.who,{from:'2026-11-01',to:'2026-12-31'}),original);
 assert.equal((await getAccount(db,a.who,a.wallet.accountId)).balanceCents,original.balances.totalCents);
}));
test('F3 sparse history and entire absent month => insufficient, never fabricated income',()=>withDb(async db=>{
 const a=await fixture(db);
 await receipt(db,a,0);await receipt(db,a,7,0,2000);await receipt(db,a,11,0,3000);
 const r=await estimatePotential(db,a.who,{...params,sourceId:a.source.sourceId},now);
 assert.deepEqual([r.status,r.positiveWeeks,r.zeroWeeks,r.p25WeeklyCents,r.potentialAdditionalCents],
  ['insufficient',3,9,0,0]);
 assert.deepEqual(r.weekly.map(x=>x.potentialAdditionalCents),[0,0,0]);
}));
test('F3 opt-out no source access, A/B tenant isolation and mixed/fixed excluded',()=>withDb(async db=>{
 const a=await fixture(db),b=await fixture(db,'bob'),fixed=await fixture(db,'fred','fixed');
 const off=await estimatePotential(db,a.who,{...params,include:false,sourceId:''},now);
 assert.equal(off.status,'disabled');
 await assert.rejects(()=>estimatePotential(db,b.who,{...params,sourceId:a.source.sourceId},now),PotentialNotApplicable);
 await assert.rejects(()=>estimatePotential(db,fixed.who,{...params,sourceId:fixed.source.sourceId},now),PotentialNotApplicable);
}));
test('F3 reject future asOf, excessive horizon, malformed dates, opt-in absent source',()=>withDb(async db=>{
 const a=await fixture(db);
 for(const patch of [{asOf:'2026-11-24'},{to:'2027-10-10'},{from:'2026-11-31'},{sourceId:'nope'},{from:'2026-11-01'}]){
  await assert.rejects(()=>estimatePotential(db,a.who,{...params,sourceId:a.source.sourceId,...patch},now));
 }
}));
test('F3 endpoint authenticated and read-only; forged owner ignored; foreign source 404',()=>withDb(async db=>{
 const a=await fixture(db),b=await fixture(db,'bob');
 const base='http://127.0.0.1:8787',clock=()=>now().getTime();
 const lookup=async headers=>{const id=headers.get('cookie')==='session=a'?'alice':headers.get('cookie')==='session=b'?'bob':null;
  return id?{user:{id},session:{userId:id,expiresAt:new Date(clock()+3600000)}}:null;};
 const call=async(who,body,origin=base)=>{
  const req=new Request(base+'/api/planning/potential',{method:'POST',headers:{cookie:'session='+who,origin,'content-type':'application/json'},
   body:JSON.stringify(body)});
  const r=await handleFinancialHttp(req,db,lookup,base,clock);
  return {status:r.status,data:await r.json()};
 };
 const input={...params,sourceId:a.source.sourceId};
 assert.equal((await call('a',input)).status,200);
 assert.equal((await call('b',input)).status,404);
 assert.equal((await call('bad',input)).status,401);
 assert.equal((await call('a',input,'http://evil.invalid')).status,403);
 assert.equal((await call('a',{...input,ownerUserId:'bob'})).status,400);
 assert.equal((await call('a',{...input,include:false,sourceId:''})).data.potential.status,'disabled');
}));
