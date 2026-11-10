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
  status(await request('/api/auth/sign-out',{method:'POST',cookie:a.cookie,body:{}}),200,'signout A');
  status(await request('/api/accounts',{cookie:a.cookie}),401,'A cookie revoked');
  status(await request('/api/accounts',{cookie:b.cookie}),200,'B session unaffected');
  console.log('AUTH_E2E_PASS: 2 real signup/signin sessions, tenant isolation, CSRF, logout revocation');
}
main().catch(e=>{console.error('AUTH_E2E_FAIL:',e.message);process.exitCode=1;});
