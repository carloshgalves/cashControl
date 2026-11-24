import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createCard,createPurchase,getInvoice,listInvoices,CreditIdempotencyConflict,
 CreditCardUnavailable } from '../src/backend/cards/cards.ts';
import { payInvoice } from '../src/backend/cards/invoice-payments.ts';
import { createAccount } from '../src/backend/accounts/accounts.ts';
import { recordInvoiceBankTotal,readInvoiceReconciliation,parseReportedInvoiceCents } from '../src/backend/cards/reconciliation.ts';
import { getDashboard } from '../src/backend/dashboard/dashboard.ts';
import { makeReport } from '../src/backend/reports/report.ts';
import { handleFinancialHttp } from '../src/backend/http/accounts-handler.ts';

class Stmt {
 constructor(db,sql,params=[]){this.db=db;this.sql=sql;this.params=params;}
 bind(...params){return new Stmt(this.db,this.sql,params);}
 async first(){return this.db.prepare(this.sql).get(...this.params)??null;}
 async all(){return {results:this.db.prepare(this.sql).all(...this.params)};}
 async run(){return this.db.prepare(this.sql).run(...this.params);}
}
class Db{
 constructor(){
  this.raw=new DatabaseSync(':memory:');this.raw.exec('PRAGMA foreign_keys=ON');
  for(const name of ['0001_financial_accounts.sql','0002_better_auth.sql','0003_cash_movements.sql',
    '0004_financial_obligations.sql','0005_internal_transfers.sql','0006_cancellations_refunds.sql','0015_personal_loan_receivables.sql',
    '0007_credit_cards_installments.sql','0008_card_invoice_payments.sql',
    '0009_invoice_bank_reconciliation.sql']){
   this.raw.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  }
  this.queue=Promise.resolve();
 }
 prepare(sql){return new Stmt(this.raw,sql);}
 batch(stmts){
  const op=this.queue.then(async()=>{
   this.raw.exec('BEGIN IMMEDIATE');
   try{const result=[];for(const s of stmts)result.push(await s.run());this.raw.exec('COMMIT');return result;}
   catch(e){this.raw.exec('ROLLBACK');throw e;}
  });
  this.queue=op.catch(()=>{});return op;
 }
 close(){this.raw.close();}
}
async function using(fn){const db=new Db();try{await fn(db);}finally{db.close();}}
const actor=id=>({userId:id}),clock=()=>new Date('2026-11-11T13:00:00.000Z');
const key=x=>'reconciliation-key-'+x;
async function seeded(db,user='alice',amount=150000){
 const card=await createCard(db,actor(user),{
  idempotencyKey:key('card-'+user),name:'Cartão principal',
  institution:null,limitCents:300000,closingDay:25,dueDay:5,
 },clock);
 const first=await createPurchase(db,actor(user),{
  idempotencyKey:key('purchase-'+user),cardId:card.cardId,title:'Notebook',
  purchasedOn:'2026-11-11',totalCents:amount,installments:1,
 },clock);
 return {card,first};
}
function input(cardId,tag,reportedTotalCents,cycle='2026-11'){
 return {idempotencyKey:key(tag),cardId,cycle,reportedTotalCents};
}
const period={from:'2026-11-01',to:'2026-11-30'};
test('D3 absent bank observation is optional; zero ledger mutations and an unreported status',()=>using(async db=>{
 const f=await seeded(db);
 const p=await readInvoiceReconciliation(db,actor('alice'),f.card.cardId,'2026-11');
 assert.deepEqual([p.reconciliation.status,p.reconciliation.reportedTotalCents,p.reconciliation.differenceCents],
  ['unreported',null,null]);
 assert.equal(p.reconciliation.calculatedTotalCents,150000);
 assert.deepEqual(p.observations,[]);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.expensesCents,0);
 assert.equal(db.raw.prepare('SELECT count(*) n FROM card_invoice_bank_observations').get().n,0);
}));

