import {assertCents} from '../../domain/money.ts';
import type {AuthenticatedActor,FinancialDatabase} from '../accounts/accounts.ts';
import {getObligation} from '../obligations/obligations.ts';
import {getInvoice} from '../cards/cards.ts';
import {getAccount} from '../accounts/accounts.ts';
import {validateDate} from '../timeline/timeline.ts';

export class DebtRenegotiationUnavailable extends Error{}
export class DebtRenegotiationConflict extends Error{}
export class DebtRenegotiationTooLarge extends Error{}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY=/^[A-Za-z0-9_-]{12,128}$/;
const MAX=9000000000000n;
type Method='pix'|'cash'|'debit'|'bank_transfer';
export type DebtSubject={kind:'obligation';obligationId:string}|{kind:'card_invoice';cardId:string;cycle:string};
export type InstallmentInput={dueOn:string;amountCents:number};
export interface RenegotiationInput{
 idempotencyKey:string;subject:DebtSubject;expectedOutstandingCents:number;feesCents:number;
 agreedOn:string;installments:InstallmentInput[];reason?:string|null;
}
export interface RenegotiationPaymentInput{
 idempotencyKey:string;agreementId:string;installmentNo:number;accountId:string;
 amountCents:number;method:Method;paidOn:string;
}
interface AgreementRow{
 agreement_id:string;creation_key:string;subject_kind:'obligation'|'card_invoice';
 obligation_id:string|null;card_id:string|null;invoice_cycle:string|null;
 base_outstanding_cents:number;fees_cents:number;schedule_json:string;agreed_on:string;
 reason:string|null;created_at:string;
}
interface InstallmentRow{installment_no:number;due_on:string;total_cents:number;paid_cents:number;outstanding_cents:number}
interface PaymentRow{payment_id:string;creation_key:string;agreement_id:string;installment_no:number;movement_id:string;
 account_id:string;amount_cents:number;method:Method;paid_on:string;created_at:string}
export interface RenegotiationView{
 agreementId:string;subject:DebtSubject;originalRemainingCents:number;feesCents:number;
 newTotalCents:number;paidAfterAgreementCents:number;outstandingCents:number;agreedOn:string;
 reason:string|null;createdAt:string;state:'open'|'partially_paid'|'paid';
 installments:{installmentNo:number;dueOn:string;totalCents:number;paidCents:number;outstandingCents:number;state:'open'|'partially_paid'|'paid'}[];
}
export interface RenegotiationPaymentView{paymentId:string;agreementId:string;installmentNo:number;movementId:string;
 accountId:string;amountCents:number;method:Method;paidOn:string;createdAt:string}
function owner(a:AuthenticatedActor):string{if(!a||typeof a.userId!=='string'||!a.userId.trim()||a.userId.length>128)
 throw new TypeError('Verified principal required');return a.userId;}
