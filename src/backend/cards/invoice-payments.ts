import { assertCents } from '../../domain/money.ts';
import type { AuthenticatedActor, FinancialDatabase } from '../accounts/accounts.ts';
import { getAccount } from '../accounts/accounts.ts';
import { getCard, getInvoice, CreditCardUnavailable, CreditIdempotencyConflict } from './cards.ts';
import { validateDate } from '../timeline/timeline.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9_-]{12,128}$/;
const METHODS=new Set(['cash','pix','debit','bank_transfer']);
export class CreditInvoiceUnavailable extends Error {constructor(){super('INVOICE_NOT_FOUND');}}
export class CreditInvoiceInsufficient extends Error {constructor(){super('INVOICE_BALANCE_INSUFFICIENT');}}
export interface InvoicePaymentInput {
 idempotencyKey:string;cardId:string;cycle:string;accountId:string;amountCents:number;
 method:'cash'|'pix'|'debit'|'bank_transfer';paidOn:string;
}
export interface InvoicePaymentView {
 paymentId:string;cardId:string;cycle:string;accountId:string;amountCents:number;
 method:InvoicePaymentInput['method'];paidOn:string;createdAt:string;movementId:string;
}
interface Row {
 payment_id:string;card_id:string;invoice_cycle:string;account_id:string;amount_cents:number;
 method:InvoicePaymentInput['method'];paid_on:string;created_at:string;movement_id:string;
}
function who(actor:AuthenticatedActor){
 if(!actor||typeof actor.userId!=='string'||!actor.userId.trim()||actor.userId.length>128)throw new TypeError('Authenticated user required');
 return actor.userId;
}
function validateCardCycle(cardId:string,cycle:string){
 if(!UUID.test(cardId)||typeof cycle!=='string'||!/^[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(cycle))
  throw new TypeError('Invalid invoice key');
 validateDate(cycle+'-01');
}
function view(r:Row):InvoicePaymentView{
 assertCents(r.amount_cents);
 if(!r.payment_id||!r.movement_id||!UUID.test(r.account_id))throw new Error('Invalid payment record');
 return {paymentId:r.payment_id,cardId:r.card_id,cycle:r.invoice_cycle,accountId:r.account_id,
  amountCents:r.amount_cents,method:r.method,paidOn:r.paid_on,createdAt:r.created_at,movementId:r.movement_id};
}
export async function listInvoicePayments(db:FinancialDatabase,actor:AuthenticatedActor,
 cardId:string,cycle:string,limit=50,offset=0):Promise<InvoicePaymentView[]>{
 const owner=who(actor);validateCardCycle(cardId,cycle);
 if(!Number.isInteger(limit)||limit<1||limit>100||
  !Number.isInteger(offset)||offset<0||offset>100_000)throw new TypeError('Invalid page');
 const invoice=await getInvoice(db,actor,cardId,cycle);
 if(!invoice)throw new CreditInvoiceUnavailable();
 const r=await db.prepare(
  'SELECT * FROM card_invoice_payments WHERE owner_user_id=? AND card_id=? AND invoice_cycle=? ORDER BY paid_on ASC,created_at ASC,payment_id ASC LIMIT ? OFFSET ?'
 ).bind(owner,cardId,cycle,limit,offset).all<Row>();
 return r.results.map(view);
}
export async function payInvoice(db:FinancialDatabase,actor:AuthenticatedActor,
 input:InvoicePaymentInput,clock:()=>Date=()=>new Date()):Promise<InvoicePaymentView>{
 const owner=who(actor);
 if(!input||typeof input!=='object')throw new TypeError('Invalid payment');
 if(typeof input.idempotencyKey!=='string'||!KEY.test(input.idempotencyKey))throw new TypeError('Invalid key');
 validateCardCycle(input.cardId,input.cycle);
 if(typeof input.accountId!=='string'||!UUID.test(input.accountId))throw new TypeError('Invalid account');
 assertCents(input.amountCents);
 if(input.amountCents===0)throw new RangeError('Zero payment');
 if(!METHODS.has(input.method))throw new TypeError('Invalid payment method');
 validateDate(input.paidOn);
 const replay=async():Promise<InvoicePaymentView|null>=>{
  const row=await db.prepare('SELECT * FROM card_invoice_payments WHERE owner_user_id=? AND creation_key=?')
   .bind(owner,input.idempotencyKey).first<Row>();
  if(!row)return null;
  if(row.card_id!==input.cardId||row.invoice_cycle!==input.cycle||
   row.account_id!==input.accountId||row.amount_cents!==input.amountCents||
   row.method!==input.method||row.paid_on!==input.paidOn)throw new CreditIdempotencyConflict();
  return view(row);
 };
 const previous=await replay();
 if(previous)return previous;
 const card=await getCard(db,actor,input.cardId);
 if(!card)throw new CreditCardUnavailable();
 const invoice=await getInvoice(db,actor,input.cardId,input.cycle);
 if(!invoice)throw new CreditInvoiceUnavailable();
 if(input.amountCents>invoice.invoice.outstandingCents)throw new CreditInvoiceInsufficient();
 if(!await getAccount(db,actor,input.accountId))throw new CreditInvoiceUnavailable();
 const paymentId=crypto.randomUUID(),movementId=crypto.randomUUID(),now=clock().toISOString();
 const description=('Pagamento da fatura: '+card.name+' '+input.cycle).slice(0,120);
 const statements=[
  db.prepare([
   'INSERT INTO posted_cash_movements',
   '(owner_user_id,movement_id,creation_key,account_id,direction,amount_cents,payment_method,description,source_label,category,occurred_on,created_at)',
   "VALUES(?,?,?,?, 'expense',?,?,?,?,?,?,?)"
  ].join(' ')).bind(owner,movementId,'card-payment:'+input.idempotencyKey,
   input.accountId,input.amountCents,input.method,description,null,'Pagamento de fatura',input.paidOn,now),
  db.prepare([
   'INSERT INTO card_invoice_payments',
   '(owner_user_id,payment_id,creation_key,card_id,invoice_cycle,movement_id,account_id,amount_cents,method,paid_on,created_at)',
   'VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  ].join(' ')).bind(owner,paymentId,input.idempotencyKey,input.cardId,input.cycle,
   movementId,input.accountId,input.amountCents,input.method,input.paidOn,now),
 ];
 try{await db.batch(statements);}
 catch(e){
  const committed=await replay();
  if(committed)return committed;
  throw e; // Both statements rolled back on overpay, concurrent conflict or bad account.
 }
 const row=await db.prepare('SELECT * FROM card_invoice_payments WHERE owner_user_id=? AND payment_id=?')
  .bind(owner,paymentId).first<Row>();
 if(!row)throw new Error('Payment was not persisted');
 return view(row);
}
