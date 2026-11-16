import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
const API='http://127.0.0.1:8787',APP='http://127.0.0.1:5173';
const tag=randomUUID().slice(0,8);
const users=[
 {email:'d3-a-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Alice'},
 {email:'d3-b-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Bob'},
];
async function ready(){
 for(let i=0;i<70;i++){
  try{const a=await fetch(API+'/api/cards'),v=await fetch(APP);if(a.status===401&&v.ok)return;}
  catch{}
  await new Promise(resolve=>setTimeout(resolve,800));
 }
 throw new Error('Disposable local Worker and UI unavailable');
}
async function signup(user){
 const response=await fetch(API+'/api/auth/sign-up/email',{
  method:'POST',headers:{origin:API,'content-type':'application/json'},body:JSON.stringify(user),
 });
 assert.equal(response.status,200,'Could not sign up disposable test user');
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
 const page=await ctx.newPage();
 await page.clock.setFixedTime(new Date('2026-11-11T13:00:00.000Z'));
 page.setDefaultTimeout(16000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(APP,{waitUntil:'domcontentloaded'});await login(page,users[0]);
  await page.getByRole('button',{name:'Cartões'}).first().click();
  await page.getByRole('button',{name:'＋ Novo cartão'}).click();
  const cardForm=page.getByRole('form',{name:'Novo cartão'});
  await cardForm.getByLabel('Nome do cartão').fill('Cartão D3');
  await cardForm.getByLabel('Limite informado em reais').fill('2000,00');
  await cardForm.getByLabel('Dia de fechamento').fill('25');
  await cardForm.getByLabel('Dia de vencimento').fill('5');
  await cardForm.getByRole('button',{name:'Confirmar registro'}).click();
  await page.getByRole('group',{name:'Selecionar cartão'}).getByText('Cartão D3').waitFor();
  const card=(await (await page.request.get(APP+'/api/cards')).json()).cards[0];
  await page.getByRole('button',{name:'＋ Nova compra'}).click();
  const form=page.getByRole('form',{name:'Nova compra no crédito'});
  await form.getByLabel('Descrição').fill('Compra manual D3');
  await form.getByLabel('Data da compra').fill('2026-11-11');
  await form.getByLabel('Parcelas').fill('1');
  await form.getByLabel('Valor total em reais').fill('100,01');
  await form.getByRole('button',{name:'Confirmar registro'}).click();
  await page.getByRole('button',{name:/novembro de 2026/}).first().click();
  const panel=page.getByRole('region',{name:'Conciliação manual da fatura'});
  await panel.getByText('Ainda não informada').waitFor();
  const base=await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30');
  assert.equal(base.status(),200);
  const old=(await base.json()).dashboard;
  assert.equal(old.cashFlow.expensesCents,0);
  await panel.getByRole('button',{name:'Informar total da instituição'}).click();
  const first=page.getByRole('form',{name:'Informar total da instituição'});
  await first.getByLabel('Total bruto da fatura informado pela instituição (R$)').fill('110,01');
  await first.getByRole('button',{name:'Salvar valor informado'}).click();
  await panel.getByText('Divergência pendente').waitFor();
  await panel.getByText('R$ 10,00').waitFor();
  const endpoint=APP+'/api/cards/'+card.cardId+'/invoices/2026-11/reconciliation';
  let response=await page.request.get(endpoint);
  assert.equal(response.status(),200);
  let data=await response.json();
  assert.deepEqual([data.reconciliation.status,data.reconciliation.differenceCents],
   ['pending_divergence',1000]);
  assert.equal(data.observations.length,1);
  await panel.getByRole('button',{name:'Registrar novo valor informado'}).click();
  const next=page.getByRole('form',{name:'Informar total da instituição'});
  await next.getByLabel('Total bruto da fatura informado pela instituição (R$)').fill('100,01');
  await next.getByRole('button',{name:'Salvar valor informado'}).click();
  await panel.getByText('Valores coincidem').waitFor();
  await panel.getByRole('button',{name:'Ver histórico das informações'}).click();
  await panel.getByRole('region',{name:'Histórico de valores informados'}).getByText('R$ 110,01').waitFor();
  data=await (await page.request.get(endpoint)).json();
  assert.equal(data.observations.length,2);
  assert.deepEqual(data.observations.map(x=>x.reportedTotalCents),[10001,11001]);
  // Fault injection: the POST commits, but the subsequent UI refresh GET
  // fails. The user's retry must retain the same idempotency key.
  await panel.getByRole('button',{name:'Registrar novo valor informado'}).click();
  const retryForm=page.getByRole('form',{name:'Informar total da instituição'});
  await retryForm.getByLabel('Total bruto da fatura informado pela instituição (R$)').fill('101,00');
  let blocked=false;
  const matcher='**/api/cards/**/invoices/**/reconciliation?limit=25&offset=0';
  const interrupt=async route=>{
   if(!blocked&&route.request().method()==='GET'){blocked=true;await route.abort('failed');}
   else await route.continue();
  };
  await page.route(matcher,interrupt);
  await retryForm.getByRole('button',{name:'Salvar valor informado'}).click();
  await panel.getByRole('alert').waitFor();
  assert.equal(blocked,true,'the post-commit refresh was deliberately interrupted');
  await page.unroute(matcher,interrupt);
  await retryForm.getByRole('button',{name:'Salvar valor informado'}).click();
  await panel.getByText('Divergência pendente').waitFor();
  data=await (await page.request.get(endpoint)).json();
  assert.deepEqual(data.observations.map(x=>x.reportedTotalCents),[10100,10001,11001],
   'post-commit retry may not create a fourth observation');
  console.log('D3_RETRY_UI_PASS: failed refresh after committed POST, no duplicate manual observation');
  const final=(await (await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30')).json()).dashboard;
  assert.deepEqual(final,old,'reconciliation changes no ledger or obligations');
  assert.equal((await (await page.request.get(APP+'/api/movements')).json()).movements.length,0);
  console.log('D3_MANUAL_UI_PASS: unmatched -> pending -> matched; immutable history; zero ledger change');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,'D3 mobile overflow');
  await page.getByRole('button',{name:'Sair com segurança'}).last().click();
  await page.getByRole('button',{name:'Entrar com segurança'}).waitFor();
  await login(page,users[1]);
  const foreign=await page.request.get(endpoint);
  assert.equal(foreign.status(),404);
  await page.getByRole('button',{name:'Cartões'}).first().click();
  await page.getByRole('heading',{name:'Nenhum cartão cadastrado'}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('D3_TENANT_UI_PASS: A/B Better Auth isolation, no exposure after logout');
 }finally{await ctx.close();await browser.close();}
}
main().catch(e=>{console.error('D3_E2E_FAIL:',e?.stack??String(e));process.exitCode=1;});
