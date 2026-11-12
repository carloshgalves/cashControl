import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAccount,getAccount } from '../src/backend/accounts/accounts.ts';
import { createCard,createPurchase,getInvoice,listInvoices,CreditIdempotencyConflict } from '../src/backend/cards/cards.ts';
import { payInvoice,listInvoicePayments,CreditInvoiceInsufficient,
 CreditInvoiceUnavailable } from '../src/backend/cards/invoice-payments.ts';
import { getDashboard } from '../src/backend/dashboard/dashboard.ts';
import { listMovements } from '../src/backend/movements/movements.ts';
import { listTimeline } from '../src/backend/timeline/timeline.ts';
import { makeReport } from '../src/backend/reports/report.ts';
import { handleFinancialHttp } from '../src/backend/http/accounts-handler.ts';
import { parseCents } from '../src/domain/money.ts';

class Stmt {
 constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args;}
 bind(...args){return new Stmt(this.db,this.sql,args);}
 async first(){return this.db.prepare(this.sql).get(...this.args)??null;}
 async all(){return {results:this.db.prepare(this.sql).all(...this.args)};}
 async run(){return this.db.prepare(this.sql).run(...this.args);}
}
class Db {
 constructor(){
  this.raw=new DatabaseSync(':memory:');this.raw.exec('PRAGMA foreign_keys=ON');
  for(const n of ['0001_financial_accounts.sql','0002_better_auth.sql','0003_cash_movements.sql',
   '0004_financial_obligations.sql','0005_internal_transfers.sql','0006_cancellations_refunds.sql',
   '0007_credit_cards_installments.sql','0008_card_invoice_payments.sql'])
   this.raw.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8'));
  this.queue=Promise.resolve();
 }
 prepare(sql){return new Stmt(this.raw,sql);}
 batch(stmts){
  const op=this.queue.then(async()=>{
   this.raw.exec('BEGIN IMMEDIATE');
   try{
    const out=[];for(const stmt of stmts)out.push(await stmt.run());
    this.raw.exec('COMMIT');return out;
   }catch(e){this.raw.exec('ROLLBACK');throw e;}
  });
  this.queue=op.catch(()=>{});
  return op;
 }
 close(){this.raw.close();}
}
async function withDb(fn){const db=new Db();try{return await fn(db);}finally{db.close();}}
const actor=id=>({userId:id}),clock=()=>new Date('2026-11-11T13:00:00Z');
const key=s=>'d2-invoice-key-'+s;
const cent=parseCents;
async function setup(db,owner='alice',cash='2000.00'){
 const account=await createAccount(db,actor(owner),{
  idempotencyKey:key('account-'+owner),name:'Conta '+owner,kind:'general',
  funding:{mode:'external',cents:cent(cash)},
 },clock);
 const card=await createCard(db,actor(owner),{
  idempotencyKey:key('card-'+owner),name:'Crédito '+owner,institution:null,
  limitCents:cent('3000.00'),closingDay:25,dueDay:5,
 },clock);
 const purchase=await createPurchase(db,actor(owner),{
  idempotencyKey:key('purchase-'+owner),cardId:card.cardId,title:'Compra 1500',
  purchasedOn:'2026-11-11',totalCents:cent('1500.00'),installments:1,
 },clock);
 return {account,card,purchase};
}
function input(f,keySuffix,amount='900.00',changes={}){
 return {idempotencyKey:key(keySuffix),cardId:f.card.cardId,cycle:'2026-11',
  accountId:f.account.accountId,amountCents:cent(amount),method:'pix',
  paidOn:'2026-11-11',...changes};
}
const period={from:'2026-11-01',to:'2026-11-30'};
const report={...period,asOf:'2026-11-11',format:'xlsx',status:'all'};
async function amounts(db){
 const dash=await getDashboard(db,actor('alice'),period);
 const movements=await listMovements(db,actor('alice'));
 const invoice=await getInvoice(db,actor('alice'),(await db.prepare("SELECT card_id FROM credit_cards WHERE owner_user_id='alice'").first()).card_id,'2026-11');
 return {dash,movements,invoice};
}

