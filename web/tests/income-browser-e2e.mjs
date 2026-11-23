import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
const API='http://127.0.0.1:8787',APP='http://127.0.0.1:5173';
const tag=randomUUID().slice(0,8);
const users=[
 {email:'e2-a-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Alice'},
 {email:'e2-b-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Bob'},
];
async function ready(){
 for(let i=0;i<70;i++){try{const a=await fetch(API+'/api/income-sources'),v=await fetch(APP);
  if(a.status===401&&v.ok)return;}catch{}
  await new Promise(resolve=>setTimeout(resolve,800));
 }
 throw new Error('Local Worker and UI not available');
}
async function signup(user){
 const res=await fetch(API+'/api/auth/sign-up/email',{method:'POST',headers:{origin:API,'content-type':'application/json'},body:JSON.stringify(user)});
 assert.equal(res.status,200,'Better Auth sign up failed');
}
async function login(page,user){
 await page.getByLabel('E-mail').fill(user.email);
 await page.getByLabel('Senha').fill(user.password);
 await page.getByRole('button',{name:'Entrar com segurança'}).click();
 await page.getByRole('heading',{name:'Seu dinheiro tem um ritmo.'}).waitFor();
}
async function main(){
 await ready();await Promise.all(users.map(signup));
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1366,height:900},locale:'pt-BR',timezoneId:'America/Fortaleza'});
 const page=await context.newPage();
 await page.clock.setFixedTime(new Date('2026-11-11T13:00:00.000Z'));
 page.setDefaultTimeout(18000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(APP,{waitUntil:'domcontentloaded'});await login(page,users[0]);
  await page.getByRole('button',{name:'Rendas'}).first().click();
  const screen=page.getByRole('region',{name:'Fontes e expectativas de renda'});
  await screen.getByRole('button',{name:'＋ Nova fonte'}).click();
  const form=screen.getByRole('form',{name:'Nova fonte de renda'});
  await form.getByLabel('Nome da fonte').fill('Salário CLT');
  await form.getByLabel('Tipo de vínculo').selectOption('employment');
  await form.getByLabel('Natureza da remuneração').selectOption('fixed');
  await form.getByLabel('Periodicidade informada').selectOption('monthly');
  await form.getByLabel('Primeira data prevista').fill('2026-11-30');
  await form.getByLabel('Parcela fixa líquida prevista (R$, opcional)').fill('3000,00');
  await form.getByRole('button',{name:'Cadastrar fonte sem creditar caixa'}).click();
  await screen.getByRole('region',{name:'Calendário de expectativas'}).getByRole('button',{name:/Salário CLT/}).waitFor();
  const sources=(await (await page.request.get(APP+'/api/income-sources')).json()).sources;
  const salary=sources.find(s=>s.name==='Salário CLT');assert(salary);
  const range=APP+'/api/income-calendar?from=2026-11-01&to=2026-11-30';
  let cal=(await (await page.request.get(range)).json()).calendar;
  assert.equal(cal.expectations.length,1);
  assert.deepEqual(cal.totals,{expectedCents:300000,receivedCents:0,remainingCents:300000});
  const dashUrl=APP+'/api/dashboard?from=2026-11-01&to=2026-11-30';
  assert.equal((await (await page.request.get(dashUrl)).json()).dashboard.cashFlow.incomeCents,0);
  await screen.getByRole('region',{name:'Calendário de expectativas'}).getByRole('button',{name:/Salário CLT/}).click();
  const detail=screen.getByRole('region',{name:'Detalhe da expectativa'});
  await detail.getByRole('form',{name:'Alterar expectativa'}).getByRole('button',{name:'Registrar situação'}).click();
  await detail.getByText('Expectativa confirmada (não recebida)').first().waitFor();
  assert.equal((await (await page.request.get(dashUrl)).json()).dashboard.cashFlow.incomeCents,0);
  console.log('E2_NO_AUTO_CASH_PASS: confirming CLT salary never credits the account');
  await screen.getByRole('button',{name:'＋ Nova fonte'}).click();
  const freelancer=screen.getByRole('form',{name:'Nova fonte de renda'});
  await freelancer.getByLabel('Nome da fonte').fill('Freelancer E2');
  await freelancer.getByLabel('Tipo de vínculo').selectOption('freelance');
  await freelancer.getByLabel('Natureza da remuneração').selectOption('variable');
  await freelancer.getByLabel('Periodicidade informada').selectOption('none');
  await freelancer.getByRole('button',{name:'Cadastrar fonte sem creditar caixa'}).click();
  const allSources=(await (await page.request.get(APP+'/api/income-sources')).json()).sources;
  const free=allSources.find(s=>s.name==='Freelancer E2');assert(free);
  cal=(await (await page.request.get(range)).json()).calendar;
  assert.equal(cal.expectations.length,1,'variable freelancer cannot synthesize planned receipts');
  await screen.getByRole('button',{name:'＋ Previsão pontual'}).click();
  const manual=screen.getByRole('form',{name:'Nova expectativa pontual'});
  await manual.getByLabel('Fonte').selectOption(free.sourceId);
  await manual.getByLabel('Data informada').fill('2026-11-20');
  await manual.getByLabel('Valor previsto em reais').fill('180,00');
  await manual.getByRole('button',{name:'Registrar expectativa, sem receber'}).click();
  cal=(await (await page.request.get(range)).json()).calendar;
  assert.equal(cal.expectations.length,2);
  const event=cal.expectations.find(e=>e.sourceId===free.sourceId);
  assert.equal(event.expectedCents,18000);
  // Post an actual cash receipt with the real authenticated HTTP boundary.
  const make=async(path,body)=>{
   const response=await page.request.post(APP+path,{data:body});
   assert.equal(response.status(),201,JSON.stringify(await response.json()));
   return response.json();
  };
  const account=(await make('/api/accounts',{idempotencyKey:'e2-account-'+randomUUID(),
   name:'Carteira E2',kind:'general',funding:{mode:'external',amount:'0.00'}})).account;
  const movement=(await make('/api/movements',{idempotencyKey:'e2-cash-'+randomUUID(),
   accountId:account.accountId,direction:'income',amount:'50.00',method:'pix',
   description:'Freelancer recebido',occurredOn:'2026-11-11'})).movement;
  // The UI refreshes available movements on a new month/source state request;
  // verify the backend association from the same authenticated user.
  await make('/api/income-sources/'+free.sourceId+'/expectations/'+event.occurrenceKey+'/receipts',{
   idempotencyKey:'e2-link-'+randomUUID(),movementId:movement.movementId});
  cal=(await (await page.request.get(range)).json()).calendar;
  const linked=cal.expectations.find(e=>e.sourceId===free.sourceId);
  assert.deepEqual([linked.receivedCents,linked.remainingCents],[5000,13000]);
  assert.equal((await (await page.request.get(dashUrl)).json()).dashboard.cashFlow.incomeCents,5000);
  console.log('E2_MANUAL_UI_PASS: variable income is explicit; R$50 real income linked to R$180 forecast without duplicate');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
  await page.getByRole('button',{name:'Sair com segurança'}).last().click();
  await page.getByRole('button',{name:'Entrar com segurança'}).waitFor();
  await login(page,users[1]);
  assert.equal((await page.request.get(APP+'/api/income-sources/'+salary.sourceId)).status(),404);
  assert.deepEqual((await (await page.request.get(APP+'/api/income-sources')).json()).sources,[]);
  assert.deepEqual(errors,[]);
  console.log('E2_TENANT_UI_PASS: Better Auth A/B and mobile');
 }finally{await context.close();await browser.close();}
}
main().catch(e=>{console.error('E2_E2E_FAIL:',e?.stack??String(e));process.exitCode=1;});