test('D3 exact match and non-match compare gross invoice; no automatic ledger adjustments',()=>using(async db=>{
 const f=await seeded(db);
 const before=(await getDashboard(db,actor('alice'),period));
 const p=await recordInvoiceBankTotal(db,actor('alice'),input(f.card.cardId,'different',155099),clock);
 assert.deepEqual([p.status,p.calculatedTotalCents,p.reportedTotalCents,p.differenceCents],
  ['pending_divergence',150000,155099,5099]);
 assert.equal(p.source,'manual');
 const first=await readInvoiceReconciliation(db,actor('alice'),f.card.cardId,'2026-11');
 assert.equal(first.observations.length,1);
 assert.equal(first.observations[0].calculatedAtEntryCents,150000);
 const q=await recordInvoiceBankTotal(db,actor('alice'),input(f.card.cardId,'matched',150000),clock);
 assert.deepEqual([q.status,q.differenceCents],['matched',0]);
 const second=await readInvoiceReconciliation(db,actor('alice'),f.card.cardId,'2026-11');
 assert.deepEqual(second.observations.map(x=>x.reportedTotalCents),[150000,155099]);
 assert.equal(second.observations[0].source,'manual');
 const after=await getDashboard(db,actor('alice'),period);
 assert.deepEqual(after, before,'manual statement must not change dashboard cash or commitments');
 assert.equal((await getInvoice(db,actor('alice'),f.card.cardId,'2026-11')).invoice.outstandingCents,150000);
 assert.equal((await makeReport(db,actor('alice'),{...period,asOf:'2026-11-11',format:'xlsx',status:'all'})).rows,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM credit_purchases').get().n,1);
}));

test('D3 reported zero allowed; negative difference remains pending rather than auto-credit',()=>using(async db=>{
 const f=await seeded(db);
 const report=await recordInvoiceBankTotal(db,actor('alice'),input(f.card.cardId,'bank-zero',0),clock);
 assert.equal(report.status,'pending_divergence');
 assert.equal(report.differenceCents,-150000);
 assert.equal(report.reportedTotalCents,0);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
}));

test('D3 history immutable, deduplicated and revised only by appending a new observation',()=>using(async db=>{
 const f=await seeded(db);
 const request=input(f.card.cardId,'retry',150000);
 const once=await recordInvoiceBankTotal(db,actor('alice'),request,clock);
 const twice=await recordInvoiceBankTotal(db,actor('alice'),request,clock);
 assert.equal(once.latestObservation.observationId,twice.latestObservation.observationId);
 await assert.rejects(()=>recordInvoiceBankTotal(db,actor('alice'),{...request,reportedTotalCents:150001},clock),CreditIdempotencyConflict);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM card_invoice_bank_observations').get().n,1);
 assert.throws(()=>db.raw.prepare('UPDATE card_invoice_bank_observations SET reported_total_cents=1').run(),/IMMUTABLE/);
 assert.throws(()=>db.raw.prepare('DELETE FROM card_invoice_bank_observations').run(),/IMMUTABLE/);
 await recordInvoiceBankTotal(db,actor('alice'),input(f.card.cardId,'revision',151000),clock);
 const history=await readInvoiceReconciliation(db,actor('alice'),f.card.cardId,'2026-11',1);
 assert.equal(history.hasMore,true);
 assert.equal(history.observations.length,1);
 const page2=await readInvoiceReconciliation(db,actor('alice'),f.card.cardId,'2026-11',1,1);
 assert.equal(page2.hasMore,false);
 assert.equal(page2.observations[0].reportedTotalCents,150000);
 assert.equal(page2.reconciliation.reportedTotalCents,151000,'offset pages still use latest state');
}));

test('D3 latest reported total follows the live calculated invoice total without silent correction',()=>using(async db=>{
 const f=await seeded(db);
 await recordInvoiceBankTotal(db,actor('alice'),input(f.card.cardId,'baseline',150000),clock);
 await createPurchase(db,actor('alice'),{
  idempotencyKey:key('new-item'),cardId:f.card.cardId,title:'Outros itens',
  purchasedOn:'2026-11-12',totalCents:2000,installments:1,
 },clock);
 const r=await readInvoiceReconciliation(db,actor('alice'),f.card.cardId,'2026-11');
 assert.equal(r.reconciliation.status,'pending_divergence');
 assert.equal(r.reconciliation.calculatedTotalCents,152000);
 assert.equal(r.reconciliation.differenceCents,-2000);
 assert.equal(r.reconciliation.latestObservation.calculatedAtEntryCents,150000);
 assert.equal((await listInvoices(db,actor('alice'),f.card.cardId))[0].totalCents,152000);
}));

test('D3 concurrent identical keys and separate revisions produce no duplicate observations',()=>using(async db=>{
 const f=await seeded(db);
 const request=input(f.card.cardId,'racing',151200);
 const [a,b,c]=await Promise.all([
  recordInvoiceBankTotal(db,actor('alice'),request,clock),
  recordInvoiceBankTotal(db,actor('alice'),request,clock),
  recordInvoiceBankTotal(db,actor('alice'),request,clock)
 ]);
 assert.equal(new Set([a.latestObservation.observationId,b.latestObservation.observationId,c.latestObservation.observationId]).size,1);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM card_invoice_bank_observations').get().n,1);
 const n=await Promise.all([
  recordInvoiceBankTotal(db,actor('alice'),input(f.card.cardId,'another-a',151000),clock),
  recordInvoiceBankTotal(db,actor('alice'),input(f.card.cardId,'another-b',152000),clock),
 ]);
 assert.equal(n.length,2);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM card_invoice_bank_observations').get().n,3);
}));

test('D3 owner A/B, missing card or cycle do not reveal or create foreign observations',()=>using(async db=>{
 const a=await seeded(db,'alice'),b=await seeded(db,'bob');
 await recordInvoiceBankTotal(db,actor('alice'),input(a.card.cardId,'alice',154000),clock);
 await assert.rejects(()=>readInvoiceReconciliation(db,actor('bob'),a.card.cardId,'2026-11'),CreditCardUnavailable);
 await assert.rejects(()=>recordInvoiceBankTotal(db,actor('bob'),input(a.card.cardId,'theft',123),clock),CreditCardUnavailable);
 await assert.rejects(()=>readInvoiceReconciliation(db,actor('alice'),a.card.cardId,'2026-12'));
 assert.equal((await readInvoiceReconciliation(db,actor('bob'),b.card.cardId,'2026-11')).reconciliation.status,'unreported');
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM card_invoice_bank_observations').get().n,1);
}));

test('D3 SQLite refuses forged current totals and cross-owner insertion',()=>using(async db=>{
 const a=await seeded(db,'alice'),b=await seeded(db,'bob');
 const args=(owner,card,calculated,requestKey)=>[
  owner,crypto.randomUUID(),requestKey,card,'2026-11',160000,calculated,clock().toISOString()
 ];
 const sql='INSERT INTO card_invoice_bank_observations(owner_user_id,observation_id,creation_key,card_id,invoice_cycle,reported_total_cents,calculated_total_at_entry_cents,created_at) VALUES(?,?,?,?,?,?,?,?)';
 assert.throws(()=>db.raw.prepare(sql).run(...args('alice',a.card.cardId,100,'forged')),/CARD_RECONCILIATION_INVALID_INVOICE/);
 assert.throws(()=>db.raw.prepare(sql).run(...args('alice',b.card.cardId,150000,'cross-owner')),/FOREIGN KEY|CARD_RECONCILIATION_INVALID_INVOICE/);
 assert.equal(db.raw.prepare('SELECT count(*) n FROM card_invoice_bank_observations').get().n,0);
}));

const base='http://127.0.0.1:8787',now=Date.parse('2026-11-11T13:00:00Z');
const lookup=async headers=>{
 const cookie=headers.get('cookie');
 const id=cookie==='u=alice'?'alice':cookie==='u=bob'?'bob':null;
 return id?{user:{id},session:{userId:id,expiresAt:new Date(now+120000)}}:null;
};
async function http(db,path,who='alice',method='GET',body=null,origin=base){
 return handleFinancialHttp(new Request(base+path,{
  method,headers:{cookie:who?'u='+who:'',origin,'x-user-id':'bob',
   ...(body?{'content-type':'application/json'}:{})},
  ...(body?{body:JSON.stringify(body)}:{})
 }),db,lookup,base,()=>now);
}
test('D3 HTTP exact amounts, same-origin, owner isolation, pagination, retry and invalid inputs',()=>using(async db=>{
 const f=await seeded(db);
 const url='/api/cards/'+f.card.cardId+'/invoices/2026-11/reconciliation';
 assert.equal((await http(db,url,'')).status,401);
 assert.equal((await http(db,url,'bob')).status,404);
 assert.equal((await http(db,url,'alice','POST',{
  idempotencyKey:key('http'),reportedTotal:'1500.00',
 },'https://evil.example')).status,403);
 assert.equal((await http(db,url,'alice','POST',{
  idempotencyKey:key('http'),reportedTotal:'-1.00',
 })).status,400);
 assert.equal((await http(db,url,'alice','POST',{
  idempotencyKey:key('http'),reportedTotal:'NaN',
 })).status,400);
 assert.equal((await http(db,url,'alice','POST',{
  idempotencyKey:key('http'),reportedTotal:'1500.00',ownerUserId:'bob',
 })).status,400);
 assert.equal((await http(db,url+'?limit=1&limit=2')).status,400);
 assert.equal((await http(db,url+'?cardId=from-client')).status,400);
 assert.equal((await http(db,url,'alice','POST',{
  idempotencyKey:key('http'),reportedTotal:'0',
 })).status,201);
 const got=(await (await http(db,url)).json());
 assert.equal(got.reconciliation.status,'pending_divergence');
 assert.equal(got.reconciliation.reportedTotalCents,0);
 const second=await http(db,url,'alice','POST',{idempotencyKey:key('http'),reportedTotal:'0'});
 assert.equal(second.status,201);
 assert.equal((await second.json()).reconciliation.status,'pending_divergence');
 assert.equal(db.raw.prepare('SELECT count(*) n FROM card_invoice_bank_observations').get().n,1);
 assert.equal((await http(db,url,'bob','POST',{idempotencyKey:key('steal'),reportedTotal:'100'})).status,404);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,0);
}));


