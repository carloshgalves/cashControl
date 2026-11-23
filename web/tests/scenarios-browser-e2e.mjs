import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
const API='http://127.0.0.1:8787',APP='http://127.0.0.1:5173';
const tag=randomUUID().slice(0,8);
const users=[
 {email:'f2-a-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Alice'},
 {email:'f2-b-'+tag+'@example.test',password:'Strong!Pass-'+randomUUID(),name:'Bob'},
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
  await post('/api/accounts',{idempotencyKey:'f2-wallet-'+randomUUID(),name:'Carteira',
   kind:'general',funding:{mode:'external',amount:'1200.00'}});
  await post('/api/obligations',{idempotencyKey:'f2-bill-'+randomUUID(),title:'Aluguel de novembro',
   amount:'300.00',dueOn:'2026-11-20'});
  const source=(await post('/api/income-sources',{idempotencyKey:'f2-freelance-'+randomUUID(),
   name:'Freelancer variável',relationship:'freelance',payKind:'variable',periodicity:'none'})).source;
  const occ=(await post('/api/income-sources/'+source.sourceId+'/expectations',{
   idempotencyKey:'f2-manual-'+randomUUID(),expectedOn:'2026-11-28',amount:'400.00'})).occurrenceKey;
  const intent=(await post('/api/intentions',{idempotencyKey:'f2-intention-'+randomUUID(),
   title:'Notebook para trabalhar',amount:'500.00',plannedOn:'2026-11-22'})).intention;
  await post('/api/intentions/'+intent.intentionId+'/events',{
   idempotencyKey:'f2-reserve-'+randomUUID(),action:'reserve',reserveAmount:'500.00'});

  await page.getByRole('button',{name:'Planejamento'}).first().click();
  const panel=page.getByRole('region',{name:'Simulação financeira sem lançamento'});
  const form=panel.getByRole('form',{name:'Parâmetros da simulação'});
  await form.getByLabel('Data inicial da simulação').fill('2026-11-11');
  await form.getByLabel('Data final da simulação').fill('2026-12-31');
  await form.getByRole('button',{name:'Simular sem gravar compra ou pagamento'}).click();
  const results=panel.getByRole('region',{name:'Resultado comparativo da simulação'});
  await results.getByText('Renda não recebida',{exact:true}).waitFor();
  const noPurchase=(await (await page.request.post(APP+'/api/planning/simulate',{data:{
   from:'2026-11-11',to:'2026-12-31'}})).json()).simulation;
  assert.deepEqual([noPurchase.openingRealCashCents,noPurchase.activeVirtualReserveCents,
   noPurchase.existingOutstandingObligationsCents,noPurchase.unreceivedExplicitIncomeCents,
   noPurchase.conservative.endingFreeMarginCents,noPurchase.planned.endingFreeMarginCents],
   [120000,50000,30000,40000,40000,80000]);
  assert.equal((await (await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30')).json()).dashboard.cashFlow.expensesCents,0);
  console.log('F2_CONSERVATIVE_PLANNED_PASS: explicit unreceived income R$400 only in planned, current cash R$1200');

  await form.getByRole('checkbox',{name:/Incluir compra hipotética/}).check();
  await form.getByLabel('Compra simulada').selectOption(intent.intentionId);
  await form.getByLabel('Vencimento hipotético').fill('2026-12-15');
  await form.getByRole('button',{name:'Simular sem gravar compra ou pagamento'}).click();
  await results.getByText('Compromisso R$',{exact:false}).first().waitFor();
  const simulated=(await (await page.request.post(APP+'/api/planning/simulate',{data:{
   from:'2026-11-11',to:'2026-12-31',hypothetical:{amount:'500.00',purchaseOn:'2026-11-22',
    dueOn:'2026-12-15',intentionId:intent.intentionId}}})).json()).simulation;
  assert.deepEqual([simulated.hypothetical.replacedExistingReserveCents,
   simulated.conservative.endingFreeMarginCents,simulated.planned.endingFreeMarginCents],[50000,40000,80000]);
  assert.equal((await (await page.request.get(APP+'/api/obligations')).json()).obligations.length,1,
   'simulated purchase must NOT create a second obligation');
  assert.equal((await (await page.request.get(APP+'/api/intentions/'+intent.intentionId)).json()).intention.state,'reserved');
  console.log('F2_HYPOTHETICAL_PASS: R$500 virtual reserve released and replaced by R$500 hypothetical obligation, no write');

  await post('/api/income-sources/'+source.sourceId+'/expectations/'+occ+'/events',{
   idempotencyKey:'f2-cancel-'+randomUUID(),state:'canceled',reason:'Serviço cancelado'});
  await form.getByRole('button',{name:'Simular sem gravar compra ou pagamento'}).click();
  await results.getByText('Nenhuma expectativa explicitamente cadastrada neste período.').first().waitFor({state:'hidden'}).catch(()=>{});
  const canceled=(await (await page.request.post(APP+'/api/planning/simulate',{data:{
   from:'2026-11-11',to:'2026-12-31'}})).json()).simulation;
  assert.deepEqual([canceled.unreceivedExplicitIncomeCents,canceled.planned.endingFreeMarginCents],[0,40000]);
  console.log('F2_CANCELED_INCOME_PASS: cancelled freelance disappears from planned scenario, never from real bank');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,'mobile overflow');
  await page.getByRole('button',{name:'Sair com segurança'}).last().click();
  await page.getByRole('button',{name:'Entrar com segurança'}).waitFor();
  await login(page,users[1]);
  assert.equal((await page.request.post(APP+'/api/planning/simulate',{data:{
   from:'2026-11-11',to:'2026-12-31',hypothetical:{amount:'500.00',purchaseOn:'2026-11-22',
    dueOn:'2026-12-15',intentionId:intent.intentionId}}})).status(),404);
  const aliceIsolated=(await (await page.request.post(APP+'/api/planning/simulate',{data:{
   from:'2026-11-11',to:'2026-12-31'}})).json()).simulation;
  assert.deepEqual([aliceIsolated.openingRealCashCents,aliceIsolated.activeVirtualReserveCents,
   aliceIsolated.unreceivedExplicitIncomeCents],[0,0,0]);
  assert.deepEqual(errors,[]);
  console.log('F2_TENANT_UI_PASS: Better Auth A/B and responsive scenario panel');
 }finally{await ctx.close();await browser.close();}
}
main().catch(e=>{console.error('F2_E2E_FAIL:',e?.stack??String(e));process.exitCode=1;});
