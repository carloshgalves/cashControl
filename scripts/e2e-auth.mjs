// Disposable local Wrangler/D1 integration only. Never prints secrets or cookies.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:8787';
const origin = new URL(base).origin;
const nonce = randomUUID().slice(0, 8);
const passwordA = 'Aa!-'+randomUUID().replaceAll('-','').slice(0,22);
const passwordB = 'Bb!-'+randomUUID().replaceAll('-','').slice(0,22);
const headers = { origin, 'content-type': 'application/json' };
async function request(path, { method='GET', body, cookie, originOverride }={}) {
  const opts={method,headers:{...headers}};
  if(cookie) opts.headers.cookie=cookie;
  if(originOverride) opts.headers.origin=originOverride;
  if(body!==undefined) opts.body=JSON.stringify(body);
  const response=await fetch(new URL(path,base),opts);
  const data=await response.json().catch(()=>null);
  const setCookies=response.headers.getSetCookie?.()??[];
  return {status:response.status,code:data?.code??data?.error??null,data,cookie:setCookies.map(c=>c.split(';',1)[0]).filter(Boolean).join('; ')};
}
function status(result,expected,step) {
  assert.equal(result.status,expected,`${step}: HTTP ${result.status}, code ${result.code}`);
}
async function main(){
  let ready=false;
  for(let i=0;i<60;i++){try{if((await request('/api/accounts')).status===401){ready=true;break;}}catch{}await sleep(1000);}
  assert(ready,'Local Worker not ready or unauthorized route not returning 401');
  const alice='alice-'+nonce+'@example.test',bob='bob-'+nonce+'@example.test';
  for(const [email,password,name] of [[alice,passwordA,'Alice'],[bob,passwordB,'Bob']]){
    status(await request('/api/auth/sign-up/email',{method:'POST',body:{email,password,name}}),200,'signup '+name);
  }
  const a=await request('/api/auth/sign-in/email',{method:'POST',body:{email:alice,password:passwordA}});
  const b=await request('/api/auth/sign-in/email',{method:'POST',body:{email:bob,password:passwordB}});
  status(a,200,'signin A');status(b,200,'signin B');
  assert(a.cookie&&b.cookie&&a.cookie!==b.cookie,'Users must have distinct cookies');
  status(await request('/api/accounts',{cookie:'better-auth.session_token=forged'}),401,'forged session');
  status(await request('/api/accounts',{cookie:a.cookie}),200,'A session');
  const p={idempotencyKey:'account-'+nonce+'-created',name:'Checking',kind:'general',funding:{mode:'external',amount:'123.45'},ownerId:'bob'};
  const created=await request('/api/accounts',{method:'POST',cookie:a.cookie,body:p});
  status(created,201,'create A account');
  assert(created.data?.account?.accountId,'Account ID missing');
  const id=created.data.account.accountId;
  status(await request('/api/accounts/'+id,{cookie:a.cookie}),200,'A own detail');
  const bl=await request('/api/accounts',{cookie:b.cookie});status(bl,200,'B list');
  assert.equal(bl.data.accounts.length,0,'B can list A account');
  status(await request('/api/accounts/'+id,{cookie:b.cookie}),404,'B must not see A account');
  status(await request('/api/accounts',{method:'POST',cookie:a.cookie,body:p,originOverride:'https://evil.invalid'}),403,'cross-origin POST');
  const incomeBody={
    idempotencyKey:'income-'+nonce+'-posted',accountId:id,direction:'income',amount:'37.51',
    method:'pix',description:'Pagamento recebido',sourceLabel:'Trabalho avulso',
    occurredOn:'2026-11-10',ownerId:'bob',
  };
  const earned=await request('/api/movements',{method:'POST',cookie:a.cookie,body:incomeBody});
  status(earned,201,'A posts income');
  const earnedRetry=await request('/api/movements',{method:'POST',cookie:a.cookie,body:incomeBody});
  status(earnedRetry,201,'A idempotent income retry');
  assert.equal(earned.data.movement.movementId,earnedRetry.data.movement.movementId,'Duplicate cash entry');
  const spent=await request('/api/movements',{method:'POST',cookie:a.cookie,body:{
    ...incomeBody,idempotencyKey:'expense-'+nonce+'-posted',direction:'expense',
    amount:'10.06',method:'debit',description:'Despesa paga',sourceLabel:null,
  }});
  status(spent,201,'A posts expense');
  const newBalance=await request('/api/accounts/'+id,{cookie:a.cookie});
  status(newBalance,200,'A account after cash movements');
  assert.equal(newBalance.data.account.balanceCents,15090,'Balance must include exact cash flow');
  const timeline=await request('/api/movements',{cookie:a.cookie});
  status(timeline,200,'A movement history');
  assert.equal(timeline.data.movements.length,2,'Missing or duplicate movements');
  status(await request('/api/movements/'+earned.data.movement.movementId,{cookie:b.cookie}),404,'B cannot read A movement');
  const bobTimeline=await request('/api/movements',{cookie:b.cookie});
  status(bobTimeline,200,'B own movement timeline');
  assert.equal(bobTimeline.data.movements.length,0,'B saw A history');
  const foreignWrite=await request('/api/movements',{method:'POST',cookie:b.cookie,body:{
    ...incomeBody,idempotencyKey:'foreign-'+nonce+'-attempt',
  }});
  assert.equal(foreignWrite.status,409,'B must not post to A account');
  status(await request('/api/movements',{method:'POST',cookie:a.cookie,body:incomeBody,originOverride:'https://evil.invalid'}),403,'cross-origin cash posting');
  const obligationData={
    idempotencyKey:'bill-'+nonce+'-internet',title:'Internet',
    amount:'75.00',dueOn:'2026-11-25',category:'Internet',ownerId:'bob',
  };
  const newBill=await request('/api/obligations',{method:'POST',cookie:a.cookie,body:obligationData});
  status(newBill,201,'A creates future obligation');
  const billId=newBill.data.obligation.obligationId;
  assert.equal(newBill.data.obligation.outstandingCents,7500);
  assert.equal(newBill.data.obligation.paidCents,0);
  assert.equal(newBill.data.obligation.state,'open');
  const beforePayment=await request('/api/accounts/'+id,{cookie:a.cookie});
  assert.equal(beforePayment.data.account.balanceCents,15090,'Creating a bill must not reduce bank cash');
  status(await request('/api/obligations/'+billId,{cookie:b.cookie}),404,'B cannot read A bill');
  const part={idempotencyKey:'bill-payment-'+nonce+'-part',accountId:id,amount:'25.50',method:'pix',paidOn:'2026-11-10'};
  const paid=await request('/api/obligations/'+billId+'/payments',{method:'POST',cookie:a.cookie,body:part});
  status(paid,201,'A makes partial payment');
  const retried=await request('/api/obligations/'+billId+'/payments',{method:'POST',cookie:a.cookie,body:part});
  status(retried,201,'A payment replay');
  assert.equal(paid.data.payment.paymentId,retried.data.payment.paymentId,'Duplicate financial payment');
  const partial=await request('/api/obligations/'+billId,{cookie:a.cookie});
  assert.equal(partial.data.obligation.state,'partially_paid');
  assert.equal(partial.data.obligation.outstandingCents,4950);
  const balancePart=await request('/api/accounts/'+id,{cookie:a.cookie});
  assert.equal(balancePart.data.account.balanceCents,12540);
  const notAuthorized=await request('/api/obligations/'+billId+'/payments',{method:'POST',cookie:b.cookie,body:part});
  assert.equal(notAuthorized.status,409,'B must not pay A bill');
  status(await request('/api/obligations/'+billId+'/payments',{cookie:b.cookie}),404,'B cannot inspect A payments');
  const overpay=await request('/api/obligations/'+billId+'/payments',{method:'POST',cookie:a.cookie,body:{
    ...part,idempotencyKey:'bill-payment-'+nonce+'-over',amount:'49.51',
  }});
  assert.equal(overpay.status,409,'Overpayment should be rejected');
  const second=await request('/api/obligations/'+billId+'/payments',{method:'POST',cookie:a.cookie,body:{
    ...part,idempotencyKey:'bill-payment-'+nonce+'-final',amount:'49.50',method:'debit',
  }});
  status(second,201,'A pays remainder');
  const fully=await request('/api/obligations/'+billId,{cookie:a.cookie});
  assert.equal(fully.data.obligation.state,'paid');
  assert.equal(fully.data.obligation.outstandingCents,0);
  const after=await request('/api/accounts/'+id,{cookie:a.cookie});
  assert.equal(after.data.account.balanceCents,7590,'Bill settlement debited twice or not enough');
  const movements=await request('/api/movements',{cookie:a.cookie});
  assert.equal(movements.data.movements.length,4,'Exactly two original and two payment movements expected');
  console.log('OBLIGATIONS_E2E_PASS: real Better Auth sessions, no upfront cash debit, partial/final payment, tenant isolation, rollback and idempotency');
  status(await request('/api/auth/sign-out',{method:'POST',cookie:a.cookie,body:{}}),200,'signout A');
  status(await request('/api/accounts',{cookie:a.cookie}),401,'A cookie revoked');
  status(await request('/api/accounts',{cookie:b.cookie}),200,'B session unaffected');
  console.log('FINANCE_E2E_PASS: 2 real sessions, exact cash totals, idempotency, isolation, CSRF, logout revocation');
}
main().catch(e=>{console.error('AUTH_E2E_FAIL:',e.message);process.exitCode=1;});
