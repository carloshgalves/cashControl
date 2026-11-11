import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createCard,createPurchase,listCards,getCard,listPurchases,listInvoices,getInvoice,
 getPurchaseInstallments,schedule,CreditCardUnavailable,CreditIdempotencyConflict } from '../src/backend/cards/cards.ts';
import { getDashboard } from '../src/backend/dashboard/dashboard.ts';
import { handleFinancialHttp } from '../src/backend/http/accounts-handler.ts';

class Stmt {
 constructor(db,sql,params=[]){this.db=db;this.sql=sql;this.params=params;}
 bind(...args){return new Stmt(this.db,this.sql,args);}
 async first(){return this.db.prepare(this.sql).get(...this.params)??null;}
 async all(){return {results:this.db.prepare(this.sql).all(...this.params)};}
 async run(){return this.db.prepare(this.sql).run(...this.params);}
}
class Db {
 constructor(){
  this.raw=new DatabaseSync(':memory:');this.raw.exec('PRAGMA foreign_keys=ON');
  for(const name of ['0001_financial_accounts.sql','0002_better_auth.sql','0003_cash_movements.sql',
   '0004_financial_obligations.sql','0005_internal_transfers.sql','0006_cancellations_refunds.sql',
   '0007_credit_cards_installments.sql'])
   this.raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  this.queue=Promise.resolve();
 }
 prepare(sql){return new Stmt(this.raw,sql);}
 batch(stmts){
  const next=this.queue.then(async()=>{
   this.raw.exec('BEGIN IMMEDIATE');try{
    const result=[];for(const s of stmts)result.push(await s.run());
    this.raw.exec('COMMIT');return result;
   }catch(e){this.raw.exec('ROLLBACK');throw e;}
  });
  this.queue=next.catch(()=>{});return next;
 }
 close(){this.raw.close();}
}
async function withDb(fn){const db=new Db();try{await fn(db);}finally{db.close();}}
const actor=userId=>({userId});
const clock=()=>new Date('2026-11-11T13:00:00Z');
const cardInput=(key,overrides={})=>({
 idempotencyKey:'card-req-'+key,name:'Cartão principal',institution:'Banco teste',
 limitCents:150000,closingDay:25,dueDay:5,...overrides,
});
const purchaseInput=(cardId,key,overrides={})=>({
 idempotencyKey:'purchase-req-'+key,cardId,title:'Notebook',merchant:'Loja',
 category:'Tecnologia',purchasedOn:'2026-11-20',totalCents:10001,installments:10,...overrides,
});
async function createTestCard(db,user='alice',suffix='one',overrides={}){
 return createCard(db,actor(user),cardInput(suffix,overrides),clock);
}

test('cycle rule: purchase on closing day, after closing, February clamping and due-day placement',()=>{
 const base={closingDay:25,dueDay:5};
 assert.deepEqual(schedule(base,'2026-11-25',10001,10).map(x=>x.cycle).slice(0,2),['2026-11','2026-12']);
 assert.equal(schedule(base,'2026-11-25',100,1)[0].dueOn,'2026-12-05');
 assert.equal(schedule(base,'2026-11-26',100,1)[0].cycle,'2026-12');
 assert.equal(schedule(base,'2026-11-26',100,1)[0].dueOn,'2027-01-05');
 assert.equal(schedule({closingDay:10,dueDay:20},'2026-11-10',100,1)[0].dueOn,'2026-11-20');
 assert.equal(schedule({closingDay:31,dueDay:5},'2026-02-28',100,1)[0].cycle,'2026-02');
 assert.equal(schedule({closingDay:31,dueDay:5},'2024-02-29',100,1)[0].dueOn,'2024-03-05');
 assert.equal(schedule({closingDay:31,dueDay:31},'2026-02-28',100,1)[0].dueOn,'2026-03-31');
 const x=schedule(base,'2026-12-26',101,2);
 assert.deepEqual(x.map(v=>v.cycle),['2027-01','2027-02']);
 assert.deepEqual(x.map(v=>v.amountCents),[51,50]);
 for(const bad of [0,61,1.5])assert.throws(()=>schedule(base,'2026-11-10',100,bad));
 assert.throws(()=>schedule(base,'2026-11-10',5,6));
 assert.throws(()=>schedule(base,'2026-02-30',100,1));
});

