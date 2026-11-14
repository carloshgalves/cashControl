import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
const API='http://127.0.0.1:8787',APP='http://127.0.0.1:5173';
const tag=randomUUID().slice(0,8);
const users=[
 {email:'d2-alice-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Alice'},
 {email:'d2-bob-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Bob'},
];
async function ready(){
 for(let i=0;i<70;i++){
  try{const a=await fetch(API+'/api/cards'),b=await fetch(APP);
   if(a.status===401&&b.ok)return;
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,800));
 }
 throw new Error('Disposable local Worker and UI unavailable');
}
async function signup(u){
 const response=await fetch(API+'/api/auth/sign-up/email',{
  method:'POST',headers:{origin:API,'content-type':'application/json'},body:JSON.stringify(u),
 });
 assert.equal(response.status,200,'Could not create disposable E2E user');
}
async function login(page,u){
 await page.getByLabel('E-mail').fill(u.email);
 await page.getByLabel('Senha').fill(u.password);
 await page.getByRole('button',{name:'Entrar com segurança'}).click();
 await page.getByRole('heading',{name:'Seu dinheiro tem um ritmo.'}).waitFor();
}
async function invoice(page,cardId){
 const res=await page.request.get(APP+'/api/cards/'+cardId+'/invoices/2026-11');
 assert.equal(res.status(),200);
 return (await res.json()).invoice;
}
async function settle(page,cardId,value){
 const before=await invoice(page,cardId);
 await page.getByRole('button',{name:/novembro de 2026/}).first().click();
 const panel=page.getByRole('region',{name:'Pagamentos da fatura'});
 await panel.getByText('Histórico de pagamentos').waitFor();
 await panel.getByRole('button',{name:'Registrar pagamento'}).click();
 const form=page.getByRole('form',{name:'Pagar fatura'});
 await form.getByLabel('Valor do pagamento em reais').fill(value);
 await form.getByLabel('Data do pagamento').fill('2026-11-11');
 await form.getByRole('button',{name:'Confirmar pagamento'}).click();
 const expected=before.paidCents+Math.round(Number(value.replace(',','.'))*100);
 let changed=false;
 for(let i=0;i<25;i++){
  try{if((await invoice(page,cardId)).paidCents===expected){changed=true;break;}}catch{}
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 assert(changed,'UI settlement must persist its paid cents exactly');
 await page.getByRole('heading',{name:'Seu crédito sem confusões.'}).waitFor();
 await page.getByRole('button',{name:/novembro de 2026/}).first().waitFor();
}
async function main(){
 await ready();await Promise.all(users.map(signup));
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1366,height:900},
  locale:'pt-BR',timezoneId:'America/Fortaleza'});
 const page=await context.newPage();
 await page.clock.setFixedTime(new Date('2026-11-11T13:00:00.000Z'));
 page.setDefaultTimeout(16000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(APP,{waitUntil:'domcontentloaded'});await login(page,users[0]);
  await page.getByRole('button',{name:'Contas'}).first().click();
  await page.getByRole('button',{name:/Adicionar conta/}).first().click();
  const newAccount=page.getByRole('dialog');
  await newAccount.getByLabel('Nome da conta').fill('Conta E2E');
  await newAccount.getByLabel('Saldo inicial (R$) — pode ser zero').fill('2000,00');
  await newAccount.getByRole('button',{name:'Criar conta'}).click();
  await newAccount.waitFor({state:'hidden'});
  const acc=(await (await page.request.get(APP+'/api/accounts')).json()).accounts[0];
  assert.equal(acc.balanceCents,200000);
  await page.getByRole('button',{name:'Cartões'}).first().click();
  await page.getByRole('button',{name:'＋ Novo cartão'}).click();
  const cardForm=page.getByRole('form',{name:'Novo cartão'});
  await cardForm.getByLabel('Nome do cartão').fill('Cartão de pagamento');
  await cardForm.getByLabel('Limite informado em reais').fill('3000,00');
  await cardForm.getByLabel('Dia de fechamento').fill('25');
  await cardForm.getByLabel('Dia de vencimento').fill('5');
  await cardForm.getByRole('button',{name:'Confirmar registro'}).click();
  await page.getByRole('group',{name:'Selecionar cartão'}).getByText('Cartão de pagamento').waitFor();
  const card=(await (await page.request.get(APP+'/api/cards')).json()).cards[0];
  await page.getByRole('button',{name:'＋ Nova compra'}).click();
  const purchase=page.getByRole('form',{name:'Nova compra no crédito'});
  await purchase.getByLabel('Descrição').fill('Despesa cartão D2');
  await purchase.getByLabel('Data da compra').fill('2026-11-11');
  await purchase.getByLabel('Parcelas').fill('1');
  await purchase.getByLabel('Valor total em reais').fill('1500,00');
  await purchase.getByRole('button',{name:'Confirmar registro'}).click();
  await page.getByRole('button',{name:/novembro de 2026/}).first().waitFor();
  assert.equal((await invoice(page,card.cardId)).outstandingCents,150000);
  let dashboard=(await (await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30')).json()).dashboard;
  assert.equal(dashboard.cashFlow.expensesCents,0,'purchase is not bank outflow');
  // Advance only the disposable browser clock to the invoice D-10 window.
  await page.clock.setFixedTime(new Date('2026-11-25T13:00:00.000Z'));
  const warningResponse=await page.request.get(APP+'/api/alerts?asOf=2026-11-25');
  assert.equal(warningResponse.status(),200);
  const found=(await warningResponse.json()).alerts.find(a=>a.cardId===card.cardId);
  assert(found,'the private invoice must appear in due-alert feed');
  assert.equal(found.cycle,'2026-11');
  await page.getByRole('button',{name:'Panorama'}).first().click();
  const preview=page.getByRole('region',{name:'Avisos de vencimento'});
  await preview.getByRole('button',{name:/Fatura: Cartão de pagamento/}).click();
  await page.getByRole('heading',{name:'Seu crédito sem confusões.'}).waitFor();
  const highlighted=page.getByRole('region',{name:'Pagamentos da fatura'});
  await highlighted.getByText('Histórico de pagamentos').waitFor();
  await highlighted.getByText('R$ 1.500,00').first().waitFor();
  await page.clock.setFixedTime(new Date('2026-11-11T13:00:00.000Z'));
  console.log('D2_ALERT_UI_PASS: D-10 card alert opens the exact invoice in Chromium');
  await settle(page,card.cardId,'900,00');
  let inv=await invoice(page,card.cardId);
  assert.deepEqual([inv.totalCents,inv.paidCents,inv.outstandingCents,inv.state],
   [150000,90000,60000,'partially_paid']);
  dashboard=(await (await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30')).json()).dashboard;
  assert.equal(dashboard.balances.totalCents,110000);
  assert.equal(dashboard.cashFlow.expensesCents,90000);
  let movements=(await (await page.request.get(APP+'/api/movements')).json()).movements;
  assert.equal(movements.length,1);
  await settle(page,card.cardId,'600,00');
  inv=await invoice(page,card.cardId);
  assert.equal(inv.outstandingCents,0);assert.equal(inv.state,'paid');
  dashboard=(await (await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30')).json()).dashboard;
  assert.equal(dashboard.balances.totalCents,50000);
  assert.equal(dashboard.cashFlow.expensesCents,150000);
  movements=(await (await page.request.get(APP+'/api/movements')).json()).movements;
  assert.equal(movements.length,2);
  const history=(await (await page.request.get(APP+'/api/cards/'+card.cardId+'/invoices/2026-11/payments')).json()).payments;
  assert.deepEqual(history.map(p=>p.amountCents),[90000,60000]);
  await page.getByRole('button',{name:/novembro de 2026/}).first().click();
  const panel=page.getByRole('region',{name:'Pagamentos da fatura'});
  await panel.getByText('Fatura integralmente quitada. O sistema impede nova baixa.').waitFor();
  assert.equal(await panel.getByRole('button',{name:'Registrar pagamento'}).count(),0);
  console.log('D2_CASH_UI_PASS: purchase no debit; 900+600 paid once; card and bank reconciled');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,'mobile overflow');
  const logout=page.getByRole('button',{name:'Sair com segurança'}).last();
  await logout.click();await page.getByRole('button',{name:'Entrar com segurança'}).waitFor();
  await login(page,users[1]);
  const foreign=await page.request.get(APP+'/api/cards/'+card.cardId+'/invoices/2026-11/payments');
  assert.equal(foreign.status(),404);
  const lookup=await page.request.get(APP+'/api/cards/'+card.cardId+'/invoices/2026-11');
  assert.equal(lookup.status(),404);
  assert.deepEqual(errors,[]);
  console.log('D2_TENANT_UI_PASS: real sessions A/B and private payment history');
 }finally{await context.close();await browser.close();}
}
main().catch(e=>{console.error('D2_E2E_FAIL:',e?.stack??String(e));process.exitCode=1;});