function id(v:unknown):string{if(typeof v!=='string'||!UUID.test(v))throw new TypeError('Invalid ID');return v;}
function key(v:unknown):string{if(typeof v!=='string'||!KEY.test(v))throw new TypeError('Invalid idempotency key');return v;}
function positive(v:number):number{assertCents(v);if(v<1||BigInt(v)>MAX)throw new RangeError('Amount must be positive');return v;}
function fee(v:number):number{assertCents(v);if(BigInt(v)>MAX)throw new RangeError('Fee too large');return v;}
function label(v:unknown):string|null{
 if(v===undefined||v===null)return null;
 if(typeof v!=='string'||!v.trim()||v.trim().length>120||/[\x00-\x1f\x7f]/.test(v))
  throw new TypeError('Invalid reason');
 return v.trim();
}
function subject(v:DebtSubject):DebtSubject{
 if(!v||typeof v!=='object'||Array.isArray(v))throw new TypeError('Invalid debt subject');
 if(v.kind==='obligation'&&Object.keys(v).every(x=>['kind','obligationId'].includes(x)))
  return {kind:'obligation',obligationId:id(v.obligationId)};
 if(v.kind==='card_invoice'&&Object.keys(v).every(x=>['kind','cardId','cycle'].includes(x))){
  if(typeof v.cycle!=='string'||!/^[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(v.cycle))throw new TypeError('Invalid invoice cycle');
  validateDate(v.cycle+'-01');
  return {kind:'card_invoice',cardId:id(v.cardId),cycle:v.cycle};
 }
 throw new TypeError('Invalid debt subject');
}
function schedule(v:InstallmentInput[],agreedOn:string):{json:string;total:number}{
 if(!Array.isArray(v)||v.length<1||v.length>24)throw new TypeError('Invalid installment count');
 let last=agreedOn,total=0n;
 const entries=v.map(x=>{
  if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!['dueOn','amountCents'].includes(k)))
   throw new TypeError('Invalid installment');
  validateDate(x.dueOn);
  if(x.dueOn<last)throw new TypeError('Installment dates must be ordered and not before the agreement');
  last=x.dueOn;
  total+=BigInt(positive(x.amountCents));
  if(total>MAX)throw new DebtRenegotiationTooLarge();
  return {dueOn:x.dueOn,amountCents:x.amountCents};
 });
 return {json:JSON.stringify(entries),total:Number(total)};
}
function asSubject(row:AgreementRow):DebtSubject{
 if(row.subject_kind==='obligation'&&row.obligation_id)return {kind:'obligation',obligationId:row.obligation_id};
 if(row.subject_kind==='card_invoice'&&row.card_id&&row.invoice_cycle)
  return {kind:'card_invoice',cardId:row.card_id,cycle:row.invoice_cycle};
 throw new DebtRenegotiationConflict();
}
function paymentView(r:PaymentRow):RenegotiationPaymentView{
 positive(r.amount_cents);
 return {paymentId:r.payment_id,agreementId:r.agreement_id,installmentNo:r.installment_no,
  movementId:r.movement_id,accountId:r.account_id,amountCents:r.amount_cents,
  method:r.method,paidOn:r.paid_on,createdAt:r.created_at};
}
export async function getRenegotiation(db:FinancialDatabase,a:AuthenticatedActor,agreementId:string):Promise<RenegotiationView|null>{
 const who=owner(a);id(agreementId);
 const row=await db.prepare('SELECT * FROM debt_renegotiations WHERE owner_user_id=? AND agreement_id=?')
  .bind(who,agreementId).first<AgreementRow>();
 if(!row)return null;
 const installments=(await db.prepare('SELECT installment_no,due_on,total_cents,paid_cents,outstanding_cents FROM debt_renegotiation_installment_balances WHERE owner_user_id=? AND agreement_id=? ORDER BY installment_no')
  .bind(who,agreementId).all<InstallmentRow>()).results;
 if(installments.length<1||installments.length>24)throw new DebtRenegotiationConflict();
 let total=0n,paid=0n,open=0n;
 const items=installments.map((r,i)=>{
  if(r.installment_no!==i+1)throw new DebtRenegotiationConflict();
  for(const n of [r.total_cents,r.paid_cents,r.outstanding_cents])assertCents(n);
  if(r.total_cents<1||r.paid_cents+r.outstanding_cents!==r.total_cents)throw new DebtRenegotiationConflict();
  total+=BigInt(r.total_cents);paid+=BigInt(r.paid_cents);open+=BigInt(r.outstanding_cents);
  return {installmentNo:r.installment_no,dueOn:r.due_on,totalCents:r.total_cents,
   paidCents:r.paid_cents,outstandingCents:r.outstanding_cents,
   state:r.outstanding_cents===0?'paid' as const:r.paid_cents>0?'partially_paid' as const:'open' as const};
 });
 if(total!==BigInt(row.base_outstanding_cents)+BigInt(row.fees_cents)||total>MAX||paid>total)throw new DebtRenegotiationConflict();
 return {agreementId:row.agreement_id,subject:asSubject(row),originalRemainingCents:row.base_outstanding_cents,
  feesCents:row.fees_cents,newTotalCents:Number(total),paidAfterAgreementCents:Number(paid),
  outstandingCents:Number(open),agreedOn:row.agreed_on,reason:row.reason,createdAt:row.created_at,
  state:open===0n?'paid':paid>0n?'partially_paid':'open',installments:items};
}
export async function listRenegotiations(db:FinancialDatabase,a:AuthenticatedActor,limit=50,offset=0):Promise<RenegotiationView[]>{
 const who=owner(a);
 if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1_000_000)throw new TypeError('Invalid pagination');
 const rows=(await db.prepare('SELECT agreement_id FROM debt_renegotiations WHERE owner_user_id=? ORDER BY agreed_on DESC,created_at DESC,agreement_id DESC LIMIT ? OFFSET ?')
  .bind(who,limit,offset).all<{agreement_id:string}>()).results;
 const out:RenegotiationView[]=[];
 for(const r of rows){const item=await getRenegotiation(db,a,r.agreement_id);if(!item)throw new DebtRenegotiationConflict();out.push(item);}
 return out;
}
export async function createRenegotiation(db:FinancialDatabase,a:AuthenticatedActor,input:RenegotiationInput,
 clock:()=>Date=()=>new Date()):Promise<RenegotiationView>{
 const who=owner(a),k=key(input?.idempotencyKey),item=subject(input.subject),
  base=positive(input.expectedOutstandingCents),fees=fee(input.feesCents),reason=label(input.reason);
 validateDate(input.agreedOn);
 const plan=schedule(input.installments,input.agreedOn);
 if(BigInt(base)+BigInt(fees)!==BigInt(plan.total))throw new DebtRenegotiationConflict();
 const replay=async()=>{
  const r=await db.prepare('SELECT * FROM debt_renegotiations WHERE owner_user_id=? AND creation_key=?')
   .bind(who,k).first<AgreementRow>();
  if(!r)return null;
  if(JSON.stringify(asSubject(r))!==JSON.stringify(item)||r.base_outstanding_cents!==base||
    r.fees_cents!==fees||r.schedule_json!==plan.json||r.agreed_on!==input.agreedOn||
    r.reason!==reason)throw new DebtRenegotiationConflict();
  return getRenegotiation(db,a,r.agreement_id);
 };
 const previous=await replay();if(previous)return previous;
 const original=item.kind==='obligation'
  ?await getObligation(db,a,item.obligationId)
  :await getInvoice(db,a,item.cardId,item.cycle);
 if(!original)throw new DebtRenegotiationUnavailable();
 const outstanding=item.kind==='obligation'?('outstandingCents' in original?original.outstandingCents:0)
  :('invoice' in original?original.invoice.outstandingCents:0);
 if(outstanding!==base)throw new DebtRenegotiationConflict();
 const agreementId=crypto.randomUUID();
 try{
  await db.prepare([
   'INSERT INTO debt_renegotiations(owner_user_id,agreement_id,creation_key,subject_kind,obligation_id,card_id,invoice_cycle,',
   'base_outstanding_cents,fees_cents,schedule_json,agreed_on,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ].join(' ')).bind(who,agreementId,k,item.kind,item.kind==='obligation'?item.obligationId:null,
   item.kind==='card_invoice'?item.cardId:null,item.kind==='card_invoice'?item.cycle:null,
   base,fees,plan.json,input.agreedOn,reason,clock().toISOString()).run();
 }catch(e){const committed=await replay();if(committed)return committed;throw e;}
 const view=await getRenegotiation(db,a,agreementId);
 if(!view)throw new Error('Committed renegotiation not readable');return view;
}
export async function listRenegotiationPayments(db:FinancialDatabase,a:AuthenticatedActor,idValue:string,limit=50,offset=0):Promise<RenegotiationPaymentView[]>{
 const who=owner(a),idAgreement=id(idValue);
 if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1_000_000)throw new TypeError('Invalid pagination');
 if(!await getRenegotiation(db,a,idAgreement))throw new DebtRenegotiationUnavailable();
 const rows=(await db.prepare('SELECT * FROM debt_renegotiation_payments WHERE owner_user_id=? AND agreement_id=? ORDER BY paid_on DESC,created_at DESC,payment_id DESC LIMIT ? OFFSET ?')
  .bind(who,idAgreement,limit,offset).all<PaymentRow>()).results;
 return rows.map(paymentView);
}
export async function payRenegotiation(db:FinancialDatabase,a:AuthenticatedActor,input:RenegotiationPaymentInput,
 clock:()=>Date=()=>new Date()):Promise<RenegotiationPaymentView>{
 const who=owner(a),k=key(input?.idempotencyKey),agreementId=id(input.agreementId),
  accountId=id(input.accountId),amount=positive(input.amountCents);
 if(!Number.isInteger(input.installmentNo)||input.installmentNo<1||input.installmentNo>24)
  throw new TypeError('Invalid installment index');
 if(!['cash','pix','debit','bank_transfer'].includes(input.method))throw new TypeError('Invalid method');
 validateDate(input.paidOn);
 const replay=async()=>{
  const r=await db.prepare('SELECT * FROM debt_renegotiation_payments WHERE owner_user_id=? AND creation_key=?')
   .bind(who,k).first<PaymentRow>();
  if(!r)return null;
  if(r.agreement_id!==agreementId||r.installment_no!==input.installmentNo||r.account_id!==accountId||
   r.amount_cents!==amount||r.method!==input.method||r.paid_on!==input.paidOn)throw new DebtRenegotiationConflict();
  return paymentView(r);
 };
 const old=await replay();if(old)return old;
 const agreement=await getRenegotiation(db,a,agreementId);
 if(!agreement)throw new DebtRenegotiationUnavailable();
 const part=agreement.installments.find(i=>i.installmentNo===input.installmentNo);
 if(!part||part.outstandingCents<amount||input.paidOn<agreement.agreedOn)throw new DebtRenegotiationConflict();
 if(!await getAccount(db,a,accountId))throw new DebtRenegotiationUnavailable();
 const paymentId=crypto.randomUUID(),movementId=crypto.randomUUID(),time=clock().toISOString();
 const stmts=[
  db.prepare([
   'INSERT INTO posted_cash_movements',
   '(owner_user_id,movement_id,creation_key,account_id,direction,amount_cents,payment_method,description,source_label,category,occurred_on,created_at)',
   "VALUES(?,?,?,?, 'expense',?,?,?,?,?,?,?)"
  ].join(' ')).bind(who,movementId,'debt-renegotiation:'+k,accountId,amount,input.method,
   ('Pagamento de acordo · parcela '+input.installmentNo).slice(0,120),null,'Renegociação',input.paidOn,time),
  db.prepare([
   'INSERT INTO debt_renegotiation_payments',
   '(owner_user_id,payment_id,creation_key,agreement_id,installment_no,movement_id,account_id,amount_cents,method,paid_on,created_at)',
   'VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  ].join(' ')).bind(who,paymentId,k,agreementId,input.installmentNo,movementId,
   accountId,amount,input.method,input.paidOn,time),
 ];
 try{await db.batch(stmts);}catch(e){const committed=await replay();if(committed)return committed;throw e;}
 const row=await db.prepare('SELECT * FROM debt_renegotiation_payments WHERE owner_user_id=? AND payment_id=?')
  .bind(who,paymentId).first<PaymentRow>();
 if(!row)throw new Error('Committed renegotiation payment not readable');
 return paymentView(row);
}