test('D2: R$1500 obligation, R$900 paid and R$600 remnant, then full settlement, no duplicate cash debit',()=>withDb(async db=>{
 const f=await setup(db);
 let view=await getInvoice(db,actor('alice'),f.card.cardId,'2026-11');
 assert.equal(view.invoice.totalCents,150000);
 assert.equal(view.invoice.paidCents,0);
 assert.equal(view.invoice.outstandingCents,150000);
 assert.equal(view.invoice.state,'open');
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.expensesCents,0);
 const first=await payInvoice(db,actor('alice'),input(f,'partial'),clock);
 assert.equal(first.amountCents,90000);
 let x=await amounts(db);
 assert.deepEqual([x.invoice.invoice.totalCents,x.invoice.invoice.paidCents,
  x.invoice.invoice.outstandingCents,x.invoice.invoice.state],[150000,90000,60000,'partially_paid']);
 assert.equal(x.dash.balances.totalCents,110000);
 assert.equal(x.dash.cashFlow.expensesCents,90000);
 assert.equal(x.dash.cashFlow.netCents,-90000);
 assert.equal(x.movements.length,1);
 assert.equal(x.movements[0].amountCents,90000);
 assert.match(x.movements[0].description,/Pagamento da fatura/);
 assert.equal((await listInvoicePayments(db,actor('alice'),f.card.cardId,'2026-11')).length,1);
 const confirmed=await payInvoice(db,actor('alice'),input(f,'final','600.00'),clock);
 assert.equal(confirmed.amountCents,60000);
 x=await amounts(db);
 assert.equal(x.invoice.invoice.outstandingCents,0);
 assert.equal(x.invoice.invoice.state,'paid');
 assert.equal(x.dash.balances.totalCents,50000);
 assert.equal(x.dash.cashFlow.expensesCents,150000);
 assert.equal(x.movements.length,2);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM card_invoice_payments').get().n,2);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM credit_purchases').get().n,1);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM credit_installments').get().n,1);
 assert.equal((await listInvoices(db,actor('alice'),f.card.cardId))[0].paidCents,150000);
 await assert.rejects(()=>payInvoice(db,actor('alice'),input(f,'extra','0.01'),clock),CreditInvoiceInsufficient);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,2);
}));

test('D2 retry replay, same key/payload conflict and cross-owner idempotency namespaces',()=>withDb(async db=>{
 const a=await setup(db),b=await setup(db,'bob');
 const p=input(a,'retry','200.00');
 const first=await payInvoice(db,actor('alice'),p,clock);
 const retry=await payInvoice(db,actor('alice'),p,clock);
 assert.deepEqual(first,retry);
 await assert.rejects(()=>payInvoice(db,actor('alice'),{...p,amountCents:20100},clock),CreditIdempotencyConflict);
 const foreign=await payInvoice(db,actor('bob'),input(b,'retry','200.00'),clock);
 assert.notEqual(first.paymentId,foreign.paymentId);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,2);
}));

