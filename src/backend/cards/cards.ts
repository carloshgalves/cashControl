import { assertCents, type Cents } from '../../domain/money.ts';
import { validateDate } from '../timeline/timeline.ts';
import type { AuthenticatedActor, FinancialDatabase } from '../accounts/accounts.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9_-]{12,128}$/;
export class CreditCardUnavailable extends Error { constructor(){super('CREDIT_CARD_NOT_FOUND');} }
export class CreditPurchaseUnavailable extends Error { constructor(){super('CREDIT_PURCHASE_NOT_FOUND');} }
export class CreditIdempotencyConflict extends Error { constructor(){super('CREDIT_IDEMPOTENCY_CONFLICT');} }
export class CreditResultTooLarge extends Error { constructor(){super('CREDIT_RESULT_TOO_LARGE');} }
export interface CardView {
 cardId:string;name:string;institution:string|null;limitCents:number;
 closingDay:number;dueDay:number;createdAt:string;
}
export interface PurchaseView {
 purchaseId:string;cardId:string;title:string;merchant:string|null;category:string|null;
 purchasedOn:string;totalCents:number;installments:number;createdAt:string;
}
export interface InstallmentView {
 purchaseId:string;cardId:string;title:string;merchant:string|null;
 installmentNo:number;installments:number;cycle:string;dueOn:string;amountCents:number;
}
export interface InvoiceView {
 cardId:string;cycle:string;dueOn:string;totalCents:number;paidCents:number;outstandingCents:number;
 state:'open'|'partially_paid'|'paid';installmentCount:number;purchaseCount:number;
}
interface CardRow {card_id:string;display_name:string;institution:string|null;limit_cents:number;closing_day:number;due_day:number;created_at:string;creation_key:string}
interface PurchaseRow {purchase_id:string;card_id:string;title:string;merchant:string|null;category:string|null;purchased_on:string;total_cents:number;installments_count:number;created_at:string;creation_key:string}
interface InstallmentRow {
 purchase_id:string;card_id:string;title:string;merchant:string|null;installment_no:number;
 installments_count:number;invoice_cycle:string;due_on:string;amount_cents:number;
}
interface InvoiceRow {invoice_cycle:string;due_on:string;max_due:string;total_cents:number;paid_cents:number;outstanding_cents:number;installment_count:number;purchase_count:number}
export interface NewCard {
 idempotencyKey:string;name:string;institution?:string|null;limitCents:number;
 closingDay:number;dueDay:number;
}
export interface NewPurchase {
 idempotencyKey:string;cardId:string;title:string;merchant?:string|null;category?:string|null;
 purchasedOn:string;totalCents:number;installments:number;
}
function actorId(actor:AuthenticatedActor):string{
 if(!actor || typeof actor.userId!=='string'||!actor.userId.trim()||actor.userId.length>128)throw new TypeError('Verified session required');
 return actor.userId;
}
function key(value:unknown):asserts value is string{
 if(typeof value!=='string'||!KEY.test(value))throw new TypeError('Invalid idempotency key');
}
// Do not accept a full payment-card PAN smuggled into free-text labels.
// Luhn keeps ordinary long reference numbers from being rejected blindly.
function containsLikelyPan(text:string):boolean{
 const candidates=text.match(/(?:\d[ -]?){12,18}\d/g)??[];
 return candidates.some(value=>{
  const digits=value.replace(/\D/g,'');
  if(digits.length<13||digits.length>19)return false;
  let checksum=0,double=false;
  for(let i=digits.length-1;i>=0;i--){
   let digit=Number(digits[i]);
   if(double){digit*=2;if(digit>9)digit-=9;}
   checksum+=digit;double=!double;
  }
  return checksum%10===0;
 });
}
function label(v:unknown,max:number,required:boolean):string|null{
 if(v===undefined||v===null){if(required)throw new TypeError('Missing label');return null;}
 if(typeof v!=='string'||/[\x00-\x1F\x7F]/.test(v)||v.trim().length>max||
   (required&&v.trim().length<1) || (!required && v.trim().length<1) ||
   containsLikelyPan(v))throw new TypeError('Invalid label');
 return v.trim();
}
function cardView(v:CardRow):CardView{
 assertCents(v.limit_cents);
 return {cardId:v.card_id,name:v.display_name,institution:v.institution,limitCents:v.limit_cents,
  closingDay:v.closing_day,dueDay:v.due_day,createdAt:v.created_at};
}
function purchaseView(v:PurchaseRow):PurchaseView{
 assertCents(v.total_cents);
 return {purchaseId:v.purchase_id,cardId:v.card_id,title:v.title,merchant:v.merchant,category:v.category,
  purchasedOn:v.purchased_on,totalCents:v.total_cents,installments:v.installments_count,createdAt:v.created_at};
}
function installmentView(v:InstallmentRow):InstallmentView{
 assertCents(v.amount_cents);
 return {purchaseId:v.purchase_id,cardId:v.card_id,title:v.title,merchant:v.merchant,
  installmentNo:v.installment_no,installments:v.installments_count,
  cycle:v.invoice_cycle,dueOn:v.due_on,amountCents:v.amount_cents};
}
function month(year:number, m:number):string{
 // Avoid Date.UTC overflow for civil dates close to the supported year limit.
 const absolute=year*12+(m-1),y=Math.floor(absolute/12),mo=absolute%12+1;
 if(y<1000||y>9999)throw new RangeError('Cycle outside supported date range');
 return String(y).padStart(4,'0')+'-'+String(mo).padStart(2,'0');
}
function shiftMonth(cycle:string,delta:number):string{
 const [y=0,m=0]=cycle.split('-').map(Number);
 return month(y,m+delta);
}
function monthDays(cycle:string):number{
 const [y=0,m=0]=cycle.split('-').map(Number);
 return new Date(Date.UTC(y,m,0)).getUTCDate();
}
function clampDay(cycle:string,day:number):number{return Math.min(day,monthDays(cycle));}
export function schedule(card:Pick<CardView,'closingDay'|'dueDay'>,date:string,cents:number,count:number){
 validateDate(date);assertCents(cents);
 if(!Number.isInteger(count)||count<1||count>60||cents<count)throw new RangeError('Invalid installment count');
 const baseCycle=date.slice(0,7),purchaseDay=Number(date.slice(-2));
 const firstCycle=purchaseDay>clampDay(baseCycle,card.closingDay)?shiftMonth(baseCycle,1):baseCycle;
 const floor=Math.floor(cents/count),remainder=cents%count;
 const result:{installmentNo:number;cycle:string;dueOn:string;amountCents:number}[]=[];
 for(let i=0;i<count;i++){
  const cycle=shiftMonth(firstCycle,i);
  // Due day strictly after closing -> same calendar month; otherwise next.
  const dueCycle=clampDay(cycle,card.dueDay)>clampDay(cycle,card.closingDay)
   ?cycle:shiftMonth(cycle,1);
  const dueOn=dueCycle+'-'+String(clampDay(dueCycle,card.dueDay)).padStart(2,'0');
  result.push({installmentNo:i+1,cycle,dueOn,amountCents:floor+(i<remainder?1:0)});
 }
 if(result.reduce((a,v)=>a+v.amountCents,0)!==cents)throw new Error('Installment reconciliation failed');
 return result;
}
function page(limit:number,offset:number):void{
 if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>100000)throw new TypeError('Invalid pagination');
}
export async function listCards(db:FinancialDatabase,actor:AuthenticatedActor):Promise<CardView[]>{
 const who=actorId(actor);
 const v=await db.prepare('SELECT * FROM credit_cards WHERE owner_user_id=? ORDER BY created_at,card_id LIMIT 101').bind(who).all<CardRow>();
 if(v.results.length>100)throw new CreditResultTooLarge();
 return v.results.map(cardView);
}
export async function getCard(db:FinancialDatabase,actor:AuthenticatedActor,id:string):Promise<CardView|null>{
 const who=actorId(actor);
 if(!UUID.test(id))throw new TypeError('Invalid card ID');
 const v=await db.prepare('SELECT * FROM credit_cards WHERE owner_user_id=? AND card_id=?').bind(who,id).first<CardRow>();
 return v?cardView(v):null;
}
export async function createCard(db:FinancialDatabase,actor:AuthenticatedActor,input:NewCard,clock:()=>Date=()=>new Date()):Promise<CardView>{
 const who=actorId(actor);
 if(!input||typeof input!=='object')throw new TypeError('Invalid card');
 key(input.idempotencyKey);
 const name=label(input.name,80,true)!;
 const institution=label(input.institution,80,false);
 assertCents(input.limitCents);
 if(!Number.isInteger(input.closingDay)||input.closingDay<1||input.closingDay>31||
    !Number.isInteger(input.dueDay)||input.dueDay<1||input.dueDay>31)throw new TypeError('Invalid cycle days');
 const replay=async()=>{
  const row=await db.prepare('SELECT * FROM credit_cards WHERE owner_user_id=? AND creation_key=?')
   .bind(who,input.idempotencyKey).first<CardRow>();
  if(!row)return null;
  if(row.display_name!==name||row.institution!==institution||row.limit_cents!==input.limitCents||
     row.closing_day!==input.closingDay||row.due_day!==input.dueDay)throw new CreditIdempotencyConflict();
  return cardView(row);
 };
 const existing=await replay();if(existing)return existing;
 const cardId=crypto.randomUUID();
 try{
  await db.prepare('INSERT INTO credit_cards(owner_user_id,card_id,creation_key,display_name,institution,limit_cents,closing_day,due_day,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
   .bind(who,cardId,input.idempotencyKey,name,institution,input.limitCents,input.closingDay,input.dueDay,clock().toISOString()).run();
 }catch(e){const persisted=await replay();if(persisted)return persisted;throw e;}
 const card=await getCard(db,actor,cardId);
 if(!card)throw new Error('Card not persisted');
 return card;
}
export async function getPurchase(db:FinancialDatabase,actor:AuthenticatedActor,cardId:string,purchaseId:string):Promise<PurchaseView|null>{
 const who=actorId(actor);
 if(!UUID.test(cardId)||!UUID.test(purchaseId))throw new TypeError('Invalid purchase ID');
 const row=await db.prepare('SELECT * FROM credit_purchases WHERE owner_user_id=? AND card_id=? AND purchase_id=?')
 .bind(who,cardId,purchaseId).first<PurchaseRow>();
 return row?purchaseView(row):null;
}
export async function listPurchases(db:FinancialDatabase,actor:AuthenticatedActor,cardId:string,limit=50,offset=0):Promise<PurchaseView[]>{
 const who=actorId(actor);page(limit,offset);
 if(!UUID.test(cardId))throw new TypeError('Invalid card ID');
 if(!await getCard(db,actor,cardId))throw new CreditCardUnavailable();
 const v=await db.prepare('SELECT * FROM credit_purchases WHERE owner_user_id=? AND card_id=? ORDER BY purchased_on DESC,created_at DESC,purchase_id DESC LIMIT ? OFFSET ?')
  .bind(who,cardId,limit,offset).all<PurchaseRow>();
 return v.results.map(purchaseView);
}
export async function getPurchaseInstallments(db:FinancialDatabase,actor:AuthenticatedActor,cardId:string,purchaseId:string):Promise<InstallmentView[]|null>{
 const who=actorId(actor);
 const purchase=await getPurchase(db,actor,cardId,purchaseId);
 if(!purchase)return null;
 const v=await db.prepare('SELECT i.*,p.title,p.merchant,p.installments_count FROM credit_installments i JOIN credit_purchases p ON p.owner_user_id=i.owner_user_id AND p.purchase_id=i.purchase_id WHERE i.owner_user_id=? AND i.card_id=? AND i.purchase_id=? ORDER BY i.installment_no')
  .bind(who,cardId,purchaseId).all<InstallmentRow>();
 if(v.results.length!==purchase.installments || v.results.reduce((a,c)=>a+c.amount_cents,0)!==purchase.totalCents){
  throw new Error('Inconsistent purchase installments');
 }
 return v.results.map(installmentView);
}
export async function createPurchase(db:FinancialDatabase,actor:AuthenticatedActor,input:NewPurchase,clock:()=>Date=()=>new Date()):Promise<{purchase:PurchaseView;installments:InstallmentView[]}>{
 const who=actorId(actor);
 if(!input||typeof input!=='object')throw new TypeError('Invalid purchase');
 key(input.idempotencyKey);
 if(typeof input.cardId!=='string'||!UUID.test(input.cardId))throw new TypeError('Invalid card ID');
 const title=label(input.title,120,true)!,merchant=label(input.merchant,120,false),category=label(input.category,80,false);
 assertCents(input.totalCents);
 validateDate(input.purchasedOn);
 const card=await getCard(db,actor,input.cardId);
 if(!card)throw new CreditCardUnavailable();
 const periods=schedule(card,input.purchasedOn,input.totalCents,input.installments);
 const replay=async()=>{
  const row=await db.prepare('SELECT * FROM credit_purchases WHERE owner_user_id=? AND creation_key=?')
   .bind(who,input.idempotencyKey).first<PurchaseRow>();
  if(!row)return null;
  if(row.card_id!==input.cardId||row.title!==title||row.merchant!==merchant||row.category!==category||
   row.total_cents!==input.totalCents||row.purchased_on!==input.purchasedOn||row.installments_count!==input.installments)throw new CreditIdempotencyConflict();
  const parts=await getPurchaseInstallments(db,actor,row.card_id,row.purchase_id);
  if(!parts)throw new Error('Missing purchase rows');
  return {purchase:purchaseView(row),installments:parts};
 };
 const previous=await replay();if(previous)return previous;
 const purchaseId=crypto.randomUUID(),createdAt=clock().toISOString();
 const insert=[
  db.prepare('INSERT INTO credit_purchases(owner_user_id,purchase_id,card_id,creation_key,title,merchant,category,purchased_on,total_cents,installments_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
   .bind(who,purchaseId,input.cardId,input.idempotencyKey,title,merchant,category,input.purchasedOn,input.totalCents,input.installments,createdAt),
  ...periods.map(v=>db.prepare('INSERT INTO credit_installments(owner_user_id,purchase_id,installment_no,card_id,invoice_cycle,due_on,amount_cents) VALUES(?,?,?,?,?,?,?)')
   .bind(who,purchaseId,v.installmentNo,input.cardId,v.cycle,v.dueOn,v.amountCents)),
 ];
 try{await db.batch(insert);}catch(e){const committed=await replay();if(committed)return committed;throw e;}
 const p=await getPurchase(db,actor,input.cardId,purchaseId);
 const details=await getPurchaseInstallments(db,actor,input.cardId,purchaseId);
 if(!p||!details)throw new Error('Credit purchase not persisted');
 return {purchase:p,installments:details};
}
function invoiceView(cardId:string,row:InvoiceRow):InvoiceView{
 if(row.due_on!==row.max_due ||![row.total_cents,row.paid_cents,row.outstanding_cents,
   row.installment_count,row.purchase_count].every(n=>Number.isSafeInteger(n)&&n>=0) ||
   row.total_cents===0||row.paid_cents>row.total_cents||
   row.outstanding_cents!==row.total_cents-row.paid_cents)throw new Error('Inconsistent invoice aggregate');
 return {cardId,cycle:row.invoice_cycle,dueOn:row.due_on,totalCents:row.total_cents,
  paidCents:row.paid_cents,outstandingCents:row.outstanding_cents,
  state:row.outstanding_cents===0?'paid':row.paid_cents>0?'partially_paid':'open',
  installmentCount:row.installment_count,purchaseCount:row.purchase_count};
}
export async function listInvoices(db:FinancialDatabase,actor:AuthenticatedActor,cardId:string,limit=50,offset=0):Promise<InvoiceView[]>{
 const who=actorId(actor);page(limit,offset);
 if(!await getCard(db,actor,cardId))throw new CreditCardUnavailable();
 const result=await db.prepare(
  'SELECT * FROM credit_invoice_balances WHERE owner_user_id=? AND card_id=? ORDER BY invoice_cycle DESC LIMIT ? OFFSET ?'
 ).bind(who,cardId,limit,offset).all<InvoiceRow>();
 return result.results.map(row=>invoiceView(cardId,row));
}
export async function getInvoice(db:FinancialDatabase,actor:AuthenticatedActor,cardId:string,cycle:string):Promise<{invoice:InvoiceView;installments:InstallmentView[]}|null>{
 const who=actorId(actor);
 if(!await getCard(db,actor,cardId))throw new CreditCardUnavailable();
 if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(cycle))throw new TypeError('Invalid invoice cycle');
 validateDate(cycle+'-01');
 const v=await db.prepare([
  'SELECT i.*,p.title,p.merchant,p.installments_count FROM credit_installments i',
  'JOIN credit_purchases p ON p.owner_user_id=i.owner_user_id AND p.purchase_id=i.purchase_id',
  'WHERE i.owner_user_id=? AND i.card_id=? AND i.invoice_cycle=?',
  'ORDER BY p.purchased_on ASC,p.created_at ASC,i.purchase_id ASC,i.installment_no ASC LIMIT 2001'
 ].join(' ')).bind(who,cardId,cycle).all<InstallmentRow>();
 if(v.results.length>2000)throw new CreditResultTooLarge();
 if(!v.results.length)return null;
 let total=0, dueOn='';
 const purchaseIds=new Set<string>();
 for(const row of v.results){
  if(dueOn&&row.due_on!==dueOn)throw new Error('Inconsistent invoice due date');
  dueOn=row.due_on;
  if(!Number.isSafeInteger(total+row.amount_cents))throw new CreditResultTooLarge();
  total+=row.amount_cents;purchaseIds.add(row.purchase_id);
 }
 const invoiceRow=await db.prepare(
  'SELECT * FROM credit_invoice_balances WHERE owner_user_id=? AND card_id=? AND invoice_cycle=?'
 ).bind(who,cardId,cycle).first<InvoiceRow>();
 if(!invoiceRow)throw new Error('Invoice aggregate disappeared');
 const invoice=invoiceView(cardId,invoiceRow);
 if(invoice.totalCents!==total||invoice.dueOn!==dueOn||
  invoice.purchaseCount!==purchaseIds.size||invoice.installmentCount!==v.results.length)
  throw new Error('Invoice changed during read');
 return {invoice,installments:v.results.map(installmentView)};
}
