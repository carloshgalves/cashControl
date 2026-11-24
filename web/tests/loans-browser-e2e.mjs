import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
const API='http://127.0.0.1:8787',APP='http://127.0.0.1:5173';
const tag=randomUUID().slice(0,8);
const users=[
 {email:'g1-a-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Alice'},
 {email:'g1-b-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Bob'},
];
async function waitForReady(){
 for(let i=0;i<70;i++){try{const a=await fetch(API+'/api/loans'),v=await fetch(APP);if(a.status===401&&v.ok)return;}catch{}
  await new Promise(r=>setTimeout(r,800));}
 throw new Error('Worker and Vite preview unavailable');
}
async function signup(u){
 const r=await fetch(API+'/api/auth/sign-up/email',{method:'POST',
 headers:{origin:API,'content-type':'application/json'},body:JSON.stringify(u)});
 assert.equal(r.status,200,'Real Better Auth signup failed');
}
async function login(page,u){
 await page.getByLabel('E-mail').fill(u.email);
 await page.getByLabel('Senha').fill(u.password);
 await page.getByRole('button',{name:'Entrar com segurança'}).click();
 await page.getByRole('heading',{name:'Seu dinheiro tem um ritmo.'}).waitFor();
}
async function main(){
 await waitForReady();await Promise.all(users.map(signup));
 const browser=await chromium.launch({headless:true});
 const ctx=await browser.newContext({viewport:{width:1366,height:900},locale:'pt-BR',timezoneId:'America/Fortaleza'});
 const page=await ctx.newPage();page.setDefaultTimeout(18000);
 await page.clock.setFixedTime(new Date('2026-11-23T12:00:00Z'));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(APP,{waitUntil:'domcontentloaded'});await login(page,users[0]);
  const post=async(path,body)=>{
   const r=await page.request.post(APP+path,{data:body});
   assert.equal(r.status(),201,JSON.stringify(await r.json()));return r.json();
  };
  const acc=(await post('/api/accounts',{idempotencyKey:'g1-wallet-'+randomUUID(),name:'Carteira G1',
   kind:'general',funding:{mode:'external',amount:'1000.00'}})).account;
  const loan=(await post('/api/loans',{idempotencyKey:'g1-loan-'+randomUUID(),borrower:'Terceiro fictício',
   title:'Empréstimo informal',sourceAccountId:acc.accountId,principal:'500.00',
   lentOn:'2026-11-23',dueOn:'2026-12-01'})).loan;
  const dash=async()=> (await(await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-12-31')).json()).dashboard;
  let d=await dash();
  assert.deepEqual([d.balances.totalCents,d.cashFlow.incomeCents,d.cashFlow.expensesCents],[50000,0,0]);
  let loanView=(await(await page.request.get(APP+'/api/loans/'+loan.loanId)).json()).loan;
  assert.equal(loanView.outstandingCents,50000);
  const when=await page.request.get(APP+'/api/timeline?from=2026-11-01&to=2026-12-31&asOf=2026-12-05');
  assert.equal(when.status(),200);
  assert.ok((await when.json()).events.some(e=>e.kind==='loan_receivable'&&e.status==='overdue'));
  console.log('G1_GRANT_AND_OVERDUE_PASS: real cash -500, no salary/expense, private overdue receivable');
  for(let i=0;i<2;i++){
   const rep=(await post('/api/loans/'+loan.loanId+'/repayments',{idempotencyKey:'g1-return-'+i+'-'+randomUUID(),
    destinationAccountId:acc.accountId,amount:'250.00',receivedOn:'2026-12-'+(i===0?'06':'07')})).repayment;
   assert.equal(rep.amountCents,25000);
  }
  d=await dash();
  assert.deepEqual([d.balances.totalCents,d.cashFlow.incomeCents,d.cashFlow.expensesCents],[100000,0,0]);
  assert.equal((await(await page.request.get(APP+'/api/loans/'+loan.loanId)).json()).loan.state,'repaid');
  assert.equal((await(await page.request.get(APP+'/api/timeline?from=2026-11-01&to=2026-12-31&asOf=2026-12-08')).json())
   .events.filter(e=>e.kind==='loan_repayment').length,2);
  console.log('G1_RETURN_PRINCIPAL_PASS: two R$250 repayments, zero classified earned income');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
  await page.getByRole('button',{name:'Sair com segurança'}).last().click();
  await page.getByRole('button',{name:'Entrar com segurança'}).waitFor();
  await login(page,users[1]);
  assert.equal((await page.request.get(APP+'/api/loans/'+loan.loanId)).status(),404);
  assert.equal((await page.request.get(APP+'/api/loans')).status(),200);
  assert.equal((await(await page.request.get(APP+'/api/loans')).json()).loans.length,0);
  assert.equal((await page.request.post(APP+'/api/loans/'+loan.loanId+'/repayments',{data:{
   idempotencyKey:'g1-attack-'+randomUUID(),destinationAccountId:acc.accountId,amount:'1.00',
   receivedOn:'2026-12-08',
  }})).status(),404);
  assert.deepEqual(errors,[]);
  console.log('G1_AUTH_ISOLATION_PASS: Alice/Bob, tenant 404, responsive 390px');
 }finally{await ctx.close();await browser.close();}
}
main().catch(e=>{console.error('G1_BROWSER_E2E_FAIL',e?.stack??e);process.exitCode=1;});