test('register card without bank: credit limit is not cash and card is owner-private',()=>withDb(async db=>{
 const a=await createTestCard(db);
 assert.equal(a.limitCents,150000);
 const empty=await getDashboard(db,actor('alice'),{from:'2026-11-01',to:'2026-11-30'});
 assert.equal(empty.balances.totalCents,0);
 assert.equal(empty.cashFlow.netCents,0);
 assert.equal(empty.obligations.outstandingCents,0);
 assert.deepEqual(await listCards(db,actor('bob')),[]);
 assert.equal(await getCard(db,actor('bob'),a.cardId),null);
 assert.equal((await listCards(db,actor('alice')))[0].cardId,a.cardId);
 assert.deepEqual(await createCard(db,actor('alice'),cardInput('one'),clock),a);
 await assert.rejects(()=>createCard(db,actor('alice'),cardInput('one',{closingDay:26}),clock),CreditIdempotencyConflict);
 const b=await createCard(db,actor('bob'),cardInput('one'),clock);
 assert.notEqual(b.cardId,a.cardId,'same retry key for different owners must not collide');
}));

test('10x remainder, invoice cycles, purchase-level and invoice-level drilldowns',()=>withDb(async db=>{
 const card=await createTestCard(db);
 const result=await createPurchase(db,actor('alice'),purchaseInput(card.cardId,'ten'),clock);
 assert.equal(result.installments.length,10);
 assert.deepEqual(result.installments.map(i=>i.amountCents),[1001,...Array(9).fill(1000)]);
 assert.equal(result.installments.reduce((s,i)=>s+i.amountCents,0),10001);
 assert.deepEqual(result.installments.slice(0,2).map(i=>i.cycle),['2026-11','2026-12']);
 assert.equal(result.installments[0].dueOn,'2026-12-05');
 assert.equal(result.installments[9].cycle,'2027-08');
 const fromPurchase=await getPurchaseInstallments(db,actor('alice'),card.cardId,result.purchase.purchaseId);
 assert.deepEqual(fromPurchase,result.installments);
 const nov=await getInvoice(db,actor('alice'),card.cardId,'2026-11');
 assert.equal(nov.invoice.totalCents,1001);
 assert.equal(nov.invoice.purchaseCount,1);
 const all=await listInvoices(db,actor('alice'),card.cardId);
 assert.equal(all.length,10);
 assert.equal(all.reduce((s,i)=>s+i.totalCents,0),10001);
 assert.equal((await listPurchases(db,actor('alice'),card.cardId)).length,1);
 assert.equal((await getDashboard(db,actor('alice'),{from:'2026-11-01',to:'2026-11-30'})).cashFlow.netCents,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM financial_obligations').get().n,0);
}));

test('multiple purchases consolidate once; same retry returns original without creating new installments',()=>withDb(async db=>{
 const card=await createTestCard(db);
 const a=purchaseInput(card.cardId,'first',{totalCents:10000,installments:2});
 const b=purchaseInput(card.cardId,'second',{title:'Mesa',totalCents:30000,installments:1});
 const first=await createPurchase(db,actor('alice'),a,clock);
 const again=await createPurchase(db,actor('alice'),a,clock);
 assert.deepEqual(again,first);
 await assert.rejects(()=>createPurchase(db,actor('alice'),{...a,totalCents:12000},clock),CreditIdempotencyConflict);
 await createPurchase(db,actor('alice'),b,clock);
 const november=await getInvoice(db,actor('alice'),card.cardId,'2026-11');
 assert.equal(november.invoice.totalCents,35000);
 assert.equal(november.invoice.purchaseCount,2);
 assert.equal(november.invoice.installmentCount,2);
 assert.equal(november.installments.length,2);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM credit_purchases').get().n,2);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM credit_installments').get().n,3);
}));