test('D2 two concurrent different keys cannot overpay the same invoice; failure rolls back movement',()=>withDb(async db=>{
 const f=await setup(db);
 const results=await Promise.allSettled([
  payInvoice(db,actor('alice'),input(f,'race-a','1000.00'),clock),
  payInvoice(db,actor('alice'),input(f,'race-b','1000.00'),clock),
 ]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(results.filter(x=>x.status==='rejected').length,1);
 assert(results.find(x=>x.status==='rejected').reason instanceof CreditInvoiceInsufficient,
  'conflicting concurrent payment must return a typed overpayment error');
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM card_invoice_payments').get().n,1);
 assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM posted_cash_movements').get().n,1);
 const invoice=await getInvoice(db,actor('alice'),f.card.cardId,'2026-11');
 assert.equal(invoice.invoice.outstandingCents,50000);
 assert.equal((await getAccount(db,actor('alice'),f.account.accountId)).balanceCents,100000);
}));

test('D2 transaction rejects mismatched movement, forgeries, generic refunds and second debt payoff',()=>withDb(async db=>{
 const f=await setup(db);
 const good=await payInvoice(db,actor('alice'),input(f,'one','400.00'),clock);
 assert.throws(()=>db.raw.prepare('UPDATE card_invoice_payments SET amount_cents=1').run());
 assert.throws(()=>db.raw.prepare('DELETE FROM card_invoice_payments').run());
 assert.throws(()=>db.raw.prepare('UPDATE posted_cash_movements SET amount_cents=1 WHERE movement_id=?').run(good.movementId));
 // This receipt is reserved for one invoice; cannot be reused for a second obligation.
 const ordinaryObligation='00000000-0000-4000-8000-000000000001';
 db.raw.prepare("INSERT INTO financial_obligations(owner_user_id,obligation_id,creation_key,title,total_cents,due_on,created_at) VALUES(?,?,?,?,?,?,?)")
  .run('alice',ordinaryObligation,key('ordinary-debt'),'Conta',40000,'2026-11-22',clock().toISOString());
 assert.throws(()=>db.raw.prepare('INSERT INTO financial_obligation_payments(owner_user_id,payment_id,creation_key,obligation_id,movement_id,amount_cents,created_at) VALUES(?,?,?,?,?,?,?)')
  .run('alice','00000000-0000-4000-8000-000000000002',key('debt-payment'),ordinaryObligation,good.movementId,40000,clock().toISOString()));
 assert.throws(()=>db.raw.prepare('INSERT INTO cash_refunds(owner_user_id,refund_id,creation_key,original_movement_id,refund_movement_id,amount_cents,refunded_on,created_at) VALUES(?,?,?,?,?,?,?,?)')
  .run('alice','00000000-0000-4000-8000-000000000003',key('generic-refund'),good.movementId,good.movementId,1,'2026-11-12',clock().toISOString()));
 assert.equal((await getInvoice(db,actor('alice'),f.card.cardId,'2026-11')).invoice.outstandingCents,110000);
}));

test('D2 Bob cannot debit Alice account, pay Alice invoice, or read Alice history',()=>withDb(async db=>{
 const a=await setup(db),b=await setup(db,'bob');
 await assert.rejects(()=>payInvoice(db,actor('bob'),input(a,'foreign','1.00'),clock));
 await assert.rejects(()=>payInvoice(db,actor('bob'),input(b,'foreign-account','1.00',{accountId:a.account.accountId}),clock),CreditInvoiceUnavailable);
 await assert.rejects(()=>listInvoicePayments(db,actor('bob'),a.card.cardId,'2026-11'));
 assert.deepEqual(await listInvoicePayments(db,actor('alice'),a.card.cardId,'2026-11'),[]);
 assert.equal((await getAccount(db,actor('alice'),a.account.accountId)).balanceCents,200000);
}));

test('D2 payments are one cash outflow in timeline and XLSX/PDF, purchase is not duplicated',()=>withDb(async db=>{
 const a=await setup(db);
 await payInvoice(db,actor('alice'),input(a,'history','900.00'),clock);
 const events=await listTimeline(db,actor('alice'),{...period,asOf:'2026-11-11',limit:100});
 assert.equal(events.events.filter(e=>e.kind==='expense'||e.kind==='payment').length,1);
 assert.equal(events.events.filter(e=>e.kind==='expense'||e.kind==='payment')[0].amountCents,90000);
 const x=await makeReport(db,actor('alice'),report);
 assert(x.bytes.length>500);
 assert.equal(x.rows,1);
 const pdf=await makeReport(db,actor('alice'),{...report,format:'pdf'});
 assert(pdf.bytes.length>500);
 assert.equal(pdf.rows,1);
 assert.equal((await getDashboard(db,actor('alice'),period)).cashFlow.expensesCents,90000);
}));

const BASE='http://127.0.0.1:8787',now=Date.parse('2026-11-11T13:00:00Z');
async function session(h){
 const cookie=h.get('cookie');
 const user=cookie==='u=alice'?'alice':cookie==='u=bob'?'bob':null;
 return user?{user:{id:user},session:{userId:user,expiresAt:new Date(now+120000)}}:null;
}
async function http(db,path,user='alice',method='GET',body=null,origin=BASE){
 return handleFinancialHttp(new Request(BASE+path,{method,headers:{
  cookie:user?'u='+user:'',origin,'x-user-id':'bob',...(body?{'content-type':'application/json'}:{})
 },...(body?{body:JSON.stringify(body)}:{})}),db,session,BASE,()=>now);
}
test('D2 HTTP authenticates session, Origin, strict amount, query, ownership and replay',()=>withDb(async db=>{
 const f=await setup(db),cardId=f.card.cardId;
 const path='/api/cards/'+cardId+'/invoices/2026-11/payments';
 assert.equal((await http(db,path,'')).status,401);
 assert.equal((await http(db,path,'bob')).status,404);
 assert.equal((await http(db,path,'alice','POST',{idempotencyKey:key('http'),accountId:f.account.accountId,amount:'900.00',method:'pix',paidOn:'2026-11-11'},'https://evil.test')).status,403);
 const data={idempotencyKey:key('http'),accountId:f.account.accountId,amount:'900.00',method:'pix',paidOn:'2026-11-11'};
 const created=await http(db,path,'alice','POST',data);
 assert.equal(created.status,201);
 const result=(await created.json()).payment;assert.equal(result.amountCents,90000);
 const replay=await http(db,path,'alice','POST',data);
 assert.equal(replay.status,201);
 assert.equal((await replay.json()).payment.paymentId,result.paymentId);
 assert.equal((await http(db,path+'?limit=1&limit=2')).status,400);
 assert.equal((await http(db,path+'?ownerId=bob')).status,400);
 assert.equal((await http(db,path,'alice','POST',{...data,idempotencyKey:key('bad'),amount:'NaN'})).status,400);
 assert.equal((await http(db,path,'alice','POST',{...data,idempotencyKey:key('over'),amount:'900.00'})).status,409);
 const history=await http(db,path);
 assert.equal(history.status,200);
 assert.equal((await history.json()).payments.length,1);
 assert.equal((await getAccount(db,actor('alice'),f.account.accountId)).balanceCents,110000);
}));


test('D2 audit guard rejects forged origin, double use of old obligation debit, and pre-refunded movement',()=>withDb(async db=>{
 const f=await setup(db),who='alice';
 const debtId='00000000-0000-4000-8000-000000000101';
 db.raw.prepare('INSERT INTO financial_obligations(owner_user_id,obligation_id,creation_key,title,total_cents,due_on,created_at) VALUES(?,?,?,?,?,?,?)')
  .run(who,debtId,key('preexisting-debt'),'Outro compromisso',10000,'2026-11-25',clock().toISOString());
 const insertExpense=(suffix,originalKey)=>{
  const id='00000000-0000-4000-8000-'+String(1000+suffix).padStart(12,'0');
  db.raw.prepare("INSERT INTO posted_cash_movements(owner_user_id,movement_id,creation_key,account_id,direction,amount_cents,payment_method,description,category,occurred_on,created_at) VALUES(?,?,?,?,'expense',?,'pix','Pagamento','Teste',?,?)")
   .run(who,id,originalKey,f.account.accountId,10000,'2026-11-11',clock().toISOString());
  return id;
 };
 const direct=(paymentKey,movementId,suffix)=>{
  db.raw.prepare('INSERT INTO card_invoice_payments(owner_user_id,payment_id,creation_key,card_id,invoice_cycle,movement_id,account_id,amount_cents,method,paid_on,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
   .run(who,'00000000-0000-4000-8000-'+String(2000+suffix).padStart(12,'0'),
    paymentKey,f.card.cardId,'2026-11',movementId,f.account.accountId,10000,'pix','2026-11-11',clock().toISOString());
 };
 const notReserved=insertExpense(1,key('ordinary-origin'));
 assert.throws(()=>direct(key('forged'),notReserved,1),/CARD_INVOICE_PAYMENT_MISMATCH/);
 const linkedKey=key('already-obligation'),linked=insertExpense(2,'card-payment:'+linkedKey);
 db.raw.prepare('INSERT INTO financial_obligation_payments(owner_user_id,payment_id,creation_key,obligation_id,movement_id,amount_cents,created_at) VALUES(?,?,?,?,?,?,?)')
  .run(who,'00000000-0000-4000-8000-000000000104',key('existing-payment'),debtId,linked,10000,clock().toISOString());
 assert.throws(()=>direct(linkedKey,linked,2),/CARD_INVOICE_MOVEMENT_ALREADY_USED/);
 const refundedKey=key('already-refunded'),refunded=insertExpense(3,'card-payment:'+refundedKey);
 const refundMovement='00000000-0000-4000-8000-000000000106';
 db.raw.prepare("INSERT INTO posted_cash_movements(owner_user_id,movement_id,creation_key,account_id,direction,amount_cents,payment_method,description,category,occurred_on,created_at) VALUES(?,?,?,?,'income',?,'pix','Devolução','Reembolso',?,?)")
  .run(who,refundMovement,'cash-refund:'+key('credit-return'),f.account.accountId,10000,'2026-11-12',clock().toISOString());
 db.raw.prepare('INSERT INTO cash_refunds(owner_user_id,refund_id,creation_key,original_movement_id,refund_movement_id,amount_cents,refunded_on,created_at) VALUES(?,?,?,?,?,?,?,?)')
  .run(who,'00000000-0000-4000-8000-000000000107',key('credit-return'),refunded,refundMovement,10000,'2026-11-12',clock().toISOString());
 assert.throws(()=>direct(refundedKey,refunded,3),/CARD_INVOICE_MOVEMENT_ALREADY_USED/);
 assert.equal(db.raw.prepare('SELECT count(*) n FROM card_invoice_payments').get().n,0);
 assert.equal((await getInvoice(db,actor(who),f.card.cardId,'2026-11')).invoice.outstandingCents,150000);
}));
