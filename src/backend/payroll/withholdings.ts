import type {AuthenticatedActor,FinancialDatabase} from '../accounts/accounts.ts';
import {assertCents} from '../../domain/money.ts';
import {validateDate} from '../timeline/timeline.ts';
import {getObligation, type ObligationView} from '../obligations/obligations.ts';
import {getStatement} from '../payroll/payroll.ts';
import {checkOccurrence} from '../income/income.ts';

export class WithholdingConflict extends Error {}
export class WithholdingNotFound extends Error {}
export class WithholdingNotApplicable extends Error {}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9_-]{12,128}$/;
const owner=(a:AuthenticatedActor)=>{
 if(!a||typeof a.userId!=='string'||!a.userId.trim()||a.userId.length>128)throw new TypeError('Verified user required');
 return a.userId;
};
const id=(s:string)=>{if(typeof s!=='string'||!UUID.test(s))throw new TypeError('Invalid resource ID');return s;};
const key=(s:string)=>{if(typeof s!=='string'||!KEY.test(s))throw new TypeError('Invalid key');return s;};
const day=(s:string)=>{validateDate(s);return s;};
const page=(limit:number,offset:number)=>{
 if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>100000)
  throw new TypeError('Invalid pagination');
};
export interface WithholdingInput{
 idempotencyKey:string;statementId:number;discountIndex:number;obligationId:string;
 amountCents:number;confirmedOn:string;confirmRetained:boolean;
}
interface WithholdingRow{
 payment_id:string;statement_seq:number;discount_index:number;obligation_id:string;
 source_id:string;occurrence_key:string;amount_cents:number;confirmed_on:string;created_at:string;
 creation_key:string;discounts_json:string;
}
export interface WithholdingView{
 paymentId:string;statementId:number;discountIndex:number;discountLabel:string;
 sourceId:string;occurrenceKey:string;obligationId:string;amountCents:number;
 confirmedOn:string;createdAt:string;origin:'salary_withholding_confirmed';
}
const project=(r:WithholdingRow):WithholdingView=>{
 assertCents(r.amount_cents);
 const list=JSON.parse(r.discounts_json) as {label:string;amountCents:number}[];
 const d=list[r.discount_index];
 if(!d||typeof d.label!=='string')throw new RangeError('Invalid withholding evidence');
 return {paymentId:r.payment_id,statementId:r.statement_seq,discountIndex:r.discount_index,
  discountLabel:d.label,sourceId:r.source_id,occurrenceKey:r.occurrence_key,
  obligationId:r.obligation_id,amountCents:r.amount_cents,
  confirmedOn:r.confirmed_on,createdAt:r.created_at,origin:'salary_withholding_confirmed'};
};
const JOIN=[
 'SELECT p.*,s.source_id,s.occurrence_key,s.discounts_json FROM salary_withheld_obligation_payments p',
 'JOIN salary_period_statements s ON s.statement_seq=p.statement_seq AND s.owner_user_id=p.owner_user_id',
].join(' ');
const record=async(db:FinancialDatabase,who:string,creationKey:string)=>{
 const x=await db.prepare(JOIN+' WHERE p.owner_user_id=? AND p.creation_key=?').bind(who,creationKey).first<WithholdingRow>();
 return x?project(x):null;
};
export async function listSalaryWithholdings(db:FinancialDatabase,actor:AuthenticatedActor,
 sourceId:string,occ:string,limit=50,offset=0):Promise<WithholdingView[]>{
 const who=owner(actor);page(limit,offset);
 await checkOccurrence(db,actor,sourceId,occ);
 const rows=await db.prepare(JOIN+' WHERE p.owner_user_id=? AND s.source_id=? AND s.occurrence_key=? ORDER BY p.created_at DESC,p.payment_id DESC LIMIT ? OFFSET ?')
  .bind(who,sourceId,occ,limit,offset).all<WithholdingRow>();
 return rows.results.map(project);
}
export async function listObligationWithholdings(db:FinancialDatabase,actor:AuthenticatedActor,
 obligationId:string,limit=50,offset=0):Promise<WithholdingView[]>{
 const who=owner(actor);page(limit,offset);id(obligationId);
 if(!await getObligation(db,actor,obligationId))throw new WithholdingNotFound();
 const rows=await db.prepare(JOIN+' WHERE p.owner_user_id=? AND p.obligation_id=? ORDER BY p.confirmed_on DESC,p.payment_id DESC LIMIT ? OFFSET ?')
  .bind(who,obligationId,limit,offset).all<WithholdingRow>();
 return rows.results.map(project);
}
/**
 * Confirmation is always a separate human POST after user-entered E3 details.
 * A salary discount is already withheld before the bank sees the net payment:
 * do NOT create posted_cash_movements or financial_obligation_payments.
 * SQL INSERT guard is the authoritative constraint under concurrent writes.
 */
export async function confirmSalaryWithholding(db:FinancialDatabase,actor:AuthenticatedActor,
 sourceId:string,occ:string,input:WithholdingInput,clock=()=>new Date()):Promise<WithholdingView>{
 const who=owner(actor),k=key(input.idempotencyKey),obId=id(input.obligationId);
 if(!Number.isSafeInteger(input.statementId)||input.statementId<1||
   !Number.isInteger(input.discountIndex)||input.discountIndex<0||input.discountIndex>19)
  throw new TypeError('Invalid salary evidence');
 assertCents(input.amountCents);
 if(input.amountCents===0)throw new RangeError('Withheld amount must be positive');
 const confirmed=day(input.confirmedOn);
 if(input.confirmRetained!==true)throw new WithholdingNotApplicable('User confirmation required');
 await checkOccurrence(db,actor,sourceId,occ);
 const replay=async()=>{
  const v=await record(db,who,k);
  if(!v)return null;
  if(v.sourceId!==sourceId||v.occurrenceKey!==occ||v.statementId!==input.statementId||
    v.discountIndex!==input.discountIndex||v.obligationId!==obId||
    v.amountCents!==input.amountCents||v.confirmedOn!==confirmed)throw new WithholdingConflict();
  return v;
 };
 const original=await replay();if(original)return original;
 const statement=await getStatement(db,actor,sourceId,occ);
 if(!statement||statement.statementId!==input.statementId||
    statement.grossCents===null||statement.grossStatus!=='matched')
  throw new WithholdingNotApplicable('Reconciled gross and discounts required');
 const deduction=statement.discounts[input.discountIndex];
 if(!deduction||input.amountCents>deduction.amountCents)throw new WithholdingConflict();
 const obligation:ObligationView|null=await getObligation(db,actor,obId);
 if(!obligation)throw new WithholdingNotFound();
 if(obligation.state==='canceled'||obligation.outstandingCents<input.amountCents)
  throw new WithholdingConflict();
 const paymentId=crypto.randomUUID();
 try{
  await db.prepare('INSERT INTO salary_withheld_obligation_payments(owner_user_id,payment_id,creation_key,statement_seq,discount_index,obligation_id,amount_cents,confirmed_on,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
   .bind(who,paymentId,k,input.statementId,input.discountIndex,obId,input.amountCents,confirmed,clock().toISOString()).run();
 }catch(e){
  const saved=await replay();if(saved)return saved;
  if(e instanceof Error&&/WITHHOLDING_INVALID|WITHHOLDING_IMMUTABLE|UNIQUE constraint|SQLITE_CONSTRAINT/.test(e.message))
   throw new WithholdingConflict();
  throw e;
 }
 const saved=await record(db,who,k);
 if(!saved)throw new Error('Confirmed withholding not readable');
 return saved;
}
