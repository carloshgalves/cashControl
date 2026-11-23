import {validateDate} from '../timeline/timeline.ts';
import {assertCents} from '../../domain/money.ts';
import {listCalendar,IncomeTooLarge,type Expectation} from '../income/income.ts';
import {getIntention,IntentionUnavailable,getPlanningSummary,PlanningTooLarge} from './intentions.ts';
import type {AuthenticatedActor,FinancialDatabase} from '../accounts/accounts.ts';

/**
 * F2 is READ-ONLY. It never reserves money, posts cash, creates obligations,
 * or promises future receipts. Opening bank balances are CURRENT; users must
 * not interpret date labels as historical account-balance snapshots.
 */
export class SimulationConflict extends Error {}
export class SimulationTooLarge extends Error {}
export interface HypotheticalPurchase {
 amountCents:number;purchaseOn:string;dueOn:string;intentionId?:string;
}
export interface SimulationInput{
 from:string;to:string;hypothetical?:HypotheticalPurchase|null;
}
export interface ProjectedIncome{
 sourceId:string;occurrenceKey:string;sourceName:string;
 date:string;state:'planned'|'confirmed'|'delayed';
 remainingCents:number;cashReceived:'already_in_current_balance_or_not_linked';
}
export interface ScenarioPoint{
 date:string;outstandingPaymentsCents:number;
 explicitExpectedIncomeCents:number;releasedReservationCents:number;
 hypotheticalPaymentCents:number;hypotheticalCommitmentCents:number;
 conservativeCashAfterAssumedPaymentsCents:number;
 plannedCashIncludingUnreceivedIncomeCents:number;
 conservativeFreeMarginCents:number;plannedFreeMarginCents:number;
 conservativeCashNegative:boolean;plannedCashNegative:boolean;
 conservativeMarginNegative:boolean;plannedMarginNegative:boolean;
}
export interface ScenarioReport{
 kind:'ephemeral_read_only';
 asOfBasis:'current_snapshot_not_historical_balance';
 from:string;to:string;
 currency:'BRL';
 openingRealCashCents:number;
 existingOutstandingObligationsCents:number;
 existingOutstandingCardInvoicesCents:number;
 activeVirtualReserveCents:number;
 hypothetical:{amountCents:number;purchaseOn:string;dueOn:string;
  intentionId:string|null;replacedExistingReserveCents:number}|null;
 unreceivedExplicitIncomeCents:number;
 unreceivedSources:ProjectedIncome[];
 conservative:{basis:'current_cash_and_known_outstanding_only';endingCashCents:number;endingFreeMarginCents:number;lowestCashCents:number;lowestMarginCents:number};
 planned:{basis:'explicit_unreceived_expectations_not_guaranteed';endingCashCents:number;endingFreeMarginCents:number;lowestCashCents:number;lowestMarginCents:number};
 points:ScenarioPoint[];
 notes:string[];
}
interface DueRow{due_on:string;outstanding_cents:number}
interface ReserveRow{intention_id:string;reserved_cents:number}
const MS_DAY=86400000;
const owner=(a:AuthenticatedActor)=>{
 if(!a||typeof a.userId!=='string'||!a.userId.trim()||a.userId.length>128)
  throw new TypeError('Verified principal required');
 return a.userId;
};
const safe=(v:bigint)=>{
 if(v>BigInt(Number.MAX_SAFE_INTEGER)||v< -BigInt(Number.MAX_SAFE_INTEGER))
  throw new SimulationTooLarge();
 return Number(v);
};
const cents=(v:unknown,allowZero=false)=>{
 assertCents(v);
 if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>9000000000000||(!allowZero&&v===0))
  throw new RangeError('Invalid simulation amount');
 return v;
};
const ms=(date:string)=>Date.parse(date+'T00:00:00.000Z');
function validate(input:SimulationInput){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Invalid simulation');
 validateDate(input.from);validateDate(input.to);
 const span=(ms(input.to)-ms(input.from))/MS_DAY;
 if(span<0||span>366)throw new TypeError('Simulation horizon must be <= 367 days');
 const what=input.hypothetical??null;
 if(what){
  if(typeof what!=='object'||Array.isArray(what))throw new TypeError('Invalid hypothetical purchase');
  cents(what.amountCents);validateDate(what.purchaseOn);validateDate(what.dueOn);
  if(what.purchaseOn<input.from||what.purchaseOn>input.to||
    what.dueOn<what.purchaseOn||what.dueOn>input.to)
   throw new TypeError('Purchase and due dates must fall in the selected simulation period');
  if(what.intentionId!==undefined&&
    (typeof what.intentionId!=='string'||!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(what.intentionId)))
    throw new TypeError('Invalid intention reference');
 }
 return what;
}
function add(map:Map<string,bigint>,date:string,value:bigint){
 map.set(date,(map.get(date)??0n)+value);
}
function sum(values:bigint[]){return values.reduce((a,v)=>a+v,0n);}
async function boundedRows<T>(db:FinancialDatabase,query:string,params:unknown[]):Promise<T[]>{
 const rows=await db.prepare(query).bind(...(params as (string|number|null)[])).all<T>();
 if(rows.results.length>2000)throw new SimulationTooLarge();
 return rows.results;
}
export async function simulatePlanning(db:FinancialDatabase,actor:AuthenticatedActor,input:SimulationInput):Promise<ScenarioReport>{
 const who=owner(actor),what=validate(input);
 // All four F1 dimensions are taken from the existing financial read model.
 // No posted future movement is replayed: current balance already contains it.
 const [base,obligations,invoices,reserves,calendar]=await Promise.all([
  getPlanningSummary(db,actor),
  boundedRows<DueRow>(db,
   'SELECT due_on,outstanding_cents FROM financial_obligation_balances WHERE owner_user_id=? AND outstanding_cents>0 ORDER BY due_on,obligation_id LIMIT 2001',[who]),
  boundedRows<DueRow>(db,
   'SELECT due_on,outstanding_cents FROM credit_invoice_balances WHERE owner_user_id=? AND outstanding_cents>0 ORDER BY due_on,card_id,invoice_cycle LIMIT 2001',[who]),
  boundedRows<ReserveRow>(db,
   "SELECT intention_id,reserved_cents FROM purchase_intention_balances WHERE owner_user_id=? AND state='reserved' ORDER BY intention_id LIMIT 2001",[who]),
  listCalendar(db,actor,input.from,input.to),
 ]);
 const debtTotal=sum(obligations.map(x=>BigInt(cents(x.outstanding_cents))));
 const cardTotal=sum(invoices.map(x=>BigInt(cents(x.outstanding_cents))));
 const reserveTotal=sum(reserves.map(x=>BigInt(cents(x.reserved_cents))));
 if(debtTotal!==BigInt(base.obligationsCents)||cardTotal!==BigInt(base.cardInvoicesCents)||
   reserveTotal!==BigInt(base.activeReserveCents))
  throw new SimulationConflict('Financial snapshot changed during the simulation');
 let replaced=0n,intentionId:string|null=null;
 if(what?.intentionId){
  const it=await getIntention(db,actor,what.intentionId);
  if(!it)throw new IntentionUnavailable();
  if(it.state==='converted'||it.state==='excluded'||it.amountCents!==what.amountCents)
   throw new SimulationConflict('Selected intention cannot be simulated as a new purchase');
  intentionId=it.intentionId;
  replaced=it.state==='reserved'?BigInt(it.reservedCents):0n;
  // Refuse a partially changed snapshot rather than exaggerate free margin.
  if(replaced!==BigInt(reserves.find(x=>x.intention_id===it.intentionId)?.reserved_cents??0))
   throw new SimulationConflict('Reservation changed during the simulation');
 }
 const due=new Map<string,bigint>(),explicit=new Map<string,bigint>(),release=new Map<string,bigint>();
 for(const row of [...obligations,...invoices]){
  validateDate(row.due_on);
  // Overdue existing debt is allocated at the start, never silently ignored.
  const date=row.due_on<input.from?input.from:row.due_on;
  if(date<=input.to)add(due,date,BigInt(cents(row.outstanding_cents)));
 }
 const unreceivedSources:ProjectedIncome[]=[];
 for(const e of calendar.expectations){
  if(e.state==='canceled'||e.remainingCents===0)continue;
  if(e.currentOn<input.from||e.currentOn>input.to)continue;
  const remaining=BigInt(cents(e.remainingCents));
  add(explicit,e.currentOn,remaining);
  unreceivedSources.push({
   sourceId:e.sourceId,occurrenceKey:e.occurrenceKey,sourceName:e.sourceName,
   date:e.currentOn,state:e.state,remainingCents:safe(remaining),
   cashReceived:'already_in_current_balance_or_not_linked',
  });
 }
 const hypothetical=what?{amountCents:what.amountCents,purchaseOn:what.purchaseOn,dueOn:what.dueOn,
  intentionId,replacedExistingReserveCents:safe(replaced)}:null;
 if(what&&replaced) add(release,what.purchaseOn,replaced);
 const dates=new Set<string>([input.from,input.to,...due.keys(),...explicit.keys(),...release.keys()]);
 if(what){dates.add(what.purchaseOn);dates.add(what.dueOn);}
 const sorted=[...dates].sort();
 let remaining=debtTotal+cardTotal,virtual=reserveTotal,plannedAdded=0n;
 let actualModel=BigInt(base.cashBalanceCents),hypotheticalCommitment=0n;
 let lowestConservativeCash=actualModel,lowestPlannedCash=actualModel;
 let lowestConservativeMargin=actualModel-remaining-virtual,lowestPlannedMargin=actualModel-remaining-virtual;
 const points:ScenarioPoint[]=[];
 for(const date of sorted){
  const payable=due.get(date)??0n,expected=explicit.get(date)??0n,released=release.get(date)??0n;
  // A purchase creates a commitment on purchaseOn, replaces its old reserve
  // immediately, but is paid hypothetically only on the user-entered dueOn.
  const newCommitment=what&&what.purchaseOn===date?BigInt(what.amountCents):0n;
  const hypotheticalPayment=what&&what.dueOn===date?BigInt(what.amountCents):0n;
  actualModel-=payable+hypotheticalPayment;
  remaining-=payable;
  virtual-=released;
  hypotheticalCommitment+=newCommitment-hypotheticalPayment;
  plannedAdded+=expected;
  const plannedCash=actualModel+plannedAdded;
  const conservativeMargin=actualModel-remaining-virtual-hypotheticalCommitment;
  const plannedMargin=plannedCash-remaining-virtual-hypotheticalCommitment;
  lowestConservativeCash=lowestConservativeCash<actualModel?lowestConservativeCash:actualModel;
  lowestPlannedCash=lowestPlannedCash<plannedCash?lowestPlannedCash:plannedCash;
  lowestConservativeMargin=lowestConservativeMargin<conservativeMargin?lowestConservativeMargin:conservativeMargin;
  lowestPlannedMargin=lowestPlannedMargin<plannedMargin?lowestPlannedMargin:plannedMargin;
  points.push({
   date,outstandingPaymentsCents:safe(payable),explicitExpectedIncomeCents:safe(expected),
   releasedReservationCents:safe(released),hypotheticalPaymentCents:safe(hypotheticalPayment),
   hypotheticalCommitmentCents:safe(newCommitment),
   conservativeCashAfterAssumedPaymentsCents:safe(actualModel),
   plannedCashIncludingUnreceivedIncomeCents:safe(plannedCash),
   conservativeFreeMarginCents:safe(conservativeMargin),plannedFreeMarginCents:safe(plannedMargin),
   conservativeCashNegative:actualModel<0n,plannedCashNegative:plannedCash<0n,
   conservativeMarginNegative:conservativeMargin<0n,plannedMarginNegative:plannedMargin<0n,
  });
 }
 // We deliberately do NOT add real (linked) income movements to expected:
 // they're already reflected in the opening current bank balance.
 const last=points.at(-1)!;
 return {
  kind:'ephemeral_read_only',asOfBasis:'current_snapshot_not_historical_balance',
  from:input.from,to:input.to,currency:'BRL',
  openingRealCashCents:base.cashBalanceCents,
  existingOutstandingObligationsCents:safe(debtTotal),
  existingOutstandingCardInvoicesCents:safe(cardTotal),
  activeVirtualReserveCents:safe(reserveTotal),
  hypothetical,
  unreceivedExplicitIncomeCents:safe(sum([...explicit.values()])),unreceivedSources,
  conservative:{basis:'current_cash_and_known_outstanding_only',
   endingCashCents:last.conservativeCashAfterAssumedPaymentsCents,
   endingFreeMarginCents:last.conservativeFreeMarginCents,
   lowestCashCents:safe(lowestConservativeCash),lowestMarginCents:safe(lowestConservativeMargin)},
  planned:{basis:'explicit_unreceived_expectations_not_guaranteed',
   endingCashCents:last.plannedCashIncludingUnreceivedIncomeCents,
   endingFreeMarginCents:last.plannedFreeMarginCents,
   lowestCashCents:safe(lowestPlannedCash),lowestMarginCents:safe(lowestPlannedMargin)},
  points,
  notes:[
   'Opening real cash is current, not a historical balance for the selected start date.',
   'Future bills are assumed paid on their due dates; overdue bills are allocated on the first day. No bank posting occurs.',
   'Confirmed, planned or delayed income expectations are not bank deposits: only unreceived remaining portions appear in the planned scenario.',
   'Active reserves reduce free margin from the start; converting a reserved intention releases that allocation as it creates a hypothetical payable.',
   'Free margin deducts known future liabilities as well as reserved amounts; projected cash and margin are different measures.',
  ],
 };
}
