import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
const API='http://127.0.0.1:8787',APP='http://127.0.0.1:5173';
const tag=randomUUID().slice(0,8);
const users=[
 {email:'f1-a-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Alice'},
 {email:'f1-b-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Bob'},
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
 const ctx=await browser.newContext({viewport:{width:1366,height:900},locale:'pt-BR',timezoneId:'America/Fortaleza'});
 const page=await ctx.newPage();page.setDefaultTimeout(18000);
 await page.clock.setFixedTime(new Date('2026-11-11T13:00:00.000Z'));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(APP,{waitUntil:'domcontentloaded'});await login(page,users[0]);
  const post=async(path,body)=>{
   const res=await page.request.post(APP+path,{data:body});
   assert.equal(res.status(),201,JSON.stringify(await res.json()));
   return res.json();
  };
  const account=(await post('/api/accounts',{idempotencyKey:'f1-account-'+randomUUID(),
    name:'Carteira do planejamento',kind:'general',funding:{mode:'external',amount:'1200.00'}})).account;
  await page.getByRole('button',{name:'Planejamento'}).first().click();
  const screen=page.getByRole('region',{name:'Intenções e reservas preventivas'});
  await screen.getByRole('button',{name:'＋ Nova intenção'}).click();
  const form=screen.getByRole('form',{name:'Cadastrar intenção de compra'});
  await form.getByLabel('O que pretende comprar?').fill('Notebook para trabalho');
  await form.getByLabel('Descrição opcional').fill('Compra futura sem parcelamento');
  await form.getByLabel('Valor estimado (R$)').fill('500,00');
  await form.getByLabel('Data possível da compra').fill('2026-11-30');
  await form.getByRole('button',{name:'Salvar no planejamento'}).click();
  const list=screen.getByRole('region',{name:'Lista de intenções'});
  const notebook=list.getByRole('button',{name:/Notebook para trabalho/});
  await notebook.waitFor();
  const intention=(await (await page.request.get(APP+'/api/intentions')).json()).intentions[0];
  assert.deepEqual([intention.state,intention.reservedCents],['planning',0]);
  let summary=(await (await page.request.get(APP+'/api/planning-summary')).json()).summary;
  assert.deepEqual([summary.cashBalanceCents,summary.obligationsCents,summary.activeReserveCents,summary.freeMarginCents],[120000,0,0,120000]);
  await notebook.click();
  const detail=screen.getByRole('region',{name:'Detalhe da intenção'});
  await detail.getByLabel('Reservar virtualmente (R$)').fill('500,00');
  await detail.getByRole('button',{name:'Ativar reserva preventiva'}).click();
  await notebook.getByText('Reserva ativa').waitFor();
  summary=(await (await page.request.get(APP+'/api/planning-summary')).json()).summary;
  assert.deepEqual([summary.cashBalanceCents,summary.activeReserveCents,summary.freeMarginCents],[120000,50000,70000]);
  assert.equal((await (await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30')).json()).dashboard.cashFlow.expensesCents,0);
  await detail.getByRole('button',{name:'Desativar reserva e voltar ao planejamento'}).click();
  await notebook.getByText('Planejamento').waitFor();
  assert.equal((await (await page.request.get(APP+'/api/planning-summary')).json()).summary.freeMarginCents,120000);
  await notebook.click(); // reset reserve form to original full amount
  await detail.getByRole('button',{name:'Ativar reserva preventiva'}).click();
  await notebook.getByText('Reserva ativa').waitFor();
  const agreed=detail.getByRole('checkbox',{name:/Confirmo que a compra foi concretizada/});
  const convert=detail.getByRole('button',{name:'Converter em obrigação sem duplicar reserva'});
  await agreed.check();
  console.log('F1_CHECK_DIAG',JSON.stringify({checked:await agreed.isChecked(),enabled:await convert.isEnabled(),
    alerts:await screen.getByRole('alert').allTextContents(),loading:await screen.getByRole('status').allTextContents()}));
  await convert.click();
  await detail.getByText('Compra concretizada: a reserva virtual foi substituída').waitFor();
  summary=(await (await page.request.get(APP+'/api/planning-summary')).json()).summary;
  assert.deepEqual([summary.activeReserveCents,summary.obligationsCents,summary.freeMarginCents],[0,50000,70000]);
  const changed=(await (await page.request.get(APP+'/api/intentions/'+intention.intentionId)).json()).intention;
  assert.equal(changed.state,'converted');
  const debt=(await (await page.request.get(APP+'/api/obligations/'+changed.obligationId)).json()).obligation;
  assert.deepEqual([debt.totalCents,debt.state],[50000,'open']);
  assert.equal((await (await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30')).json()).dashboard.cashFlow.expensesCents,0);
  await page.getByRole('button',{name:'Panorama'}).first().click();
  await page.getByText('Notebook para trabalho').first().waitFor();
  console.log('F1_RESERVE_UI_PASS: R$500 virtual reserve replaced atomically by R$500 obligation, current cash untouched');
  await post('/api/obligations/'+changed.obligationId+'/payments',{idempotencyKey:'f1-paid-'+randomUUID(),accountId:account.accountId,amount:'500.00',method:'pix',paidOn:'2026-11-30'});
  const cash=(await (await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30')).json()).dashboard;
  assert.deepEqual([cash.balances.totalCents,cash.cashFlow.expensesCents,cash.obligations.outstandingCents],[70000,50000,0]);
  await page.getByRole('button',{name:'Planejamento'}).first().click();
  await screen.getByRole('button',{name:'＋ Nova intenção'}).click();
  const another=screen.getByRole('form',{name:'Cadastrar intenção de compra'});
  await another.getByLabel('O que pretende comprar?').fill('Mesa de escritório');
  await another.getByLabel('Valor estimado (R$)').fill('200,00');
  await another.getByLabel('Data possível da compra').fill('2026-12-10');
  await another.getByRole('button',{name:'Salvar no planejamento'}).click();
  await list.getByRole('button',{name:/Mesa de escritório/}).click();
  await detail.getByRole('button',{name:/Retirar intenção do planejamento/}).click();
  await detail.getByText('Intenção retirada do planejamento.').waitFor();
  assert.equal((await (await page.request.get(APP+'/api/intentions')).json()).intentions.filter(x=>x.state==='converted').length,1);
  assert.equal((await (await page.request.get(APP+'/api/obligations')).json()).obligations.length,1);
  console.log('F1_HISTORY_UI_PASS: excluded planning does not erase converted purchased/payments');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,'mobile horizontal overflow');
  await page.getByRole('button',{name:'Sair com segurança'}).last().click();
  await page.getByRole('button',{name:'Entrar com segurança'}).waitFor();
  await login(page,users[1]);
  assert.equal((await page.request.get(APP+'/api/intentions/'+intention.intentionId)).status(),404);
  assert.deepEqual((await (await page.request.get(APP+'/api/intentions')).json()).intentions,[]);
  assert.equal((await (await page.request.get(APP+'/api/planning-summary')).json()).summary.activeReserveCents,0);
  assert.deepEqual(errors,[]);
  console.log('F1_TENANT_UI_PASS: Better Auth A/B and mobile');
 }finally{await ctx.close();await browser.close();}
}
main().catch(e=>{console.error('F1_E2E_FAIL:',e?.stack??String(e));process.exitCode=1;});
