import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
const API='http://127.0.0.1:8787',APP='http://127.0.0.1:5173';
const tag=randomUUID().slice(0,8);
const users=[
 {email:'e4-a-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Alice'},
 {email:'e4-b-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Bob'},
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
 await page.clock.setFixedTime(new Date('2026-11-11T13:00:00Z'));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(APP,{waitUntil:'domcontentloaded'});await login(page,users[0]);
  const post=async(path,body)=>{
   const res=await page.request.post(APP+path,{data:body});
   assert.equal(res.status(),201,JSON.stringify(await res.json()));
   return res.json();
  };
  const debt=(await post('/api/obligations',{idempotencyKey:'e4-obligation-'+randomUUID(),
   title:'Consignado de novembro',amount:'300.00',dueOn:'2026-11-30'})).obligation;
  const account=(await post('/api/accounts',{idempotencyKey:'e4-account-'+randomUUID(),
   name:'Conta salário',kind:'general',funding:{mode:'external',amount:'0.00'}})).account;
  const cash=(await post('/api/movements',{idempotencyKey:'e4-salary-'+randomUUID(),
   accountId:account.accountId,direction:'income',amount:'2500.00',method:'pix',
   description:'Líquido depositado em novembro',occurredOn:'2026-11-30'})).movement;
  const dash='/api/dashboard?from=2026-11-01&to=2026-11-30';
  let before=(await (await page.request.get(APP+dash)).json()).dashboard;
  assert.deepEqual([before.cashFlow.incomeCents,before.cashFlow.expensesCents,before.obligations.outstandingCents],[250000,0,30000]);

  await page.getByRole('button',{name:'Rendas'}).first().click();
  const screen=page.getByRole('region',{name:'Fontes e expectativas de renda'});
  await screen.getByRole('button',{name:'＋ Nova fonte'}).click();
  const newSource=screen.getByRole('form',{name:'Nova fonte de renda'});
  await newSource.getByLabel('Nome da fonte').fill('Salário CLT E4');
  await newSource.getByLabel('Tipo de vínculo').selectOption('employment');
  await newSource.getByLabel('Natureza da remuneração').selectOption('fixed');
  await newSource.getByLabel('Periodicidade informada').selectOption('monthly');
  await newSource.getByLabel('Primeira data prevista').fill('2026-11-30');
  await newSource.getByLabel('Parcela fixa líquida prevista (R$, opcional)').fill('2500,00');
  await newSource.getByRole('button',{name:'Cadastrar fonte sem creditar caixa'}).click();
  const src=(await (await page.request.get(APP+'/api/income-sources')).json()).sources[0];
  await screen.getByRole('region',{name:'Calendário de expectativas'}).getByRole('button',{name:/Salário CLT E4/}).click();
  const panel=screen.getByRole('region',{name:'Remuneração de Salário CLT E4'});
  await panel.getByRole('button',{name:'Informar composição'}).click();
  const form=panel.getByRole('form',{name:'Demonstrativo de remuneração'});
  await form.getByLabel('Salário líquido desta competência (R$)').fill('2500,00');
  await form.getByLabel('Salário bruto (R$, opcional)').fill('3000,00');
  await form.getByRole('button',{name:'＋ Discriminar desconto'}).click();
  await form.getByLabel('Descrição do desconto').fill('INSS');
  await form.getByLabel('Valor retido (R$)').fill('200,00');
  await form.getByRole('button',{name:'＋ Discriminar desconto'}).click();
  await form.getByLabel('Descrição do desconto').nth(1).fill('Consignado');
  await form.getByLabel('Valor retido (R$)').nth(1).fill('300,00');
  await form.getByRole('button',{name:'Salvar composição sem movimentar caixa'}).click();
  const retentionPanel=panel.getByRole('region',{name:'Baixa de obrigação por desconto em folha'});
  await retentionPanel.getByText('Nenhuma retenção confirmada nesta competência.').waitFor();
  assert.equal((await (await page.request.get(APP+'/api/obligations/'+debt.obligationId)).json()).obligation.state,'open');
  const confirm=retentionPanel.getByRole('form',{name:'Confirmar retenção e baixar dívida'});
  await confirm.getByLabel('Desconto efetivamente retido').selectOption('1');
  await confirm.getByLabel('Obrigação a quitar').selectOption(debt.obligationId);
  await confirm.getByLabel('Valor confirmado da retenção (R$)').fill('300,00');
  await confirm.getByLabel('Data efetiva da retenção').fill('2026-11-30');
  await confirm.getByRole('button',{name:'Confirmar desconto em folha e baixar dívida'}).isDisabled();
  assert.equal(await confirm.getByRole('button',{name:'Confirmar desconto em folha e baixar dívida'}).isDisabled(),true);
  await confirm.getByRole('checkbox',{name:/Confirmo que essa retenção realmente ocorreu/}).check();
  await confirm.getByRole('button',{name:'Confirmar desconto em folha e baixar dívida'}).click();
  await retentionPanel.getByText('Origem: desconto em folha confirmado',{exact:false}).waitFor();
  const paid=(await (await page.request.get(APP+'/api/obligations/'+debt.obligationId)).json()).obligation;
  assert.deepEqual([paid.state,paid.paidCents,paid.outstandingCents],['paid',30000,0]);
  const after=(await (await page.request.get(APP+dash)).json()).dashboard;
  assert.deepEqual([after.cashFlow.incomeCents,after.cashFlow.expensesCents,after.balances.totalCents,after.obligations.outstandingCents],[250000,0,250000,0]);
  assert.equal((await (await page.request.get(APP+'/api/obligations/'+debt.obligationId+'/payments')).json()).payments.length,0);
  const history=(await (await page.request.get(APP+'/api/obligations/'+debt.obligationId+'/withholdings')).json()).withholdings;
  assert.equal(history.length,1);
  assert.equal(history[0].discountLabel,'Consignado');
  console.log('E4_WITHHOLDING_UI_PASS: explicit payroll confirmation settles R$300 from R$3000 gross / R$2500 net; no second bank expense');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
  await page.getByRole('button',{name:'Sair com segurança'}).last().click();
  await page.getByRole('button',{name:'Entrar com segurança'}).waitFor();
  await login(page,users[1]);
  assert.equal((await page.request.get(APP+'/api/obligations/'+debt.obligationId+'/withholdings')).status(),404);
  assert.equal((await page.request.get(APP+'/api/income-sources/'+src.sourceId+'/expectations/scheduled_2026-11-30/salary/withholdings')).status(),404);
  assert.deepEqual(errors,[]);
  console.log('E4_TENANT_UI_PASS: Better Auth A/B with opaque records and mobile');
 }finally{await ctx.close();await browser.close();}
}
main().catch(e=>{console.error('E4_E2E_FAIL:',e?.stack??String(e));process.exitCode=1;});
