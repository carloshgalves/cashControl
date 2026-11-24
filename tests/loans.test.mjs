import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createAccount,getAccount} from '../src/backend/accounts/accounts.ts';
import {grantLoan,getLoan,listLoans,receiveLoanRepayment,listLoanRepayments,LoanConflict} from '../src/backend/loans/loans.ts';
import {getDashboard} from '../src/backend/dashboard/dashboard.ts';
import {listTimeline} from '../src/backend/timeline/timeline.ts';
import {makeReport} from '../src/backend/reports/report.ts';
import {handleFinancialHttp} from '../src/backend/http/accounts-handler.ts';
class Stmt{
 constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args;}
 bind(...args){return new Stmt(this.db,this.sql,args);}
 async first(){return this.db.prepare(this.sql).get(...this.args)??null;}
 async all(){return {results:this.db.prepare(this.sql).all(...this.args)};}
 async run(){return this.db.prepare(this.sql).run(...this.args);}
}
class D1{
 constructor(){
  this.raw=new DatabaseSync(':memory:');this.raw.exec('PRAGMA foreign_keys=ON');
  const root=new URL('../migrations/',import.meta.url);
  for(const m of readdirSync(root).filter(x=>/^\d{4}_.+\.sql$/.test(x)).sort()){
    this.raw.exec(readFileSync(new URL(m,root),'utf8'));
  }
  this.queue=Promise.resolve();
 }
 prepare(s){return new Stmt(this.raw,s);}
 batch(stmts){const tx=async()=>{this.raw.exec('BEGIN IMMEDIATE');try{
  const out=[];for(const s of stmts)out.push(await s.run());this.raw.exec('COMMIT');return out;
 }catch(e){this.raw.exec('ROLLBACK');throw e;}};
  const task=this.queue.then(tx);this.queue=task.catch(()=>{});return task;}
 close(){this.raw.close();}
}
const actor=userId=>({userId});
const key=x=>'g1-loan-regression-'+x;
const clock=()=>new Date('2026-11-23T12:00:00.000Z');
const timeline={from:'2026-11-01',to:'2026-12-31',asOf:'2026-12-25'};
const loan=(sourceAccountId,tag='a',props={})=>({
 idempotencyKey:key('grant-'+tag),borrower:'Terceiro',title:'Empréstimo informal',
 sourceAccountId,principalCents:50000,lentOn:'2026-11-23',dueOn:'2026-12-20',...props
});
const repay=(loanId,destinationAccountId,tag='a',props={})=>({
 idempotencyKey:key('return-'+tag),loanId,destinationAccountId,amountCents:25000,
 receivedOn:'2026-12-22',...props
});
async function wallet(db,user='alice',tag='a',cents=100000){
 return createAccount(db,actor(user),{idempotencyKey:key('wallet-'+user+'-'+tag),name:'Carteira',
  kind:'general',funding:{mode:'external',cents}},clock);
}
async function withDB(fn){const db=new D1();try{return await fn(db);}finally{db.close();}}
test('G1 principal R$500 out and two R$250 returns: cash returns, income and expenses stay zero',()=>withDB(async db=>{
 const a=await wallet(db),u=actor('alice');
 const before=await getDashboard(db,u,timeline);
 assert.equal(before.balances.totalCents,100000);
 const l=await grantLoan(db,u,loan(a.accountId),clock);
 assert.equal((await getAccount(db,u,a.accountId)).balanceCents,50000);
 assert.deepEqual([l.principalCents,l.outstandingCents,l.repaidCents,l.state],[50000,50000,0,'open']);
 const afterGrant=await getDashboard(db,u,timeline);
 assert.deepEqual([afterGrant.cashFlow.incomeCents,afterGrant.cashFlow.expensesCents,afterGrant.cashFlow.netCents],[0,0,0]);
 const p=await receiveLoanRepayment(db,u,repay(l.loanId,a.accountId),clock);
 assert.equal(p.amountCents,25000);
 assert.deepEqual([(await getLoan(db,u,l.loanId)).outstandingCents,(await getAccount(db,u,a.accountId)).balanceCents],[25000,75000]);
 await receiveLoanRepayment(db,u,repay(l.loanId,a.accountId,'b'),clock);
 assert.deepEqual([(await getLoan(db,u,l.loanId)).state,(await getAccount(db,u,a.accountId)).balanceCents],['repaid',100000]);
 const final=await getDashboard(db,u,timeline);
 assert.deepEqual([final.cashFlow.incomeCents,final.cashFlow.expensesCents,final.cashFlow.refundsCents,final.cashFlow.netCents],[0,0,0,0]);
 assert.equal((await listLoanRepayments(db,u,l.loanId)).length,2);
 const chron=await listTimeline(db,u,timeline);
 assert.deepEqual(chron.events.filter(e=>e.kind.startsWith('loan_')).map(e=>e.kind).sort(),
 ['loan_disbursement','loan_repayment','loan_repayment']);
 assert.ok((await makeReport(db,u,{...timeline,status:'all',format:'xlsx'})).bytes.length>0);
}));
test('G1 overdue receivable independent from bank balance and owner-scoped timeline',()=>withDB(async db=>{
 const a=await wallet(db),other=await wallet(db,'bob','b'),u=actor('alice');
 const l=await grantLoan(db,u,loan(a.accountId),clock);
 const chron=await listTimeline(db,u,timeline);
 assert.ok(chron.events.some(e=>e.kind==='loan_receivable'&&e.status==='overdue'&&e.amountCents===50000));
 assert.equal((await listLoans(db,actor('bob'))).length,0);
 assert.equal(await getLoan(db,actor('bob'),l.loanId),null);
 assert.deepEqual((await listTimeline(db,actor('bob'),timeline)).events,[]);
 await assert.rejects(()=>receiveLoanRepayment(db,actor('bob'),repay(l.loanId,other.accountId,'foreign')));
 await assert.rejects(()=>receiveLoanRepayment(db,u,repay(l.loanId,other.accountId,'other-account')));
 assert.equal((await getLoan(db,u,l.loanId)).outstandingCents,50000);
}));
test('G1 idempotency and SQL immutable/overpayment guards survive parallel retries',()=>withDB(async db=>{
 const a=await wallet(db),u=actor('alice');
 const v=loan(a.accountId);
 const [first,again]=await Promise.all([grantLoan(db,u,v,clock),grantLoan(db,u,v,clock)]);
 assert.equal(first.loanId,again.loanId);
 assert.equal((await getAccount(db,u,a.accountId)).balanceCents,50000);
 await assert.rejects(()=>grantLoan(db,u,{...v,title:'Outra coisa'},clock),LoanConflict);
 const p=repay(first.loanId,a.accountId);
 const [one,two]=await Promise.all([receiveLoanRepayment(db,u,p,clock),receiveLoanRepayment(db,u,p,clock)]);
 assert.equal(one.repaymentId,two.repaymentId);
 assert.equal((await getAccount(db,u,a.accountId)).balanceCents,75000);
 await assert.rejects(()=>receiveLoanRepayment(db,u,{...p,amountCents:25001},clock),LoanConflict);
 await assert.rejects(()=>receiveLoanRepayment(db,u,repay(first.loanId,a.accountId,'over',{amountCents:25001}),clock));
 assert.equal((await getAccount(db,u,a.accountId)).balanceCents,75000);
 assert.throws(()=>db.raw.prepare('UPDATE personal_loans SET borrower=? WHERE loan_id=?').run('Mutated',first.loanId),/LOAN_IMMUTABLE/);
 assert.throws(()=>db.raw.prepare('DELETE FROM personal_loan_repayments WHERE repayment_id=?').run(one.repaymentId),/LOAN_REPAYMENT_IMMUTABLE/);
}));
test('G1 invalid dates, insufficient cash, foreign principal and no hidden writes',()=>withDB(async db=>{
 const a=await wallet(db),u=actor('alice'),b=await wallet(db,'bob','b');
 for(const bad of [{dueOn:'2026-11-22'},{lentOn:'2026-02-29'},{dueOn:'2026-11-31'}]){
  await assert.rejects(()=>grantLoan(db,u,loan(a.accountId,'date'+JSON.stringify(bad),bad),clock));
 }
 await assert.rejects(()=>grantLoan(db,u,loan(a.accountId,'too-large',{principalCents:100001}),clock));
 await assert.rejects(()=>grantLoan(db,u,loan(b.accountId,'other-account'),clock));
 assert.deepEqual([...(await listLoans(db,u))],[]);
 assert.equal((await getAccount(db,u,a.accountId)).balanceCents,100000);
}));
test('G1 HTTP session, origin, body allowlist, idempotence and foreign 404',()=>withDB(async db=>{
 const a=await wallet(db),b=await wallet(db,'bob','b');
 const origin='http://127.0.0.1:8787';
 const session=async headers=>{
  const userId=headers.get('cookie')==='valid=alice'?'alice':headers.get('cookie')==='valid=bob'?'bob':null;
  return userId?{user:{id:userId},session:{userId,expiresAt:new Date('2026-11-24T12:00:00Z')}}:null;
 };
 const request=async(method,path,user='alice',body=undefined,originHeader=origin)=>{
  const response=await handleFinancialHttp(new Request(origin+path,{method,headers:{
   cookie:'valid='+user,origin:originHeader,'content-type':'application/json',
  },...(body===undefined?{}:{body:JSON.stringify(body)})}),db,session,origin,()=>new Date('2026-11-23T12:00:00Z').getTime());
  return {status:response.status,data:await response.json()};
 };
 const initial=await request('POST','/api/loans','alice',{
  idempotencyKey:key('http-grant'),borrower:'Amigo',title:'Emprestimo',sourceAccountId:a.accountId,
  principal:'500.00',lentOn:'2026-11-23',dueOn:'2026-12-20',
 });
 assert.equal(initial.status,201,JSON.stringify(initial));
 const loanId=initial.data.loan.loanId;
 assert.equal((await request('GET','/api/loans/'+loanId,'bob')).status,404);
 assert.equal((await request('GET','/api/loans/'+loanId+'/repayments','bob')).status,404);
 assert.equal((await request('POST','/api/loans/'+loanId+'/repayments','bob',{
  idempotencyKey:key('bad-repay'),destinationAccountId:b.accountId,amount:'1.00',receivedOn:'2026-12-22'
 })).status,404);
 const ok=await request('POST','/api/loans/'+loanId+'/repayments','alice',{
  idempotencyKey:key('http-repay'),destinationAccountId:a.accountId,amount:'250.00',receivedOn:'2026-12-22'
 });
 assert.equal(ok.status,201,JSON.stringify(ok));
 assert.equal((await request('POST','/api/loans/'+loanId+'/repayments','alice',{
  idempotencyKey:key('http-repay'),destinationAccountId:a.accountId,amount:'250.00',receivedOn:'2026-12-22'
 })).data.repayment.repaymentId,ok.data.repayment.repaymentId);
 assert.equal((await request('POST','/api/loans','alice',{},'https://evil.invalid')).status,403);
 assert.equal((await request('GET','/api/loans','outsider')).status,401);
 assert.equal((await request('POST','/api/loans','alice',{extra:1})).status,400);
 assert.equal((await request('GET','/api/loans?foo=1')).status,400);
}));