test('D3 compares gross invoice total even after partial card payment, never to remaining debt',()=>using(async db=>{
 const f=await seeded(db);
 const account=await createAccount(db,actor('alice'),{
  idempotencyKey:key('account-for-partial'),name:'Conta de origem',kind:'bank',
  funding:{mode:'external',cents:200000},
 },clock);
 await recordInvoiceBankTotal(db,actor('alice'),input(f.card.cardId,'bank-exact-gross',150000),clock);
 const paid=await payInvoice(db,actor('alice'),{
  idempotencyKey:key('partial-payment'),cardId:f.card.cardId,cycle:'2026-11',
  accountId:account.accountId,amountCents:50000,method:'pix',paidOn:'2026-11-11',
 },clock);
 assert.equal(paid.amountCents,50000);
 const comparison=await readInvoiceReconciliation(db,actor('alice'),f.card.cardId,'2026-11');
 assert.deepEqual([comparison.reconciliation.status,comparison.reconciliation.calculatedTotalCents,
  comparison.reconciliation.reportedTotalCents,comparison.reconciliation.differenceCents],
  ['matched',150000,150000,0]);
 assert.equal((await getInvoice(db,actor('alice'),f.card.cardId,'2026-11')).invoice.outstandingCents,100000);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.expensesCents,50000);
 assert.equal(db.raw.prepare('SELECT count(*) n FROM card_invoice_bank_observations').get().n,1);
}));

