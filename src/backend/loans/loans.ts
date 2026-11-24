import {assertCents, MAX_CENTS, type Cents} from '../../domain/money.ts';
import type {AuthenticatedActor, FinancialDatabase} from '../accounts/accounts.ts';

export class LoanUnavailable extends Error {}
export class LoanConflict extends Error {}
export class LoanTooLarge extends Error {}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY=/^[A-Za-z0-9_-]{12,128}$/;
function owner(a:AuthenticatedActor):string{
 if(!a||typeof a.userId!=='string'||!a.userId.trim()||a.userId.length>128)throw new TypeError('Verified owner required');
 return a.userId;
}
function id(v:unknown):string{if(typeof v!=='string'||!UUID.test(v))throw new TypeError('Invalid identifier');return v;}
function key(v:unknown):string{if(typeof v!=='string'||!KEY.test(v))throw new TypeError('Invalid idempotency key');return v;}
function name(v:unknown):string{if(typeof v!=='string'||!v.trim()||v.trim().length>120||/[\x00-\x1f\x7f]/.test(v))throw new TypeError('Invalid label');return v.trim();}
function date(v:unknown):string{
 if(typeof v!=='string'||!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(v))throw new TypeError('Invalid date');
 const [y,m,d]=v.split('-').map(Number);
 if(!y||!m||!d||y<1000||y>9999)throw new TypeError('Invalid date');
 const actual=new Date(Date.UTC(y,m-1,d));
 if(actual.getUTCFullYear()!==y||actual.getUTCMonth()+1!==m||actual.getUTCDate()!==d)throw new TypeError('Invalid date');
 return v;
}
function cents(v:Cents):number{assertCents(v);if(v<=0||v>MAX_CENTS)throw new RangeError('Invalid loan amount');return v;}
function page(limit:number,offset:number):void{
 if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>1_000_000)throw new TypeError('Invalid pagination');
}
interface LoanRow{
 loan_id:string;creation_key:string;borrower:string;title:string;principal_cents:number;
 source_account_id:string;lent_on:string;due_on:string;repaid_cents:number;outstanding_cents:number;created_at:string;
}
interface RepaymentRow {
 repayment_id:string;loan_id:string;creation_key:string;destination_account_id:string;amount_cents:number;received_on:string;created_at:string;
}
export interface LoanView{
 loanId:string;borrower:string;title:string;principalCents:number;repaidCents:number;outstandingCents:number;
 sourceAccountId:string;lentOn:string;dueOn:string;createdAt:string;state:'open'|'partially_repaid'|'repaid';
}
export interface RepaymentView{
 repaymentId:string;loanId:string;destinationAccountId:string;amountCents:number;receivedOn:string;createdAt:string;
}
export interface GrantLoanInput{
 idempotencyKey:string;borrower:string;title:string;sourceAccountId:string;principalCents:Cents;lentOn:string;dueOn:string;
}
export interface ReceiveRepaymentInput{
 idempotencyKey:string;loanId:string;destinationAccountId:string;amountCents:Cents;receivedOn:string;
}
function toLoan(r:LoanRow):LoanView{
 for(const n of [r.principal_cents,r.repaid_cents,r.outstanding_cents])assertCents(n);
 if(r.principal_cents===0||r.repaid_cents+r.outstanding_cents!==r.principal_cents)throw new LoanConflict();
 return {loanId:r.loan_id,borrower:r.borrower,title:r.title,principalCents:r.principal_cents,
  repaidCents:r.repaid_cents,outstandingCents:r.outstanding_cents,sourceAccountId:r.source_account_id,
  lentOn:r.lent_on,dueOn:r.due_on,createdAt:r.created_at,
  state:r.outstanding_cents===0?'repaid':r.repaid_cents>0?'partially_repaid':'open'};
}
function toRepayment(r:RepaymentRow):RepaymentView{
 assertCents(r.amount_cents);
 return {repaymentId:r.repayment_id,loanId:r.loan_id,destinationAccountId:r.destination_account_id,
  amountCents:r.amount_cents,receivedOn:r.received_on,createdAt:r.created_at};
}
export async function getLoan(db:FinancialDatabase,a:AuthenticatedActor,loanId:string):Promise<LoanView|null>{
 const who=owner(a);id(loanId);
 const row=await db.prepare('SELECT * FROM personal_loan_balances WHERE owner_user_id=? AND loan_id=?').bind(who,loanId).first<LoanRow>();
 return row?toLoan(row):null;
}
export async function listLoans(db:FinancialDatabase,a:AuthenticatedActor,limit=50,offset=0):Promise<LoanView[]>{
 const who=owner(a);page(limit,offset);
 const rows=await db.prepare('SELECT * FROM personal_loan_balances WHERE owner_user_id=? ORDER BY due_on,created_at DESC,loan_id DESC LIMIT ? OFFSET ?')
  .bind(who,limit,offset).all<LoanRow>();
 return rows.results.map(toLoan);
}
export async function grantLoan(db:FinancialDatabase,a:AuthenticatedActor,input:GrantLoanInput,clock=()=>new Date()):Promise<LoanView>{
 const who=owner(a),k=key(input?.idempotencyKey),borrower=name(input.borrower),title=name(input.title),
  account=id(input.sourceAccountId),amount=cents(input.principalCents),lent=date(input.lentOn),due=date(input.dueOn);
 if(due<lent)throw new TypeError('Due date precedes grant');
 const replay=async()=>{
  const row=await db.prepare('SELECT * FROM personal_loan_balances WHERE owner_user_id=? AND creation_key=?').bind(who,k).first<LoanRow>();
  if(!row)return null;
  if(row.borrower!==borrower||row.title!==title||row.source_account_id!==account||
   row.principal_cents!==amount||row.lent_on!==lent||row.due_on!==due)throw new LoanConflict();
  return toLoan(row);
 };
 const existing=await replay();if(existing)return existing;
 const loanId=crypto.randomUUID();
 try{
  await db.prepare('INSERT INTO personal_loans(owner_user_id,loan_id,creation_key,borrower,title,source_account_id,principal_cents,lent_on,due_on,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
   .bind(who,loanId,k,borrower,title,account,amount,lent,due,clock().toISOString()).run();
 }catch(error){const committed=await replay();if(committed)return committed;throw error;}
 const created=await getLoan(db,a,loanId);if(!created)throw new Error('Loan not readable after insert');return created;
}
export async function listLoanRepayments(db:FinancialDatabase,a:AuthenticatedActor,loanId:string,limit=50,offset=0):Promise<RepaymentView[]>{
 const who=owner(a);id(loanId);page(limit,offset);
 if(!await getLoan(db,a,loanId))throw new LoanUnavailable();
 const rows=await db.prepare('SELECT * FROM personal_loan_repayments WHERE owner_user_id=? AND loan_id=? ORDER BY received_on DESC,created_at DESC,repayment_id DESC LIMIT ? OFFSET ?')
  .bind(who,loanId,limit,offset).all<RepaymentRow>();
 return rows.results.map(toRepayment);
}
export async function receiveLoanRepayment(
 db:FinancialDatabase,a:AuthenticatedActor,input:ReceiveRepaymentInput,clock=()=>new Date(),
):Promise<RepaymentView>{
 const who=owner(a),k=key(input?.idempotencyKey),loanId=id(input.loanId),
  account=id(input.destinationAccountId),amount=cents(input.amountCents),received=date(input.receivedOn);
 const replay=async()=>{
  const row=await db.prepare('SELECT * FROM personal_loan_repayments WHERE owner_user_id=? AND creation_key=?').bind(who,k).first<RepaymentRow>();
  if(!row)return null;
  if(row.loan_id!==loanId||row.destination_account_id!==account||row.amount_cents!==amount||row.received_on!==received)throw new LoanConflict();
  return toRepayment(row);
 };
 const previous=await replay();if(previous)return previous;
 if(!await getLoan(db,a,loanId))throw new LoanUnavailable();
 const repaymentId=crypto.randomUUID();
 try{
  await db.prepare('INSERT INTO personal_loan_repayments(owner_user_id,repayment_id,creation_key,loan_id,destination_account_id,amount_cents,received_on,created_at) VALUES(?,?,?,?,?,?,?,?)')
   .bind(who,repaymentId,k,loanId,account,amount,received,clock().toISOString()).run();
 }catch(error){const committed=await replay();if(committed)return committed;throw error;}
 const row=await db.prepare('SELECT * FROM personal_loan_repayments WHERE owner_user_id=? AND repayment_id=?')
  .bind(who,repaymentId).first<RepaymentRow>();
 if(!row)throw new Error('Loan repayment not readable after insert');
 return toRepayment(row);
}