test('concurrent retry and mixed payload do not double book or leave orphan installments',()=>withDb(async db=>{
 const card=await createTestCard(db);
 const input=purchaseInput(card.cardId,'race');
 const res=await Promise.all([createPurchase(db,actor('alice'),input,clock),createPurchase(db,actor('alice'),input,clock)]);
 assert.equal(res[0].purchase.purchaseId,res[1].purchase.purchaseId);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM credit_purchases').get().n,1);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM credit_installments').get().n,10);
 const wrong=await Promise.allSettled([
  createPurchase(db,actor('alice'),purchaseInput(card.cardId,'collision',{title:'A'}),clock),
  createPurchase(db,actor('alice'),purchaseInput(card.cardId,'collision',{title:'B'}),clock),
 ]);
 assert.equal(wrong.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(wrong.filter(x=>x.status==='rejected').length,1);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM credit_purchases').get().n,2);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM credit_installments').get().n,20);
}));

test('DB triggers reject edits, deletes and parts exceeding original total',()=>withDb(async db=>{
 const card=await createTestCard(db),p=await createPurchase(db,actor('alice'),purchaseInput(card.cardId,'immutable'),clock);
 assert.throws(()=>db.raw.prepare('UPDATE credit_cards SET limit_cents=1 WHERE card_id=?').run(card.cardId));
 assert.throws(()=>db.raw.prepare('DELETE FROM credit_purchases WHERE purchase_id=?').run(p.purchase.purchaseId));
 assert.throws(()=>db.raw.prepare('UPDATE credit_installments SET amount_cents=99 WHERE purchase_id=?').run(p.purchase.purchaseId));
 assert.throws(()=>db.raw.prepare('INSERT INTO credit_installments(owner_user_id,purchase_id,installment_no,card_id,invoice_cycle,due_on,amount_cents) VALUES(?,?,?,?,?,?,?)')
   .run('alice',p.purchase.purchaseId,11,card.cardId,'2027-09','2027-10-05',1));
}));

test('cross-owner knowledge of card and purchase IDs does not reveal records or change cash',()=>withDb(async db=>{
 const a=await createTestCard(db,'alice','owner');
 const p=await createPurchase(db,actor('alice'),purchaseInput(a.cardId,'owner'),clock);
 assert.equal(await getCard(db,actor('bob'),a.cardId),null);
 await assert.rejects(()=>createPurchase(db,actor('bob'),purchaseInput(a.cardId,'theft'),clock),CreditCardUnavailable);
 await assert.rejects(()=>listInvoices(db,actor('bob'),a.cardId),CreditCardUnavailable);
 assert.equal(await getPurchaseInstallments(db,actor('bob'),a.cardId,p.purchase.purchaseId),null);
 const bob=await createTestCard(db,'bob','owner');
 assert.equal(await getInvoice(db,actor('bob'),bob.cardId,'2026-11'),null);
 assert.deepEqual(await listPurchases(db,actor('bob'),bob.cardId),[]);
}));