test('D3 replay of an old matching observation returns the CURRENT latest unresolved comparison',()=>using(async db=>{
 const f=await seeded(db);
 const original=input(f.card.cardId,'replay-old',150000);
 await recordInvoiceBankTotal(db,actor('alice'),original,clock);
 await recordInvoiceBankTotal(db,actor('alice'),input(f.card.cardId,'revision-new',160000),clock);
 const replay=await recordInvoiceBankTotal(db,actor('alice'),original,clock);
 assert.equal(replay.status,'pending_divergence');
 assert.equal(replay.reportedTotalCents,160000);
 assert.equal(replay.latestObservation.observationId,
  (await readInvoiceReconciliation(db,actor('alice'),f.card.cardId,'2026-11')).reconciliation.latestObservation.observationId);
 assert.equal(db.raw.prepare('SELECT count(*) n FROM card_invoice_bank_observations').get().n,2);
}));


test('D3 aggregate totals from multiple legal purchases are not capped like a single cash movement',()=>using(async db=>{
 const f=await seeded(db,'alice',9_000_000_000_000);
 await createPurchase(db,actor('alice'),{
  idempotencyKey:key('second-huge-purchase'),cardId:f.card.cardId,title:'Second large purchase',
  purchasedOn:'2026-11-12',totalCents:9_000_000_000_000,installments:1,
 },clock);
 const expected=18_000_000_000_000;
 assert.equal((await getInvoice(db,actor('alice'),f.card.cardId,'2026-11')).invoice.totalCents,expected);
 assert.equal(parseReportedInvoiceCents('180000000000.00'),expected);
 const saved=await recordInvoiceBankTotal(db,actor('alice'),input(f.card.cardId,'aggregate-safe',expected),clock);
 assert.equal(saved.status,'matched');
 assert.equal(saved.differenceCents,0);
 assert.equal(saved.latestObservation.calculatedAtEntryCents,expected);
 assert.equal((await (await http(db,'/api/cards/'+f.card.cardId+'/invoices/2026-11/reconciliation')).json())
  .reconciliation.calculatedTotalCents,expected);
 assert.equal(db.raw.prepare('SELECT count(*) n FROM posted_cash_movements').get().n,0);
 for(const invalid of ['90071992547409.92','180000000000.001','9e12','-1','Infinity'])
  assert.throws(()=>parseReportedInvoiceCents(invalid),RangeError);
 assert.equal(parseReportedInvoiceCents('90071992547409.91'),Number.MAX_SAFE_INTEGER);
}));
