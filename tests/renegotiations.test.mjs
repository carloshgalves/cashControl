import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createAccount,getAccount} from '../src/backend/accounts/accounts.ts';
import {createCard,createPurchase,getInvoice} from '../src/backend/cards/cards.ts';
import {payInvoice} from '../src/backend/cards/invoice-payments.ts';
import {createObligation,payObligation,getObligation} from '../src/backend/obligations/obligations.ts';
import {getDashboard} from '../src/backend/dashboard/dashboard.ts';
import {getPlanningSummary} from '../src/backend/planning/intentions.ts';
import {simulatePlanning} from '../src/backend/planning/scenarios.ts';
import {listTimeline,listDueAlerts} from '../src/backend/timeline/timeline.ts';
import {makeReport} from '../src/backend/reports/report.ts';
import {createRenegotiation,getRenegotiation,payRenegotiation,listRenegotiationPayments,DebtRenegotiationConflict} from '../src/backend/renegotiations/renegotiations.ts';
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
  for(const file of readdirSync(dir).filter(x=>/^\d{4}_.+\.sql$/.test(x)).sort())
   this.raw.exec(readFileSync(new URL(file,dir),'utf8'));
  this.queue=Promise.resolve();}
 prepare(sql){return new Stmt(this.raw,sql);}
 batch(statements){const tx=async()=>{this.raw.exec('BEGIN IMMEDIATE');try{
  const out=[];for(const s of statements)out.push(await s.run());this.raw.exec('COMMIT');return out;
 }catch(e){this.raw.exec('ROLLBACK');throw e;}};
 const r=this.queue.then(tx);this.queue=r.catch(()=>{});return r;}
 close(){this.raw.close();}
}
const actor=userId=>({userId}),key=s=>'g2-renegotiation-'+s,now=()=>new Date('2026-11-20T12:00:00Z');
const at={from:'2026-11-01',to:'2027-02-28',asOf:'2026-11-20'};
const plan=[{dueOn:'2026-12-10',amountCents:23000},{dueOn:'2027-01-10',amountCents:23000},{dueOn:'2027-02-10',amountCents:23000}];
async function dbTest(fn){const db=new Db();try{return await fn(db);}finally{db.close();}}
async function fixture(db,user='alice'){
 const who=actor(user);
 const account=await createAccount(db,who,{idempotencyKey:key('account-'+user),name:'Conta '+user,kind:'general',funding:{mode:'external',cents:200000}},now);
 const card=await createCard(db,who,{idempotencyKey:key('card-'+user),name:'Cartão '+user,institution:null,limitCents:300000,closingDay:25,dueDay:5},now);
 await createPurchase(db,who,{idempotencyKey:key('buy-'+user),cardId:card.cardId,title:'Compra 1500',purchasedOn:'2026-11-19',totalCents:150000,installments:1},now);
 await payInvoice(db,who,{idempotencyKey:key('already-'+user),cardId:card.cardId,cycle:'2026-11',
  accountId:account.accountId,amountCents:90000,method:'pix',paidOn:'2026-11-20'},now);
 return {who,account,card};
}
const agreement=f=>({idempotencyKey:key('agreement'),
 subject:{kind:'card_invoice',cardId:f.card.cardId,cycle:'2026-11'},expectedOutstandingCents:60000,
 feesCents:9000,agreedOn:'2026-11-20',installments:plan});
const payment=(f,a,i,tag,amount=23000)=>({idempotencyKey:key('agreement-payment-'+tag),agreementId:a.agreementId,
 installmentNo:i,accountId:f.account.accountId,amountCents:amount,method:'pix',paidOn:'2026-12-10'});