const base='http://127.0.0.1:8787',now=Date.parse('2026-11-11T13:00:00.000Z');
const lookup=async headers=>{
 const user=headers.get('cookie')==='token=alice'?'alice':headers.get('cookie')==='token=bob'?'bob':null;
 return user?{user:{id:user},session:{userId:user,expiresAt:new Date(now+120000)}}:null;
};
async function http(db,path,cookie='token=alice',method='GET',body=null,origin=base){
 return handleFinancialHttp(new Request(base+path,{
  method,headers:{cookie,'x-user-id':'bob','origin':origin,...(body?{'content-type':'application/json'}:{})},
  ...(body?{body:JSON.stringify(body)}:{}),
 }),db,lookup,base,()=>now);
}
test('HTTP route validates origin, owner, input and prevents foreign resource enumeration',()=>withDb(async db=>{
 const unauth=await http(db,'/api/cards','');assert.equal(unauth.status,401);
 assert.equal((await http(db,'/api/cards','token=alice','POST',{
  idempotencyKey:'key-owner-first',name:'A',limit:'1000.00',closingDay:25,dueDay:5,
 },'https://evil.test')).status,403);
 const bad=await http(db,'/api/cards','token=alice','POST',{
  idempotencyKey:'key-owner-first',name:'A',limit:'1000.00',closingDay:0,dueDay:5,
 });assert.equal(bad.status,400);
 const cardResponse=await http(db,'/api/cards','token=alice','POST',{
  idempotencyKey:'key-owner-first',name:'Principal',limit:'1000.00',closingDay:25,dueDay:5,
 });
 assert.equal(cardResponse.status,201);
 const card=(await cardResponse.json()).card;
 assert.equal((await http(db,'/api/cards')).status,200);
 assert.equal((await http(db,'/api/cards?ownerId=bob')).status,400);
 assert.equal((await http(db,'/api/cards/'+card.cardId,'token=bob')).status,404);
 const payload={idempotencyKey:'purchase-owner-one',title:'Consulta',total:'100.01',purchasedOn:'2026-11-20',installments:10};
 const response=await http(db,'/api/cards/'+card.cardId+'/purchases','token=alice','POST',payload);
 assert.equal(response.status,201);
 const {purchase,installments}=await response.json();
 assert.equal(installments.length,10);
 const retry=await http(db,'/api/cards/'+card.cardId+'/purchases','token=alice','POST',payload);
 assert.equal(retry.status,201);
 assert.equal((await retry.json()).purchase.purchaseId,purchase.purchaseId);
 assert.equal((await http(db,'/api/cards/'+card.cardId+'/purchases','token=bob')).status,404);
 assert.equal((await http(db,'/api/cards/'+card.cardId+'/purchases/'+purchase.purchaseId,'token=bob')).status,404);
 assert.equal((await http(db,'/api/cards/'+card.cardId+'/invoices/2026-11','token=bob')).status,404);
 assert.equal((await http(db,'/api/cards/'+card.cardId+'/invoices/2026-11','token=alice')).status,200);
 assert.equal((await http(db,'/api/cards/'+card.cardId+'/invoices?limit=1&offset=0')).status,200);
 assert.equal((await http(db,'/api/cards/'+card.cardId+'/invoices?limit=1&limit=2')).status,400);
 assert.equal((await http(db,'/api/cards/'+card.cardId+'/purchases','token=alice','POST',{
  ...payload,idempotencyKey:'invalid-amount-11',total:'1e3',
 })).status,400);
 assert.equal((await http(db,'/api/cards/'+card.cardId+'/purchases','token=alice','POST',{
  ...payload,idempotencyKey:'invalid-range-11',installments:61,
 })).status,400);
 assert.equal((await http(db,'/api/cards/'+card.cardId+'/purchases','token=alice','POST',{
  ...payload,idempotencyKey:'invalid-cents11',total:'0.01',installments:2,
 })).status,400);
 assert.equal(db.raw.prepare('SELECT count(*) n FROM posted_cash_movements').get().n,0);
}));


test('free-text card fields reject Luhn-valid full PAN-like values, including embedded/space-grouped numbers',()=>withDb(async db=>{
 await assert.rejects(()=>createCard(db,actor('alice'),cardInput('no-pan',{name:'Principal 4111 1111 1111 1111'}),clock),TypeError);
 await assert.rejects(()=>createCard(db,actor('alice'),cardInput('no-pan-inst',{institution:'4111111111111111'}),clock),TypeError);
 const card=await createTestCard(db);
 await assert.rejects(()=>createPurchase(db,actor('alice'),purchaseInput(card.cardId,'no-pan-merchant',{merchant:'4111-1111-1111-1111'}),clock),TypeError);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM credit_purchases').get().n,0);
 // Valid long identifiers without Luhn check digits are not automatically flagged.
 const good=await createCard(db,actor('alice'),cardInput('legitimate-reference',{name:'Cartão referência 1234567890123456'}),clock);
 assert.equal(good.name,'Cartão referência 1234567890123456');
}));
