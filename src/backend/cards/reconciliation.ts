// Aggregate invoices can exceed the per-entry MAX_CENTS without losing safe integer precision.
import type { AuthenticatedActor, FinancialDatabase } from '../accounts/accounts.ts';
import { getInvoice, CreditCardUnavailable, CreditIdempotencyConflict } from './cards.ts';
import { CreditInvoiceUnavailable } from './invoice-payments.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9_-]{12,128}$/;
type ReconciliationStatus='unreported'|'matched'|'pending_divergence';
export interface BankObservation {
 observationId:string;cardId:string;cycle:string;reportedTotalCents:number;
 calculatedAtEntryCents:number;createdAt:string;source:'manual';
}
export interface InvoiceReconciliation {
 cardId:string;cycle:string;status:ReconciliationStatus;
 calculatedTotalCents:number;reportedTotalCents:number|null;
 differenceCents:number|null;latestObservation:BankObservation|null;
 // Never interpret this comparison as an adjustment to the ledger.
 source:'manual'|null;
}
export interface ReconciliationPage {
 reconciliation:InvoiceReconciliation;observations:BankObservation[];
 hasMore:boolean;limit:number;offset:number;
}
interface Row{
 observation_id:string;card_id:string;invoice_cycle:string;reported_total_cents:number;
 calculated_total_at_entry_cents:number;created_at:string;
}
export interface RecordBankTotal {
 idempotencyKey:string;cardId:string;cycle:string;reportedTotalCents:number;
}
function who(actor:AuthenticatedActor):string{
 if(!actor || typeof actor.userId!=='string'||!actor.userId.trim()||actor.userId.length>128)
  throw new TypeError('Authenticated user required');
 return actor.userId;
}
function validate(cardId:string,cycle:string):void{
 if(typeof cardId!=='string'||!UUID.test(cardId)||typeof cycle!=='string'||
    !/^[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(cycle)||
    Number(cycle.slice(0,4))<1000)throw new TypeError('Invalid invoice key');
}
function safeAggregate(cents:number,allowZero=true):void{
 if(!Number.isSafeInteger(cents)||cents<0||(!allowZero&&cents===0))
  throw new RangeError('Invalid bank invoice total in cents');
}
export function parseReportedInvoiceCents(decimal:string):number{
 if(typeof decimal!=='string'||!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(decimal))
  throw new RangeError('Invalid invoice total decimal');
 const [whole='0',fraction='']=decimal.split('.');
 const cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
 if(cents>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Invoice total exceeds safe integer range');
 return Number(cents);
}
function view(row:Row):BankObservation{
 safeAggregate(row.reported_total_cents);safeAggregate(row.calculated_total_at_entry_cents,false);
 if(row.calculated_total_at_entry_cents===0)throw new Error('Invalid historical comparison');
 return {
  observationId:row.observation_id,cardId:row.card_id,cycle:row.invoice_cycle,
  reportedTotalCents:row.reported_total_cents,
  calculatedAtEntryCents:row.calculated_total_at_entry_cents,
  createdAt:row.created_at,source:'manual',
 };
}
async function invoiceTotal(db:FinancialDatabase,actor:AuthenticatedActor,cardId:string,cycle:string):Promise<number>{
 // Authorized first: another user's card is intentionally not enumerable.
 const invoice=await getInvoice(db,actor,cardId,cycle);
 if(!invoice)throw new CreditInvoiceUnavailable();
 return invoice.invoice.totalCents;
}
function compare(cardId:string,cycle:string,calculatedTotal:number,row:Row|null):InvoiceReconciliation{
 const latest=row?view(row):null,reported=latest?.reportedTotalCents??null;
 const diff=reported===null?null:reported-calculatedTotal;
 if(diff!==null&&!Number.isSafeInteger(diff))throw new RangeError('Reconciliation difference exceeds safe integer range');
 return {
  cardId,cycle,calculatedTotalCents:calculatedTotal,
  reportedTotalCents:reported,differenceCents:diff,latestObservation:latest,
  status:diff===null?'unreported':diff===0?'matched':'pending_divergence',
  source:latest?'manual':null,
 };
}
export async function readInvoiceReconciliation(
 db:FinancialDatabase,actor:AuthenticatedActor,cardId:string,cycle:string,limit=25,offset=0,
):Promise<ReconciliationPage>{
 const owner=who(actor);validate(cardId,cycle);
 if(!Number.isInteger(limit)||limit<1||limit>100||
    !Number.isInteger(offset)||offset<0||offset>100_000)throw new TypeError('Invalid page');
 const total=await invoiceTotal(db,actor,cardId,cycle);
 const rows=await db.prepare(
  'SELECT * FROM card_invoice_bank_observations WHERE owner_user_id=? AND card_id=? AND invoice_cycle=? ORDER BY observation_seq DESC LIMIT ? OFFSET ?'
 ).bind(owner,cardId,cycle,limit+1,offset).all<Row>();
 const latest=offset===0?rows.results[0]??null:await db.prepare(
  'SELECT * FROM card_invoice_bank_observations WHERE owner_user_id=? AND card_id=? AND invoice_cycle=? ORDER BY observation_seq DESC LIMIT 1'
 ).bind(owner,cardId,cycle).first<Row>();
 return {
  reconciliation:compare(cardId,cycle,total,latest),
  observations:rows.results.slice(0,limit).map(view),
  hasMore:rows.results.length>limit,limit,offset,
 };
}
export async function recordInvoiceBankTotal(
 db:FinancialDatabase,actor:AuthenticatedActor,input:RecordBankTotal,clock:()=>Date=()=>new Date(),
):Promise<InvoiceReconciliation>{
 const owner=who(actor);
 if(!input||typeof input!=='object')throw new TypeError('Invalid observation');
 validate(input.cardId,input.cycle);
 if(typeof input.idempotencyKey!=='string'||!KEY.test(input.idempotencyKey))
  throw new TypeError('Invalid observation key');
 safeAggregate(input.reportedTotalCents); // zero is a valid bank-reported total
 const previous=async():Promise<BankObservation|null>=>{
  const row=await db.prepare(
   'SELECT * FROM card_invoice_bank_observations WHERE owner_user_id=? AND creation_key=?'
  ).bind(owner,input.idempotencyKey).first<Row>();
  if(!row)return null;
  if(row.card_id!==input.cardId||row.invoice_cycle!==input.cycle||
     row.reported_total_cents!==input.reportedTotalCents)
   throw new CreditIdempotencyConflict();
  return view(row);
 };
 // Idempotent replays do not append observations or move them to "latest".
 const existing=await previous();
 if(existing){
  // Replay proves the original operation already exists, while the read model
  // must reflect any subsequent independently entered manual observations.
  return (await readInvoiceReconciliation(db,actor,input.cardId,input.cycle,1)).reconciliation;
 }
 // An INSERT ... SELECT obtains a real authorized invoice aggregate as its
 // historical snapshot and is protected from concurrent invalidation by SQL.
 await invoiceTotal(db,actor,input.cardId,input.cycle);
 const id=crypto.randomUUID();
 const createdAt=clock().toISOString();
 try{
  await db.prepare([
   'INSERT INTO card_invoice_bank_observations',
   '(owner_user_id,observation_id,creation_key,card_id,invoice_cycle,reported_total_cents,calculated_total_at_entry_cents,created_at)',
   'SELECT ?,?,?,?,?,?,v.total_cents,? FROM credit_invoice_balances v',
   'WHERE v.owner_user_id=? AND v.card_id=? AND v.invoice_cycle=?'
  ].join(' ')).bind(owner,id,input.idempotencyKey,input.cardId,input.cycle,
    input.reportedTotalCents,createdAt,owner,input.cardId,input.cycle).run();
 }catch(e){
  const completed=await previous();if(completed){
   const latest=await readInvoiceReconciliation(db,actor,input.cardId,input.cycle,1);
   return latest.reconciliation;
  }
  throw e;
 }
 // Re-read current state after INSERT; latest may now be a concurrent report.
 const latest=await readInvoiceReconciliation(db,actor,input.cardId,input.cycle,1);
 // The durable row must exist even if another user action creates a newer report.
 if(!latest.reconciliation.latestObservation)throw new Error('Bank observation did not persist');
 // Total is never used to update the invoice; retained solely for comparison.
 return latest.reconciliation;
}