test('G2 invoice 1500 paid 900 + documented fee 90 => three 230 installments, no double principal',()=>dbTest(async db=>{
 const f=await fixture(db);
 const before=await getDashboard(db,f.who,at);
 assert.equal(before.cardInvoices.outstandingCents,60000);
 assert.equal(before.cashFlow.expensesCents,90000);
 const a=await createRenegotiation(db,f.who,agreement(f),now);
 assert.deepEqual([a.originalRemainingCents,a.feesCents,a.newTotalCents,a.outstandingCents],[60000,9000,69000,69000]);
 assert.deepEqual(a.installments.map(x=>x.totalCents),[23000,23000,23000]);
 const after=await getDashboard(db,f.who,at);
 assert.equal(after.cardInvoices.outstandingCents,69000);
 assert.equal(after.cashFlow.expensesCents,90000,'agreeing on debt does not debit account');
 assert.equal(after.balances.totalCents,110000);
 assert.equal((await getPlanningSummary(db,f.who)).cardInvoicesCents,69000);
 const sim=await simulatePlanning(db,f.who,{from:'2026-11-20',to:'2027-02-28'});
 assert.equal(sim.existingOutstandingCardInvoicesCents,69000);
 const due=await listTimeline(db,f.who,at);
 assert.equal(due.events.filter(x=>x.kind==='obligation').reduce((sum,x)=>sum+x.amountCents,0),69000);
 assert.equal(due.events.filter(x=>x.kind==='payment').length,1,'old payment preserved once');
 assert.ok((await makeReport(db,f.who,{...at,status:'all',format:'xlsx'})).bytes.length>0);
 assert.equal((await getInvoice(db,f.who,f.card.cardId,'2026-11')).invoice.outstandingCents,60000,'historical invoice remains intact');
 const first=await payRenegotiation(db,f.who,payment(f,a,1,'one'),now);
 assert.equal(first.amountCents,23000);
 assert.equal((await getAccount(db,f.who,f.account.accountId)).balanceCents,87000);
 assert.equal((await getDashboard(db,f.who,at)).cashFlow.expensesCents,113000);
 for(let i=2;i<=3;i++)await payRenegotiation(db,f.who,payment(f,a,i,'two-'+i),now);
 const final=await getRenegotiation(db,f.who,a.agreementId);
 assert.deepEqual([final.outstandingCents,final.state], [0,'paid']);
 assert.equal((await getDashboard(db,f.who,at)).cardInvoices.outstandingCents,0);
 assert.equal((await getDashboard(db,f.who,at)).cashFlow.expensesCents,159000);
 assert.equal((await listRenegotiationPayments(db,f.who,a.agreementId)).length,3);
 assert.equal((await listTimeline(db,f.who,at)).events.filter(x=>x.kind==='payment').length,4);
}));
test('G2 ordinary partially paid obligation becomes new schedule without losing history',()=>dbTest(async db=>{
 const f=await fixture(db),bill=await createObligation(db,f.who,{idempotencyKey:key('old-bill'),title:'Dívida antiga',totalCents:100000,dueOn:'2026-11-25'},now);
 await payObligation(db,f.who,{idempotencyKey:key('partial-old'),obligationId:bill.obligationId,
  accountId:f.account.accountId,amountCents:40000,method:'pix',paidOn:'2026-11-20'},now);
 const a=await createRenegotiation(db,f.who,{idempotencyKey:key('ordinary-agreement'),
  subject:{kind:'obligation',obligationId:bill.obligationId},expectedOutstandingCents:60000,
  feesCents:9000,agreedOn:'2026-11-20',installments:plan},now);
 assert.equal((await getObligation(db,f.who,bill.obligationId)).outstandingCents,60000);
 assert.equal((await getPlanningSummary(db,f.who)).obligationsCents,69000);
 await assert.rejects(()=>payObligation(db,f.who,{idempotencyKey:key('late-original'),obligationId:bill.obligationId,
  accountId:f.account.accountId,amountCents:100,method:'pix',paidOn:'2026-11-25'},now));
 assert.throws(()=>db.raw.prepare("INSERT INTO obligation_cancellations(owner_user_id,cancellation_id,creation_key,obligation_id,canceled_on,created_at) VALUES(?,?,?,?,?,?)")
  .run('alice',crypto.randomUUID(),key('cancel-later'),bill.obligationId,'2026-11-26',now().toISOString()));
 assert.equal((await getRenegotiation(db,f.who,a.agreementId)).outstandingCents,69000);
}));
test('G2 SQL forbids obsolete invoice payments and new installments after agreement',()=>dbTest(async db=>{
 const f=await fixture(db),a=await createRenegotiation(db,f.who,agreement(f),now);
 await assert.rejects(()=>payInvoice(db,f.who,{idempotencyKey:key('obsolete-pay'),cardId:f.card.cardId,cycle:'2026-11',
  accountId:f.account.accountId,amountCents:5000,method:'pix',paidOn:'2026-11-23'},now));
 assert.equal((await getInvoice(db,f.who,f.card.cardId,'2026-11')).invoice.outstandingCents,60000);
 assert.equal((await getRenegotiation(db,f.who,a.agreementId)).outstandingCents,69000);
 assert.throws(()=>db.raw.prepare("UPDATE debt_renegotiations SET fees_cents=0").run(),/RENEGOTIATION_IMMUTABLE/);
 assert.throws(()=>db.raw.prepare("DELETE FROM debt_renegotiations").run(),/RENEGOTIATION_IMMUTABLE/);
}));
test('G2 idempotent retry, stale remaining and concurrent installment overpayment rollback',()=>dbTest(async db=>{
 const f=await fixture(db),v=agreement(f);
 const [first,again]=await Promise.all([createRenegotiation(db,f.who,v,now),createRenegotiation(db,f.who,v,now)]);
 assert.equal(first.agreementId,again.agreementId);
 await assert.rejects(()=>createRenegotiation(db,f.who,{...v,feesCents:0},now),DebtRenegotiationConflict);
 const one=payment(f,first,1,'replay',10000);
 const a=await payRenegotiation(db,f.who,one,now),b=await payRenegotiation(db,f.who,one,now);
 assert.equal(a.paymentId,b.paymentId);
 await assert.rejects(()=>payRenegotiation(db,f.who,{...one,amountCents:12000},now),DebtRenegotiationConflict);
 const before=db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n;
 const race=await Promise.allSettled([
  payRenegotiation(db,f.who,payment(f,first,1,'race-a',10000),now),
  payRenegotiation(db,f.who,payment(f,first,1,'race-b',10000),now),
 ]);
 assert.equal(race.filter(x=>x.status==='fulfilled').length,1,'only one of two 10000 payments may consume the 13000 remainder');
 assert.equal(race.filter(x=>x.status==='rejected').length,1,'concurrent overpayment must rollback atomically');
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,before+1);
 assert.equal((await getRenegotiation(db,f.who,first.agreementId)).installments[0].outstandingCents,3000);
}));
test('G2 A/B cross-user source and installment isolated',()=>dbTest(async db=>{
 const a=await fixture(db),b=await fixture(db,'bob');
 const ag=await createRenegotiation(db,a.who,agreement(a),now);
 assert.equal(await getRenegotiation(db,b.who,ag.agreementId),null);
 await assert.rejects(()=>payRenegotiation(db,b.who,payment(b,ag,1,'foreign'),now));
 await assert.rejects(()=>createRenegotiation(db,b.who,{...agreement(a),idempotencyKey:key('cross'),subject:{kind:'card_invoice',cardId:a.card.cardId,cycle:'2026-11'}},now));
 assert.equal((await getRenegotiation(db,a.who,ag.agreementId)).outstandingCents,69000);
}));
test('G2 HTTP strict same-origin auth, validation and foreign 404',()=>dbTest(async db=>{
 const a=await fixture(db),b=await fixture(db,'bob'),origin='http://127.0.0.1:8787';
 const lookup=async h=>{const id=h.get('cookie')==='ok=a'?'alice':h.get('cookie')==='ok=b'?'bob':null;
  return id?{user:{id},session:{userId:id,expiresAt:new Date(now().getTime()+3600000)}}:null;};
 const call=async(user,method,path,body,requestOrigin=origin)=>{
  const r=await handleFinancialHttp(new Request(origin+path,{method,headers:{cookie:'ok='+user,origin:requestOrigin,'content-type':'application/json'},
   ...(body===undefined?{}:{body:JSON.stringify(body)})}),db,lookup,origin,()=>now().getTime());
  return {status:r.status,data:await r.json()};
 };
 const payload={idempotencyKey:key('http-agreement'),subject:agreement(a).subject,expectedOutstanding:'600.00',
  fees:'90.00',agreedOn:'2026-11-20',installments:plan.map(x=>({dueOn:x.dueOn,amount:(x.amountCents/100).toFixed(2)}))};
 const created=await call('a','POST','/api/renegotiations',payload);
 assert.equal(created.status,201,JSON.stringify(created));
 const id=created.data.renegotiation.agreementId;
 assert.equal((await call('b','GET','/api/renegotiations/'+id)).status,404);
 assert.equal((await call('b','GET','/api/renegotiations/'+id+'/payments')).status,404);
 assert.equal((await call('b','POST','/api/renegotiations/'+id+'/payments',{
  idempotencyKey:key('cross-pay'),installmentNo:1,accountId:b.account.accountId,
  amount:'1.00',method:'pix',paidOn:'2026-12-10'})).status,404);
 assert.equal((await call('a','POST','/api/renegotiations',payload,'http://untrusted.invalid')).status,403);
 assert.equal((await call('none','GET','/api/renegotiations')).status,401);
 assert.equal((await call('a','POST','/api/renegotiations',{...payload,ownerId:'bob'})).status,400);
 assert.equal((await call('a','GET','/api/renegotiations?unexpected=1')).status,400);
}));
