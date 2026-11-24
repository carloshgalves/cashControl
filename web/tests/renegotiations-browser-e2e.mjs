import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const API='http://127.0.0.1:8787',APP='http://127.0.0.1:5173';
const token=randomUUID().slice(0,8);
const users=[0,1].map(i=>({name:'G2User'+i,email:'g2-'+i+'-'+token+'@example.test',password:'Strong!Pass-'+randomUUID()}));
async function waitReady(){for(let i=0;i<90;i++){try{
 const a=await fetch(API+'/api/renegotiations'),b=await fetch(APP);
 if(a.status===401&&b.ok)return;
 }catch{}await new Promise(r=>setTimeout(r,600));}throw Error('G2_WORKER_UNAVAILABLE');}
async function run(){
 await waitReady();
 for(const u of users){const r=await fetch(API+'/api/auth/sign-up/email',{method:'POST',
 headers:{origin:API,'content-type':'application/json'},body:JSON.stringify(u)});
 assert.equal(r.status,200,'Better Auth signup failed');}
 const browser=await chromium.launch({headless:true}),ctx=await browser.newContext({viewport:{width:1366,height:900},locale:'pt-BR'});
 const page=await ctx.newPage();page.setDefaultTimeout(18000);const errors=[];page.on('pageerror',x=>errors.push(x.message));
 const signin=async u=>{await page.getByLabel('E-mail').fill(u.email);await page.getByLabel('Senha').fill(u.password);
 await page.getByRole('button',{name:'Entrar com segurança'}).click();
 await page.getByRole('heading',{name:'Seu dinheiro tem um ritmo.'}).waitFor();};
 const post=async(path,body)=>{const r=await page.request.post(APP+path,{data:body});assert.equal(r.status(),201,JSON.stringify(await r.json()));return r.json();};
 try{
 await page.goto(APP,{waitUntil:'domcontentloaded'});await signin(users[0]);
 const acc=(await post('/api/accounts',{idempotencyKey:'g2-acc-'+randomUUID(),name:'Carteira',
 kind:'general',funding:{mode:'external',amount:'2000.00'}})).account;
 const card=(await post('/api/cards',{idempotencyKey:'g2-card-'+randomUUID(),name:'Cartão',
 limit:'3000.00',closingDay:25,dueDay:5})).card;
 await post('/api/cards/'+card.cardId+'/purchases',{idempotencyKey:'g2-purchase-'+randomUUID(),
 title:'Compra real',purchasedOn:'2026-11-19',total:'1500.00',installments:1});
 await post('/api/cards/'+card.cardId+'/invoices/2026-11/payments',{idempotencyKey:'g2-old-pay-'+randomUUID(),
 accountId:acc.accountId,amount:'900.00',method:'pix',paidOn:'2026-11-20'});
 const newPlan=(await post('/api/renegotiations',{idempotencyKey:'g2-plan-'+randomUUID(),
 subject:{kind:'card_invoice',cardId:card.cardId,cycle:'2026-11'},
 expectedOutstanding:'600.00',fees:'90.00',agreedOn:'2026-11-20',
 installments:[
  {dueOn:'2026-12-10',amount:'230.00'},{dueOn:'2027-01-10',amount:'230.00'},
  {dueOn:'2027-02-10',amount:'230.00'},
 ]})).renegotiation;
 assert.deepEqual([newPlan.originalRemainingCents,newPlan.feesCents,newPlan.newTotalCents],[60000,9000,69000]);
 const get=async p=>{const r=await page.request.get(APP+p);return {status:r.status(),body:await r.json()};};
 const d=await get('/api/dashboard?from=2026-11-01&to=2027-02-28');
 assert.deepEqual([d.body.dashboard.cardInvoices.outstandingCents,d.body.dashboard.cashFlow.expensesCents],[69000,90000]);
 const old=await get('/api/cards/'+card.cardId+'/invoices/2026-11');
 assert.equal(old.body.invoice.outstandingCents,60000);
 console.log('G2_SCHEDULE_REPLACEMENT_PASS: 600 old remainder replaced by 690 plan');
 for(let i=1;i<=3;i++)await post('/api/renegotiations/'+newPlan.agreementId+'/payments',{
  idempotencyKey:'g2-new-pay-'+i+'-'+randomUUID(),installmentNo:i,
  accountId:acc.accountId,amount:'230.00',method:'pix',paidOn:'2026-12-10'});
 const settled=await get('/api/renegotiations/'+newPlan.agreementId);
 assert.equal(settled.body.renegotiation.outstandingCents,0);
 const after=await get('/api/dashboard?from=2026-11-01&to=2027-02-28');
 assert.deepEqual([after.body.dashboard.cardInvoices.outstandingCents,after.body.dashboard.cashFlow.expensesCents],[0,159000]);
 console.log('G2_ATOMIC_INSTALLMENT_PASS: 3 x 230, old 900 unchanged, real debit once');
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
 await page.getByRole('button',{name:'Sair com segurança'}).last().click();
 await page.getByRole('button',{name:'Entrar com segurança'}).waitFor();await signin(users[1]);
 assert.equal((await get('/api/renegotiations/'+newPlan.agreementId)).status,404);
 assert.equal((await page.request.post(APP+'/api/renegotiations/'+newPlan.agreementId+'/payments',{data:{
 idempotencyKey:'g2-cross-'+randomUUID(),installmentNo:1,accountId:acc.accountId,amount:'1.00',method:'pix',paidOn:'2026-12-10'}})).status(),404);
 assert.deepEqual(errors,[]);
 console.log('G2_OWNER_ISOLATION_PASS: Better Auth Alice/Bob and 390px');
 }finally{await ctx.close();await browser.close();}
}
run().catch(err=>{console.error('G2_BROWSER_FAIL',err?.stack??err);process.exitCode=1;});
