import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
const API='http://127.0.0.1:8787',APP='http://127.0.0.1:5173';
const tag=randomUUID().slice(0,8);
const users=[
 {email:'e1-a-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Alice'},
 {email:'e1-b-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Bob'},
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
 const page=await ctx.newPage();page.setDefaultTimeout(16000);
 await page.clock.setFixedTime(new Date('2026-11-11T13:00:00Z'));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
 await page.goto(APP,{waitUntil:'domcontentloaded'});await login(page,users[0]);
 await page.getByRole('button',{name:'Trabalhos'}).first().click();
 await page.getByRole('button',{name:'＋ Novo trabalho'}).click();
 const f=page.getByRole('form',{name:'Novo trabalho'});
 await f.getByLabel('Nome do trabalho').fill('Freelancer E1');
 await f.getByLabel('Contratante (opcional)').fill('Cliente');
 await f.getByLabel('Valor combinado em reais (opcional)').fill('300,00');
 await f.getByRole('button',{name:'Cadastrar trabalho'}).click();
 const detail=page.getByRole('region',{name:'Detalhe do trabalho'});
 await detail.getByText('Valor combinado',{exact:true}).waitFor();
 const works=(await (await page.request.get(APP+'/api/works')).json()).works;
 const workId=works[0].workId;
 const get=async()=>(await (await page.request.get(APP+'/api/works/'+workId)).json()).work;
 assert.equal((await get()).receivedCents,0);
 await detail.getByRole('button',{name:'Registrar recebimento'}).click();
 const dlg=page.getByRole('dialog');
 await dlg.getByLabel('Nome da conta').fill('Conta E1');
 await dlg.getByLabel('Saldo inicial (R$) — pode ser zero').fill('0,00');
 await dlg.getByRole('button',{name:'Criar conta'}).click();
 await dlg.waitFor({state:'hidden'});
 // Create real confirmed cash movements through the existing UI, then
 // attribute them individually; no new cash movement in the link operation.
 async function record(direction,description,value){
  await detail.getByRole('button',{name:direction==='income'?'Registrar recebimento':'Registrar custo'}).click();
  await dlg.getByLabel('Valor (R$)').fill(value);
  await dlg.getByLabel('Descrição').fill(description);
  await dlg.getByRole('button',{name:'Confirmar registro'}).click();
  await dlg.waitFor({state:'hidden'});
  const listing=(await (await page.request.get(APP+'/api/work-movements/available')).json()).movements;
  const movement=listing.find(m=>m.description===description);assert(movement,'registered cash must be available');
  // A parent refresh may remount the work screen: reopen the work if needed.
  await page.getByRole('button',{name:/Freelancer E1/}).waitFor();
  if(!await detail.isVisible())await page.getByRole('button',{name:/Freelancer E1/}).click();
  const form=detail.getByRole('form',{name:'Vincular movimentação'});
  await form.getByLabel('Movimentação disponível').selectOption(movement.movementId);
  await form.getByRole('button',{name:'Vincular movimentação'}).click();
  await detail.getByText(description,{exact:true}).waitFor();
 }
 await page.getByRole('button',{name:/Freelancer E1/}).waitFor();
 if(!await detail.isVisible())await page.getByRole('button',{name:/Freelancer E1/}).click();
 const status=detail.getByRole('form',{name:'Alterar situação do trabalho'});
 await status.getByLabel('Nova situação').selectOption('realized');
 await status.getByRole('button',{name:'Registrar situação'}).click();
 await detail.getByText('Realizado · A receber',{exact:true}).waitFor();
 await record('income','Primeira parcela','100,00');
 assert.deepEqual([(await get()).state,(await get()).receiptState,(await get()).remainingCents],['realized','partial',20000]);
 await record('income','Segunda parcela','200,00');
 await record('expense','Combustível','40,00');
 await record('expense','Material','60,00');
 let w=await get();assert.deepEqual([w.receivedCents,w.costCents,w.netCents],[30000,10000,20000]);
 const dash=(await (await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30')).json()).dashboard;
 assert.deepEqual([dash.cashFlow.incomeCents,dash.cashFlow.expensesCents,dash.cashFlow.netCents],[30000,10000,20000]);
 await status.getByLabel('Nova situação').selectOption('canceled');
 await status.getByLabel('Motivo do cancelamento (opcional)').fill('Cliente cancelou');
 await status.getByRole('button',{name:'Registrar situação'}).click();
 await detail.getByText(/Cliente cancelou/).waitFor();
 w=await get();assert.equal(w.state,'canceled');assert.equal(w.netCents,20000);
 assert.deepEqual((await (await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30')).json()).dashboard,dash);
 console.log('E1_WORK_UI_PASS: work lifecycle, partial receipts, R$300 - R$40 - R$60, cancellation and cash unchanged');
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
 await page.getByRole('button',{name:'Sair com segurança'}).last().click();await page.getByRole('button',{name:'Entrar com segurança'}).waitFor();
 await login(page,users[1]);assert.equal((await page.request.get(APP+'/api/works/'+workId)).status(),404);
 assert.deepEqual((await (await page.request.get(APP+'/api/works')).json()).works,[]);
 assert.deepEqual(errors,[]);
 console.log('E1_TENANT_UI_PASS: Better Auth A/B and mobile');
 }finally{await ctx.close();await browser.close();}
}
main().catch(e=>{console.error('E1_E2E_FAIL:',e?.stack??String(e));process.exitCode=1;});
