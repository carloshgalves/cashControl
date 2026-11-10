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
  // Real Workerd/D1 race: two distinct 75.00 payments against 100.00 due.
  const raceBill=await request('/api/obligations',{method:'POST',cookie:a.cookie,body:{
    ...obligationData,idempotencyKey:'bill-'+nonce+'-race',amount:'100.00',
  }});
  status(raceBill,201,'race bill created');
  const raceId=raceBill.data.obligation.obligationId;
  const racePath='/api/obligations/'+raceId+'/payments';
  const attempts=await Promise.all([
    request(racePath,{method:'POST',cookie:a.cookie,body:{
      ...part,idempotencyKey:'bill-'+nonce+'-race-a',amount:'75.00',
    }}),
    request(racePath,{method:'POST',cookie:a.cookie,body:{
      ...part,idempotencyKey:'bill-'+nonce+'-race-b',amount:'75.00',
    }}),
  ]);
  assert.deepEqual(attempts.map(x=>x.status).sort(),[201,409],'Distinct concurrent payments cannot overpay');
  const raceState=await request('/api/obligations/'+raceId,{cookie:a.cookie});
  assert.equal(raceState.data.obligation.outstandingCents,2500,'Race changed obligation total');
  assert.equal((await request('/api/accounts/'+id,{cookie:a.cookie})).data.account.balanceCents,90,
    'Rejected concurrent payment must not create an orphan expense');
  const racePayments=await request(racePath,{cookie:a.cookie});
  assert.equal(racePayments.data.payments.length,1,'Only one competing payment may commit');
  console.log('OBLIGATIONS_RACE_PASS: real concurrent D1 batches reject the competing overpayment with no orphan expense');
  console.log('OBLIGATIONS_E2E_PASS: real Better Auth sessions, no upfront cash debit, partial/final payment, tenant isolation, rollback and idempotency');
  // Transfer regression on real Better Auth + local D1 (no external API/provider).
  const bank=await request('/api/accounts',{method:'POST',cookie:a.cookie,body:{
    idempotencyKey:'internal-'+nonce+'-source',name:'Banco',
    kind:'bank',funding:{mode:'external',amount:'100.00'},
  }});
  status(bank,201,'A opens transfer source');
  const cash=await request('/api/accounts',{method:'POST',cookie:a.cookie,body:{
    idempotencyKey:'internal-'+nonce+'-target',name:'Espécie',
    kind:'cash',funding:{mode:'external',amount:'0.00'},
  }});
  status(cash,201,'A opens transfer target');
  const sourceId=bank.data.account.accountId,targetId=cash.data.account.accountId;
  const beforeTransfers=await request('/api/movements',{cookie:a.cookie});
  status(beforeTransfers,200,'income/expense history before transfers');
  const baseMovements=beforeTransfers.data.movements.length;
  const transferData={
    idempotencyKey:'internal-'+nonce+'-first',
    sourceAccountId:sourceId,targetAccountId:targetId,
    amount:'35.60',transferredOn:'2026-11-10',
    note:'Retirada para dinheiro',ownerId:'bob',
  };
  const transferred=await request('/api/transfers',{method:'POST',cookie:a.cookie,body:transferData});
  status(transferred,201,'A creates own transfer');
  const transferRetry=await request('/api/transfers',{method:'POST',cookie:a.cookie,body:transferData});
  status(transferRetry,201,'retry is idempotent');
  assert.equal(transferred.data.transfer.transferId,transferRetry.data.transfer.transferId,'duplicate transfer created');
  assert.equal((await request('/api/accounts/'+sourceId,{cookie:a.cookie})).data.account.balanceCents,6440);
  assert.equal((await request('/api/accounts/'+targetId,{cookie:a.cookie})).data.account.balanceCents,3560);
  assert.equal((await request('/api/movements',{cookie:a.cookie})).data.movements.length,baseMovements,
    'transfer must not become income or expense');
  const filtered=await request('/api/transfers?accountId='+targetId,{cookie:a.cookie});
  status(filtered,200,'transfer filtered by destination');
  assert.equal(filtered.data.transfers.length,1);
  status(await request('/api/transfers/'+transferred.data.transfer.transferId,{cookie:b.cookie}),404,
    'B must not access A internal transfer');
  assert.equal((await request('/api/transfers',{cookie:b.cookie})).data.transfers.length,0);
  status(await request('/api/transfers',{method:'POST',cookie:a.cookie,body:transferData,
    originOverride:'https://evil.invalid'}),403,'cross-origin transfer');
  const bobBank=await request('/api/accounts',{method:'POST',cookie:b.cookie,body:{
    idempotencyKey:'internal-'+nonce+'-bob',name:'Conta B',
    kind:'bank',funding:{mode:'external',amount:'0'},
  }});
  status(bobBank,201,'B opens own account');
  const attack=await request('/api/transfers',{method:'POST',cookie:a.cookie,body:{
    ...transferData,idempotencyKey:'internal-'+nonce+'-foreign',
    targetAccountId:bobBank.data.account.accountId,
  }});
  assert.equal(attack.status,409,'A must not transfer to B account');
  const competitor=await Promise.all([
    request('/api/transfers',{method:'POST',cookie:a.cookie,body:{
      ...transferData,idempotencyKey:'internal-'+nonce+'-race-a',amount:'50.00',
    }}),
    request('/api/transfers',{method:'POST',cookie:a.cookie,body:{
      ...transferData,idempotencyKey:'internal-'+nonce+'-race-b',amount:'50.00',
    }}),
  ]);
  assert.deepEqual(competitor.map(x=>x.status).sort(),[201,409],
    'two simultaneous transfers cannot spend the same source balance');
  assert.equal((await request('/api/accounts/'+sourceId,{cookie:a.cookie})).data.account.balanceCents,1440);
  assert.equal((await request('/api/accounts/'+targetId,{cookie:a.cookie})).data.account.balanceCents,8560);
  assert.equal((await request('/api/movements',{cookie:a.cookie})).data.movements.length,baseMovements,
    'concurrent transfer must not affect income/expense result');
  assert.equal((await request('/api/transfers',{cookie:a.cookie})).data.transfers.length,2);
  console.log('TRANSFERS_E2E_PASS: authenticated own transfers, conserved total, no income/expense, CSRF, tenant isolation and idempotency');
  console.log('TRANSFERS_RACE_PASS: competing concurrent D1 transfers do not overspend or create a partial leg');
  status(await request('/api/auth/sign-out',{method:'POST',cookie:a.cookie,body:{}}),200,'signout A');
  status(await request('/api/accounts',{cookie:a.cookie}),401,'A cookie revoked');
  status(await request('/api/accounts',{cookie:b.cookie}),200,'B session unaffected');
  console.log('FINANCE_E2E_PASS: 2 real sessions, exact cash totals, idempotency, isolation, CSRF, logout revocation');
}
main().catch(e=>{console.error('AUTH_E2E_FAIL:',e.message);process.exitCode=1;});
