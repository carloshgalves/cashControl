import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const API='http://127.0.0.1:8787',APP='http://127.0.0.1:5173';
const token=randomUUID().slice(0,8);
const users=[0,1].map(i=>({name:'F3User'+i,email:'f3-'+i+'-'+token+'@example.test',password:'Strong!Pass-'+randomUUID()}));
const request={include:true,asOf:'2026-11-23',from:'2026-11-23',to:'2026-12-13'};
async function waitReady(){for(let i=0;i<80;i++){try{
 const x=await fetch(API+'/api/planning/potential'),y=await fetch(APP);
 if(x.status===401&&y.ok)return;
 }catch{} await new Promise(r=>setTimeout(r,600));}throw new Error('F3_WORKER_NOT_READY');}
async function run(){
 await waitReady();
 for(const u of users){const r=await fetch(API+'/api/auth/sign-up/email',{method:'POST',
  headers:{origin:API,'content-type':'application/json'},body:JSON.stringify(u)});
  assert.equal(r.status,200,'F3 sign-up failure');
 }
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1366,height:900},locale:'pt-BR'});
 const page=await context.newPage();page.setDefaultTimeout(17000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
 await page.goto(APP,{waitUntil:'domcontentloaded'});
 await page.getByLabel('E-mail').fill(users[0].email);
 await page.getByLabel('Senha').fill(users[0].password);
 await page.getByRole('button',{name:'Entrar com segurança'}).click();
 await page.getByRole('heading',{name:'Seu dinheiro tem um ritmo.'}).waitFor();
 const source=await page.request.post(APP+'/api/income-sources',{data:{idempotencyKey:'f3-source-'+randomUUID(),
  name:'Freelas variáveis',relationship:'freelance',payKind:'variable',periodicity:'none'}});
 assert.equal(source.status(),201,JSON.stringify(await source.json()));
 const id=(await source.json()).source.sourceId;
 const q=async body=>{const r=await page.request.post(APP+'/api/planning/potential',{data:body});return {status:r.status(),body:await r.json()};};
 const off=await q({...request,include:false,sourceId:''});
 assert.equal(off.status,200);assert.equal(off.body.potential.status,'disabled');
 const insufficient=await q({...request,sourceId:id});
 assert.equal(insufficient.status,200);assert.equal(insufficient.body.potential.status,'insufficient');
 assert.equal(insufficient.body.potential.potentialAdditionalCents,0);
 const dashboard=await page.request.get(APP+'/api/dashboard?from=2026-11-01&to=2026-12-31');
 assert.equal((await dashboard.json()).dashboard.balances.totalCents,0);
 assert.equal((await q({...request,sourceId:'not-a-uuid'})).status,400);
 console.log('F3_OPTIONAL_NONCASH_PASS');
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
 await page.getByRole('button',{name:'Sair com segurança'}).last().click();
 await page.getByRole('button',{name:'Entrar com segurança'}).waitFor();
 await page.getByLabel('E-mail').fill(users[1].email);
 await page.getByLabel('Senha').fill(users[1].password);
 await page.getByRole('button',{name:'Entrar com segurança'}).click();
 await page.getByRole('heading',{name:'Seu dinheiro tem um ritmo.'}).waitFor();
 assert.equal((await q({...request,sourceId:id})).status,404);
 assert.deepEqual(errors,[]);
 console.log('F3_ISOLATION_PASS');
 }finally{await context.close();await browser.close();}
}
run().catch(e=>{console.error('F3_BROWSER_FAIL',e?.stack??e);process.exitCode=1;});
