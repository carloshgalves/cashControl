import {assertCents} from '../../domain/money.ts';
import {validateDate} from '../timeline/timeline.ts';
import {getObligation} from '../obligations/obligations.ts';
import type {AuthenticatedActor,FinancialDatabase} from '../accounts/accounts.ts';

export class IntentionUnavailable extends Error {}
export class IntentionConflict extends Error {}
export class PlanningTooLarge extends Error {}
export type IntentionState='planning'|'reserved'|'converted'|'excluded';
export type IntentionAction='reserve'|'plan'|'exclude'|'convert';
export interface IntentionView{
 intentionId:string;title:string;description:string|null;amountCents:number;plannedOn:string;
 state:IntentionState;reservedCents:number;obligationId:string|null;createdAt:string;
}
export interface IntentionEvent{
 eventId:string;intentionId:string;action:IntentionAction;reservedCents:number;
 obligationId:string|null;conversionDueOn:string|null;createdAt:string;
}
export interface IntentionInput{
 idempotencyKey:string;title:string;description?:string|null;amountCents:number;plannedOn:string;
}
export interface TransitionInput{
 idempotencyKey:string;action:IntentionAction;reservedCents?:number;dueOn?:string;
}
export interface PlanningSummary{
 basis:'current_cash_minus_current_commitments_and_active_reserves';
 cashBalanceCents:number;obligationsCents:number;cardInvoicesCents:number;
 activeReserveCents:number;freeMarginCents:number;activeReserveCount:number;
}
const KEY=/^[A-Za-z0-9_-]{12,128}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX=9000000000000;
const who=(a:AuthenticatedActor)=>{
 if(!a||typeof a.userId!=='string'||!a.userId.trim()||a.userId.length>128)
  throw new TypeError('Verified principal required');
 return a.userId;
};
const key=(v:unknown)=>{if(typeof v!=='string'||!KEY.test(v))throw new TypeError('Invalid idempotency key');return v;};
const uuid=(v:unknown)=>{if(typeof v!=='string'||!UUID.test(v))throw new TypeError('Invalid intention ID');return v;};
const caption=(v:unknown,max:number,required:boolean)=>{
 if((v===null||v===undefined)&&!required)return null;
 if(typeof v!=='string'||!v.trim()||v.trim().length>max||/[\u0000-\u001f\u007f]/.test(v))
  throw new TypeError('Invalid text');
 return v.trim();
};
const amount=(v:number,nonzero=true)=>{
 assertCents(v);if(!Number.isSafeInteger(v)||v<0||v>MAX||(nonzero&&v===0))
  throw new RangeError('Invalid amount');
 return v;
};
const paginate=(limit:number,offset:number)=>{
 if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>100000)
  throw new TypeError('Invalid pagination');
};
const safe=(v:bigint)=>{
 if(v>BigInt(Number.MAX_SAFE_INTEGER)||v< -BigInt(Number.MAX_SAFE_INTEGER))
  throw new PlanningTooLarge();
 return Number(v);
};
interface IntentionRow{
 intention_id:string;creation_key:string;title:string;description:string|null;
 amount_cents:number;planned_on:string;created_at:string;state:IntentionState;
 reserved_cents:number;obligation_id:string|null;owner_user_id:string;
}
interface EventRow{
 event_id:string;intention_id:string;creation_key:string;action:IntentionAction;
 reserved_cents:number;obligation_id:string|null;conversion_due_on:string|null;created_at:string;
}
const intent=(v:IntentionRow):IntentionView=>({
 intentionId:v.intention_id,title:v.title,description:v.description,
 amountCents:amount(v.amount_cents),plannedOn:v.planned_on,state:v.state,
 reservedCents:amount(v.reserved_cents,false),obligationId:v.obligation_id,createdAt:v.created_at,
});
const event=(v:EventRow):IntentionEvent=>({
 eventId:v.event_id,intentionId:v.intention_id,action:v.action,
 reservedCents:v.reserved_cents,obligationId:v.obligation_id,conversionDueOn:v.conversion_due_on,createdAt:v.created_at,
});
export async function getIntention(db:FinancialDatabase,actor:AuthenticatedActor,intentionId:string){
 uuid(intentionId);
 const row=await db.prepare('SELECT * FROM purchase_intention_balances WHERE owner_user_id=? AND intention_id=?')
  .bind(who(actor),intentionId).first<IntentionRow>();
 return row?intent(row):null;
}
export async function listIntentions(db:FinancialDatabase,actor:AuthenticatedActor,limit=50,offset=0){
 paginate(limit,offset);
 const rows=await db.prepare('SELECT * FROM purchase_intention_balances WHERE owner_user_id=? ORDER BY created_at DESC,intention_id DESC LIMIT ? OFFSET ?')
  .bind(who(actor),limit,offset).all<IntentionRow>();
 return rows.results.map(intent);
}
export async function listIntentionEvents(db:FinancialDatabase,actor:AuthenticatedActor,intentionId:string,limit=50,offset=0){
 paginate(limit,offset);
 if(!await getIntention(db,actor,intentionId))throw new IntentionUnavailable();
 const rows=await db.prepare('SELECT * FROM purchase_intention_events WHERE owner_user_id=? AND intention_id=? ORDER BY event_seq DESC LIMIT ? OFFSET ?')
  .bind(who(actor),intentionId,limit,offset).all<EventRow>();
 return rows.results.map(event);
}
export async function createIntention(db:FinancialDatabase,actor:AuthenticatedActor,
 input:IntentionInput,clock=()=>new Date()):Promise<IntentionView>{
 const owner=who(actor);if(!input||typeof input!=='object')throw new TypeError('Invalid input');
 const idempotency=key(input.idempotencyKey),title=caption(input.title,120,true)!,
  description=caption(input.description,500,false),total=amount(input.amountCents),
  plannedOn=input.plannedOn;
 validateDate(plannedOn);
 const replay=async()=>{
  const v=await db.prepare('SELECT * FROM purchase_intention_balances WHERE owner_user_id=? AND creation_key=?')
   .bind(owner,idempotency).first<IntentionRow>();
  if(!v)return null;
  if(v.title!==title||v.description!==description||v.amount_cents!==total||v.planned_on!==plannedOn)
   throw new IntentionConflict();
  return intent(v);
 };
 const old=await replay();if(old)return old;
 const intentionId=crypto.randomUUID();
 try{
  await db.prepare('INSERT INTO purchase_intentions(owner_user_id,intention_id,creation_key,title,description,amount_cents,planned_on,created_at) VALUES(?,?,?,?,?,?,?,?)')
   .bind(owner,intentionId,idempotency,title,description,total,plannedOn,clock().toISOString()).run();
 }catch(e){
  const completed=await replay();if(completed)return completed;
  if(e instanceof Error&&/UNIQUE constraint|SQLITE_CONSTRAINT|INTENTION_IMMUTABLE/.test(e.message))throw new IntentionConflict();
  throw e;
 }
 const result=await getIntention(db,actor,intentionId);
 if(!result)throw new Error('Intention creation not readable');
 return result;
}
async function getEventByKey(db:FinancialDatabase,owner:string,idempotency:string){
 return db.prepare('SELECT * FROM purchase_intention_events WHERE owner_user_id=? AND creation_key=?')
  .bind(owner,idempotency).first<EventRow>();
}
export async function transitionIntention(db:FinancialDatabase,actor:AuthenticatedActor,intentionId:string,
 input:TransitionInput,clock=()=>new Date()):Promise<{intention:IntentionView;event:IntentionEvent}>{
 const owner=who(actor),id=uuid(intentionId);
 if(!input||typeof input!=='object'||!['reserve','plan','exclude','convert'].includes(input.action))
  throw new TypeError('Invalid intention action');
 const k=key(input.idempotencyKey),action=input.action;
 const reserved=action==='reserve'?amount(input.reservedCents!):0;
 if(action!=='reserve'&&input.reservedCents!==undefined)throw new TypeError('Unexpected reserve');
 if(action!=='convert'&&input.dueOn!==undefined)throw new TypeError('Unexpected due date');
 const conversionDueOn:string|null=action==='convert'?input.dueOn??null:null;
 if(action==='convert')validateDate(conversionDueOn);
 const replay=async()=>{
  const row=await getEventByKey(db,owner,k);
  if(!row)return null;
  if(row.intention_id!==id||row.action!==action||row.reserved_cents!==reserved||row.conversion_due_on!==conversionDueOn)throw new IntentionConflict();
  const current=await getIntention(db,actor,id);
  if(!current)throw new IntentionUnavailable();
  return {intention:current,event:event(row)};
 };
 const done=await replay();if(done)return done;
 const current=await getIntention(db,actor,id);
 if(!current)throw new IntentionUnavailable();
 if(current.state==='excluded'||current.state==='converted'||action==='plan'&&current.state!=='reserved'||
   action==='reserve'&&(reserved>current.amountCents||current.state==='reserved'&&current.reservedCents===reserved))
  throw new IntentionConflict();
 const now=clock().toISOString(),eventId=crypto.randomUUID();
 const obligationId=action==='convert'?crypto.randomUUID():null;
 const write=db.prepare('INSERT INTO purchase_intention_events(owner_user_id,event_id,creation_key,intention_id,action,reserved_cents,obligation_id,conversion_due_on,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .bind(owner,eventId,k,id,action,reserved,obligationId,conversionDueOn,now);
 try{
  if(action==='convert'){
   // This insert and the event are ONE atomic D1 batch. Event SQL ensures
   // conversion references the intended amount/title and explicit due date.
   await db.batch([
    db.prepare('INSERT INTO financial_obligations(owner_user_id,obligation_id,creation_key,title,category,total_cents,due_on,created_at) VALUES(?,?,?, ?,NULL,?,?,?)')
     .bind(owner,obligationId,'intention-conversion:'+k,current.title,current.amountCents,conversionDueOn,now),
    write,
   ]);
  }else await write.run();
 }catch(e){
  const completed=await replay();if(completed)return completed;
  if(e instanceof Error&&/INTENTION_EVENT_INVALID|UNIQUE constraint|SQLITE_CONSTRAINT/.test(e.message))
   throw new IntentionConflict();
  throw e;
 }
 const result=await replay();if(!result)throw new Error('Intention event not readable');
 if(action==='convert'&&(!result.intention.obligationId||!await getObligation(db,actor,result.intention.obligationId)))
  throw new Error('Atomic conversion missing obligation');
 return result;
}
interface SummaryRow{
 cash_cents:number;obligation_cents:number;card_cents:number;
 reserve_cents:number;reserve_count:number;
}
export async function getPlanningSummary(db:FinancialDatabase,actor:AuthenticatedActor):Promise<PlanningSummary>{
 const row=await db.prepare([
  'SELECT',
  '(SELECT COALESCE(SUM(balance_cents),0) FROM financial_account_balances WHERE owner_user_id=?) AS cash_cents,',
  '(SELECT COALESCE(SUM(outstanding_cents),0) FROM financial_obligation_balances WHERE owner_user_id=?) AS obligation_cents,',
  '(SELECT COALESCE(SUM(outstanding_cents),0) FROM credit_invoice_balances WHERE owner_user_id=?) AS card_cents,',
  "(SELECT COALESCE(SUM(reserved_cents),0) FROM purchase_intention_balances WHERE owner_user_id=? AND state='reserved') AS reserve_cents,",
  "(SELECT COUNT(*) FROM purchase_intention_balances WHERE owner_user_id=? AND state='reserved') AS reserve_count",
 ].join(' ')).bind(...Array(5).fill(who(actor))).first<SummaryRow>();
 if(!row)throw new Error('Planning totals missing');
 const c=safe(BigInt(row.cash_cents)),o=safe(BigInt(row.obligation_cents)),
  card=safe(BigInt(row.card_cents)),reserve=safe(BigInt(row.reserve_cents));
 for(const x of [o,card,reserve])if(x<0||!Number.isSafeInteger(x))throw new PlanningTooLarge();
 if(!Number.isSafeInteger(c))throw new PlanningTooLarge(); // negative real cash is valid
 if(!Number.isSafeInteger(row.reserve_count)||row.reserve_count<0)throw new PlanningTooLarge();
 return {
  basis:'current_cash_minus_current_commitments_and_active_reserves',
  cashBalanceCents:c,obligationsCents:o,cardInvoicesCents:card,
  activeReserveCents:reserve,
  freeMarginCents:safe(BigInt(c)-BigInt(o)-BigInt(card)-BigInt(reserve)),
  activeReserveCount:row.reserve_count,
 };
}
