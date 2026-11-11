import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const APP = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:8787';
const tag = randomUUID().slice(0,8);
const users = [
  {email:'ui-alice-'+tag+'@example.test',password:'Good!Password-'+randomUUID().slice(0,20),name:'Alice'},
  {email:'ui-bob-'+tag+'@example.test',password:'Good!Password-'+randomUUID().slice(0,20),name:'Bob'},
];
async function signup(user) {
  const response = await fetch(API+'/api/auth/sign-up/email',{
    method:'POST',headers:{origin:API,'content-type':'application/json'},
    body:JSON.stringify(user),
  });
  assert.equal(response.status,200,'Cannot create disposable browser test user: '+response.status);
}
async function ready() {
  for(let i=0;i<80;i++){
    try{const response=await fetch(API+'/api/accounts');if(response.status===401)return;}
    catch{}
    await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error('Local D1 Worker never became ready');
}
async function readyUi() {
  for (let i=0;i<60;i++) {
    try { const r=await fetch(APP);if(r.ok && (await r.text()).includes('cashControl')) return; } catch {}
    await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error('Vite frontend never became ready');
}
function log(step){process.stdout.write('UI_E2E_STEP: '+step+'\n');}
async function loginUi(page,user) {
  await page.getByLabel('E-mail').fill(user.email);
  await page.getByLabel('Senha').fill(user.password);
  await page.getByRole('button',{name:'Entrar com segurança'}).click();
  await page.getByRole('heading',{name:'Seu dinheiro tem um ritmo.'}).waitFor();
}
async function modal(page, mode) {
  await page.getByRole('button',{name:'Registrar',exact:true}).click();
  if(mode==='income')await page.getByRole('button',{name:'Entrada',exact:true}).click();
  if(mode==='transfer')await page.getByRole('button',{name:'Transferência',exact:true}).click();
}
async function monthNovember(page) {
  await page.getByText('novembro de 2026',{exact:true}).first().waitFor();
}
async function main(){
  await ready();
  await readyUi();
  await Promise.all(users.map(signup));
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1366,height:900},locale:'pt-BR'});
  const page=await context.newPage();
  page.on('pageerror',e=>{throw e;});
  try {
    log('Open UI and login as Alice');
    await page.goto(APP,{waitUntil:'domcontentloaded'});
    await loginUi(page,users[0]);
    await monthNovember(page);
    log('First empty state creates general wallet without any bank');
    await page.getByRole('button',{name:/Criar minha primeira carteira/}).click();
    await page.getByLabel('Nome da conta').fill('Carteira principal');
    await page.locator('#entry-amount').fill('100,00');
    await page.getByRole('button',{name:'Criar conta',exact:true}).click();
    await page.getByText('R$ 100,00').first().waitFor();
    log('Real income and expense appear in chart and change current balance');
    await modal(page,'income');
    await page.getByLabel('Valor (R$)').fill('31,01');
    await page.getByLabel('Descrição').fill('Serviço avulso');
    await page.getByLabel('Data efetiva').fill('2026-11-10');
    await page.getByRole('button',{name:'Confirmar registro'}).click();
    await page.getByText('R$ 131,01').first().waitFor();
    await modal(page,'expense');
    await page.getByLabel('Valor (R$)').fill('10,01');
    await page.getByLabel('Descrição').fill('Mercado');
    await page.getByLabel('Data efetiva').fill('2026-11-10');
    await page.getByRole('button',{name:'Confirmar registro'}).click();
    await page.getByText('R$ 121,00').first().waitFor();
    log('Week buttons are interactive and selected week exposes actual history');
    await page.getByRole('button',{name:/08–14:/}).click();
    await page.getByText('Serviço avulso').first().waitFor();
    await page.getByRole('button',{name:/01–07:/}).click();
    await page.getByText('Nenhum movimento registrado nessa semana.').waitFor();
    log('Create another account and move cash without inventing income');
    await page.getByRole('button',{name:'Minhas contas'}).click();
    await page.getByRole('button',{name:/Adicionar conta/}).click();
    await page.getByLabel('Nome da conta').fill('Reserva');
    await page.locator('#entry-amount').fill('0,00');
    await page.getByRole('button',{name:'Criar conta',exact:true}).click();
    await page.getByRole('button',{name:/Transferir/}).click();
    await page.getByLabel('Valor (R$)').fill('25,00');
    await page.getByLabel('Conta de origem').selectOption({index:0});
    await page.getByLabel('Conta de destino').selectOption({label:'Reserva'});
    await page.getByLabel('Data efetiva').fill('2026-11-10');
    await page.getByRole('button',{name:'Confirmar registro'}).click();
    await page.getByText('R$ 96,00').first().waitFor();
    log('Pay partial obligation via approved interactive upcoming card');
    const billResponse=await page.request.post(APP+'/api/obligations',{
      headers:{origin:APP},
      data:{idempotencyKey:'ui-obligation-'+tag,title:'Internet',amount:'45.00',dueOn:'2026-11-25'},
    });
    assert.equal(billResponse.status(),201,'Obligation setup failed');
    await page.reload();
    await page.getByRole('heading',{name:'Seu dinheiro tem um ritmo.'}).waitFor();
    await page.getByRole('button',{name:/Internet.*R\$.*45,00/}).click();
    await page.getByRole('button',{name:/Registrar pagamento/}).click();
    await page.getByLabel('Valor (R$)').fill('15,00');
    await page.getByRole('button',{name:'Registrar pagamento efetivo'}).click();
    await page.getByText('R$ 30,00').first().waitFor();
    const dashboard=await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30');
    assert.equal(dashboard.status(),200);
    const d=(await dashboard.json()).dashboard;
    assert.equal(d.cashFlow.incomeCents,3101);
    assert.equal(d.cashFlow.expensesCents,2501);
    assert.equal(d.cashFlow.netCents,600);
    assert.equal(d.balances.totalCents,10600);
    assert.equal(d.obligations.outstandingCents,3000);
    log('Logout revokes actual session');
    await page.getByRole('button',{name:'Sair com segurança'}).click();
    await page.getByRole('button',{name:'Entrar com segurança'}).waitFor();
    assert.equal((await page.request.get(APP+'/api/accounts')).status(),401);
    log('Bob sees only their own empty finances after login');
    await loginUi(page,users[1]);
    await page.getByText('Nenhuma conta cadastrada.').waitFor();
    assert.equal((await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-11-30')
      .then(r=>r.json())).dashboard.balances.totalCents,0);
    log('Mobile width: navigation and no horizontal overflow');
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('navigation',{name:'Navegação principal'}).getByRole('button',{name:'Agenda'}).click();
    await page.getByRole('heading',{name:'Agenda de compromissos'}).waitFor();
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2);
    assert.equal(overflow,false,'Mobile layout overflows viewport');
    console.log('UI_BROWSER_E2E_PASS: real Better Auth login/logout, centavo postings, week chart, partial bills, tenant isolation, responsive mobile');
  } finally {
    await context.close(); await browser.close();
  }
}
main().catch(e=>{console.error('UI_BROWSER_E2E_FAIL:',e?.stack??String(e));process.exitCode=1;});
