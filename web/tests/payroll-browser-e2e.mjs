import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
const API='http://127.0.0.1:8787',APP='http://127.0.0.1:5173';
const tag=randomUUID().slice(0,8);
const users=[
 {email:'e3-a-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Alice'},
 {email:'e3-b-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Bob'},
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
  await page.getByRole('button',{name:'Rendas'}).first().click();
  const screen=page.getByRole('region',{name:'Fontes e expectativas de renda'});
  await screen.getByRole('button',{name:'＋ Nova fonte'}).click();
  const source=screen.getByRole('form',{name:'Nova fonte de renda'});
  await source.getByLabel('Nome da fonte').fill('Salário CLT E3');
  await source.getByLabel('Tipo de vínculo').selectOption('employment');
  await source.getByLabel('Natureza da remuneração').selectOption('fixed');
  await source.getByLabel('Periodicidade informada').selectOption('monthly');
  await source.getByLabel('Primeira data prevista').fill('2026-01-31');
  await source.getByLabel('Parcela fixa líquida prevista (R$, opcional)').fill('2500,00');
  await source.getByRole('button',{name:'Cadastrar fonte sem creditar caixa'}).click();
  const src=(await (await page.request.get(APP+'/api/income-sources')).json()).sources[0];
  assert.equal(src.fixedNetCents,250000);
  const nov=APP+'/api/income-calendar?from=2026-11-01&to=2026-11-30';
  assert.equal((await (await page.request.get(nov)).json()).calendar.expectations[0].expectedCents,250000);
  await screen.getByRole('region',{name:'Calendário de expectativas'}).getByRole('button',{name:/Salário CLT E3/}).click();
  const panel=screen.getByRole('region',{name:'Remuneração de Salário CLT E3'});
  await panel.getByRole('button',{name:'Registrar reajuste'}).click();
  const raise=panel.getByRole('form',{name:'Reajuste salarial'});
  await raise.getByLabel('Início da vigência').fill('2026-11-01');
  await raise.getByLabel('Novo salário líquido (R$)').fill('2750,00');
  await raise.getByLabel('Motivo do reajuste').fill('Aumento salarial permanente');
  await raise.getByRole('button',{name:'Registrar reajuste com vigência'}).click();
  await panel.getByText('Aumento salarial permanente').first().waitFor();
  assert.equal((await (await page.request.get(nov)).json()).calendar.expectations[0].expectedCents,275000);
  const oct=await page.request.get(APP+'/api/income-calendar?from=2026-10-01&to=2026-10-31');
  assert.equal((await oct.json()).calendar.expectations[0].expectedCents,250000);
  await panel.getByRole('button',{name:'Informar composição'}).click();
  const form=panel.getByRole('form',{name:'Demonstrativo de remuneração'});
  await form.getByLabel('Salário líquido desta competência (R$)').fill('3000,00');
  assert.equal(await form.getByLabel('Salário bruto (R$, opcional)').inputValue(),'');
  await form.getByRole('button',{name:'＋ Adicional ou redução'}).click();
  await form.getByLabel('Tipo').selectOption('overtime');
  await form.getByLabel('Motivo').fill('Horas extras novembro');
  await form.getByLabel('Valor absoluto (R$)').fill('250,00');
  await form.getByRole('button',{name:'Salvar composição sem movimentar caixa'}).click();
  await panel.getByText('Líquido informado').waitFor();
  assert.equal((await (await page.request.get(nov)).json()).calendar.expectations[0].expectedCents,300000);
  assert.equal((await (await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30')).json()).dashboard.cashFlow.incomeCents,0);
  await page.getByRole('button',{name:'Próximo mês'}).click();
  const dec=(await (await page.request.get(APP+'/api/income-calendar?from=2026-12-01&to=2026-12-31')).json()).calendar;
  assert.equal(dec.expectations[0].expectedCents,275000,'overtime cannot silently change December base');
  await page.getByRole('button',{name:'Mês anterior'}).click();
  // New statement is appended, not a rewrite: incomplete gross reconciliation.
  await screen.getByRole('region',{name:'Calendário de expectativas'}).getByRole('button',{name:/Salário CLT E3/}).click();
  const panel2=screen.getByRole('region',{name:'Remuneração de Salário CLT E3'});
  await panel2.getByRole('button',{name:'Registrar nova versão'}).click();
  const f2=panel2.getByRole('form',{name:'Demonstrativo de remuneração'});
  await f2.getByLabel('Salário líquido desta competência (R$)').fill('3000,00');
  await f2.getByLabel('Salário bruto (R$, opcional)').fill('3500,00');
  await f2.getByRole('button',{name:'＋ Discriminar desconto'}).click();
  await f2.getByLabel('Descrição do desconto').fill('INSS');
  await f2.getByLabel('Valor retido (R$)').fill('300,00');
  await f2.getByRole('button',{name:'Salvar composição sem movimentar caixa'}).click();
  await panel2.getByText('Divergência de conciliação pendente',{exact:false}).waitFor();
  const salaryURL=APP+'/api/income-sources/'+src.sourceId+'/expectations/scheduled_2026-11-30/salary';
  const salary=(await (await page.request.get(salaryURL)).json());
  assert.deepEqual([salary.statement.grossStatus,salary.statement.grossDifferenceCents,salary.history.length],['pending',20000,2]);
  assert.equal((await (await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30')).json()).dashboard.cashFlow.incomeCents,0);
  console.log('E3_PAYROLL_UI_PASS: net-only, +250 overtime, Nov raise from 2500 to 2750, Dec unchanged, gross discrepancy pending, zero cash');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,'mobile overflow');
  await page.getByRole('button',{name:'Sair com segurança'}).last().click();
  await page.getByRole('button',{name:'Entrar com segurança'}).waitFor();
  await login(page,users[1]);
  assert.equal((await page.request.get(salaryURL)).status(),404);
  assert.deepEqual((await (await page.request.get(APP+'/api/income-sources')).json()).sources,[]);
  assert.deepEqual(errors,[]);
  console.log('E3_TENANT_UI_PASS: Better Auth A/B and mobile');
 }finally{await ctx.close();await browser.close();}
}
main().catch(e=>{console.error('E3_E2E_FAIL:',e?.stack??String(e));process.exitCode=1;});
