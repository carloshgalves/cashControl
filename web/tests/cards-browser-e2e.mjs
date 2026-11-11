import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
const API='http://127.0.0.1:8787',APP='http://127.0.0.1:5173';
const tag=randomUUID().slice(0,8);
const users=[
 {email:'d1-alice-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Alice'},
 {email:'d1-bob-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Bob'},
];
async function ready(){
 for(let n=0;n<70;n++){
  try{
   const response=await fetch(API+'/api/cards');
   const ui=await fetch(APP);
   if(response.status===401&&ui.ok)return;
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,900));
 }
 throw new Error('Worker/browser backend not ready');
}
async function signup(u){
 const response=await fetch(API+'/api/auth/sign-up/email',{
  method:'POST',headers:{origin:API,'content-type':'application/json'},
  body:JSON.stringify(u),
 });
 assert.equal(response.status,200,'Could not create disposable test user');
}
async function login(page,u){
 await page.getByLabel('E-mail').fill(u.email);
 await page.getByLabel('Senha').fill(u.password);
 await page.getByRole('button',{name:'Entrar com segurança'}).click();
 await page.getByRole('heading',{name:'Seu dinheiro tem um ritmo.'}).waitFor();
}
async function main(){
 await ready();await Promise.all(users.map(signup));
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1366,height:900},
  locale:'pt-BR',timezoneId:'America/Fortaleza'});
 const page=await context.newPage();
 await page.clock.setFixedTime(new Date('2026-11-11T13:00:00.000Z'));
 page.setDefaultTimeout(16000);
 const browserErrors=[];page.on('pageerror',e=>browserErrors.push(e.message));
 try{
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await login(page,users[0]);
  await page.getByRole('button',{name:'Cartões'}).first().click();
  await page.getByRole('heading',{name:'Nenhum cartão cadastrado'}).waitFor();
  const original=await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30');
  assert.equal(original.status(),200);
  assert.equal((await original.json()).dashboard.balances.totalCents,0);
  await page.getByRole('button',{name:'＋ Novo cartão'}).click();
  const cardForm=page.getByRole('form',{name:'Novo cartão'});
  await cardForm.getByLabel('Nome do cartão').fill('Cartão do teste');
  await cardForm.getByLabel('Instituição (opcional)').fill('Banco fictício');
  await cardForm.getByLabel('Limite informado em reais').fill('1500,00');
  await cardForm.getByLabel('Dia de fechamento').fill('25');
  await cardForm.getByLabel('Dia de vencimento').fill('5');
  await cardForm.getByRole('button',{name:'Confirmar registro'}).click();
  await page.getByRole('group',{name:'Selecionar cartão'}).getByText('Cartão do teste').waitFor();
  const cards=(await (await page.request.get(APP+'/api/cards')).json()).cards;
  assert.equal(cards.length,1);const card=cards[0];
  assert.equal(card.limitCents,150000);
  await page.getByRole('button',{name:'＋ Nova compra'}).click();
  const purchaseForm=page.getByRole('form',{name:'Nova compra no crédito'});
  await purchaseForm.getByLabel('Descrição').fill('Compra parcelada');
  await purchaseForm.getByLabel('Estabelecimento (opcional)').fill('Loja exemplo');
  await purchaseForm.getByLabel('Data da compra').fill('2026-11-25');
  await purchaseForm.getByLabel('Parcelas').fill('10');
  await purchaseForm.getByLabel('Valor total em reais').fill('100,01');
  await purchaseForm.getByRole('button',{name:'Confirmar registro'}).click();
  await page.getByRole('button',{name:/Compra parcelada/}).waitFor();
  const invoices=(await (await page.request.get(APP+'/api/cards/'+card.cardId+'/invoices')).json()).invoices;
  assert.equal(invoices.length,10);
  assert.equal(invoices.reduce((n,i)=>n+i.totalCents,0),10001);
  const detail=(await (await page.request.get(APP+'/api/cards/'+card.cardId+'/invoices/2026-11')).json());
  assert.equal(detail.invoice.totalCents,1001);
  assert.equal(detail.installments[0].amountCents,1001);
  await page.getByRole('button',{name:/novembro de 2026/}).first().click();
  await page.getByRole('region',{name:'Detalhes das parcelas'}).getByText('1/10').waitFor().catch(async()=>{
   await page.getByRole('region',{name:'Detalhes das parcelas'}).getByText(/Parcela 1\/10/).waitFor();
  });
  const after=await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30');
  assert.equal((await after.json()).dashboard.balances.totalCents,0);
  assert.equal((await after.json()).dashboard.cashFlow.expensesCents,0);
  assert.equal((await page.request.get(APP+'/api/movements')).status(),200);
  assert.equal((await (await page.request.get(APP+'/api/movements')).json()).movements.length,0);
  console.log('D1_CREDIT_UI_PASS: card, 10x invoice, no cash movement');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,
   'Card layout overflows mobile viewport');
  const mobile=page.getByRole('navigation',{name:'Navegação principal'});
  await mobile.getByRole('button',{name:'Cartões'}).click();
  await mobile.getByRole('button',{name:'Início'}).click();
  await mobile.getByRole('button',{name:'Cartões'}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
  await page.getByRole('button',{name:'Sair com segurança'}).first().click();
  await page.getByRole('button',{name:'Entrar com segurança'}).waitFor();
  await login(page,users[1]);
  await mobile.getByRole('button',{name:'Cartões'}).click();
  await page.getByRole('heading',{name:'Nenhum cartão cadastrado'}).waitFor();
  const foreign=await page.request.get(APP+'/api/cards/'+card.cardId);
  assert.equal(foreign.status(),404);
  const foreignInvoice=await page.request.get(APP+'/api/cards/'+card.cardId+'/invoices/2026-11');
  assert.equal(foreignInvoice.status(),404);
  assert.deepEqual(browserErrors,[]);
  console.log('D1_CREDIT_TENANT_PASS: Alice/Bob isolated, responsive, anonymous cannot read');
 }finally{await context.close();await browser.close();}
}
main().catch(e=>{console.error('D1_CREDIT_E2E_FAIL:',e?.stack??String(e));process.exitCode=1;});
