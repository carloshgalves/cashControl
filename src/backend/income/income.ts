import type {AuthenticatedActor,FinancialDatabase} from '../accounts/accounts.ts';
import {loadPayrollOverlay,baseForDate} from '../payroll/payroll.ts';
import {assertCents} from '../../domain/money.ts';
import {validateDate} from '../timeline/timeline.ts';
import {getMovement} from '../movements/movements.ts';

export class IncomeNotFound extends Error {}
export class IncomeConflict extends Error {}
export class IncomeTooLarge extends Error {}
export type Relationship='employment'|'public'|'continuous'|'freelance'|'other';
export type PayKind='fixed'|'variable'|'mixed'|'occasional';
export type Periodicity='none'|'weekly'|'fortnightly'|'monthly'|'custom';
export type ExpectedState='planned'|'confirmed'|'delayed'|'canceled';
export interface SourceInput {
 idempotencyKey:string;name:string;relationship:Relationship;payKind:PayKind;
 periodicity:Periodicity;anchorOn?:string|null;endOn?:string|null;intervalDays?:number|null;fixedNetCents?:number|null;
}
export interface Source {
 sourceId:string;name:string;relationship:Relationship;payKind:PayKind;
 periodicity:Periodicity;anchorOn:string|null;endOn:string|null;intervalDays:number|null;fixedNetCents:number|null;
}
export interface Expectation {
 sourceId:string;sourceName:string;occurrenceKey:string;kind:'scheduled'|'manual';
 originalOn:string;currentOn:string;expectedCents:number;receivedCents:number;
 remainingCents:number;differenceCents:number;state:ExpectedState;
}
export interface Calendar {
 from:string;to:string;expectations:Expectation[];
 totals:{expectedCents:number;receivedCents:number;remainingCents:number};
 // Total confirmed money in the financial dashboard is intentionally not here.
 basis:'user_defined_expectations_not_cash';
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9_-]{12,128}$/;
const OCC=/^(?:scheduled_\d{4}-\d{2}-\d{2}|manual_[0-9a-f-]{36})$/;
const MS_DAY=86400000;
function owner(a:AuthenticatedActor){
 if(!a||typeof a.userId!=='string'||!a.userId.trim()||a.userId.length>128)throw new TypeError('Invalid user');
 return a.userId;
}
function id(x:string){if(typeof x!=='string'||!UUID.test(x))throw new TypeError('Invalid ID');return x;}
function key(x:string){if(typeof x!=='string'||!KEY.test(x))throw new TypeError('Invalid idempotency key');return x;}
function occurrence(x:string){if(typeof x!=='string'||!OCC.test(x))throw new TypeError('Invalid expectation key');return x;}
function date(x:string){validateDate(x);return x;}
function text(x:string){if(typeof x!=='string'||!x.trim()||x.trim().length>120||/[\x00-\x1f\x7f]/.test(x))throw new TypeError('Invalid source name');return x.trim();}
function note(x:unknown):string|null{
 if(x===undefined||x===null)return null;
 if(typeof x!=='string'||!x.trim()||x.trim().length>120||/[\x00-\x1f\x7f]/.test(x))throw new TypeError('Invalid reason');
 return x.trim();
}
function amount(x:number,positive=false){assertCents(x);if(positive&&x===0)throw new RangeError('Amount must be positive');return x;}
function safeSum(a:number,b:number){
 if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||!Number.isSafeInteger(a+b))throw new IncomeTooLarge();
 return a+b;
}
function page(limit:number,offset:number){
 if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>100000)throw new TypeError('Invalid pagination');
}
function jsDate(x:string){return new Date(x+'T00:00:00.000Z');}
function ymd(d:Date){return d.toISOString().slice(0,10);}
function plusDays(x:string,n:number){return ymd(new Date(jsDate(x).getTime()+n*MS_DAY));}
function monthDate(anchor:string,index:number){
 const a=jsDate(anchor),day=a.getUTCDate(),month=a.getUTCFullYear()*12+a.getUTCMonth()+index;
 const yr=Math.floor(month/12),m=month%12;
 if(yr>9999)throw new IncomeTooLarge();
 const last=new Date(Date.UTC(yr,m+1,0)).getUTCDate();
 return ymd(new Date(Date.UTC(yr,m,Math.min(day,last))));
}
interface SourceRow{
 source_id:string;display_name:string;relationship_kind:Relationship;pay_kind:PayKind;
 periodicity:Periodicity;anchor_on:string|null;end_on:string|null;interval_days:number|null;
 fixed_net_cents:number|null;creation_key:string;
}
interface ExpectRow{
 source_id:string;occurrence_key:string;original_on:string;current_on:string;
 expected_cents:number;received_cents:number;kind:'scheduled'|'manual';state:ExpectedState;created_at:string;
}
interface EventRow{
 source_id:string;occurrence_key:string;state:Exclude<ExpectedState,'planned'>;expected_on:string;reason:string|null;created_at:string;
}
interface LinkRow {movement_id:string;source_id:string;occurrence_key:string;amount_cents:number;occurred_on:string;description:string}
function asSource(x:SourceRow):Source{
 return {sourceId:x.source_id,name:x.display_name,relationship:x.relationship_kind,payKind:x.pay_kind,
  periodicity:x.periodicity,anchorOn:x.anchor_on,endOn:x.end_on,intervalDays:x.interval_days,fixedNetCents:x.fixed_net_cents};
}
function isRecurrent(s:Source){
 return s.periodicity!=='none'&&s.anchorOn!==null&&s.fixedNetCents!==null&&s.fixedNetCents>0&&
  (s.payKind==='fixed'||s.payKind==='mixed');
}
function generate(s:Source,from:string,to:string):string[]{
 if(!isRecurrent(s))return [];
 const anchor=s.anchorOn!;
 if(anchor>to||s.endOn!==null&&s.endOn<from)return [];
 const end=s.endOn&&s.endOn<to?s.endOn:to;
 const out:string[]=[];
 if(s.periodicity==='monthly'){
  const start=jsDate(from),a=jsDate(anchor);
  let n=Math.max(0,(start.getUTCFullYear()-a.getUTCFullYear())*12+start.getUTCMonth()-a.getUTCMonth()-1);
  const final=jsDate(end);
  const lastIndex=(final.getUTCFullYear()-a.getUTCFullYear())*12+final.getUTCMonth()-a.getUTCMonth();
  for(;n<=lastIndex;n++){
   const next=monthDate(anchor,n);
   if(next>end)break;
   if(next>=from)out.push(next);
   if(out.length>2000)throw new IncomeTooLarge();
  }
 }else{
  const interval=s.periodicity==='weekly'?7:s.periodicity==='fortnightly'?14:s.intervalDays!;
  const start=Math.max(0,Math.floor((jsDate(from).getTime()-jsDate(anchor).getTime())/(interval*MS_DAY)));
  for(let n=start;;n++){
   const t=jsDate(anchor).getTime()+n*interval*MS_DAY;
   if(t>jsDate(end).getTime())break;
   const next=ymd(new Date(t));
   if(next>=from)out.push(next);
   if(out.length>2000)throw new IncomeTooLarge();
  }
 }
 return out;
}
function makeExpectation(s:Source,r:ExpectRow,override?:number):Expectation{
 if(!Number.isSafeInteger(r.received_cents)||r.received_cents<0)throw new IncomeTooLarge();
 const expected=amount(override??r.expected_cents),remaining=Math.max(0,expected-r.received_cents);
 return {sourceId:s.sourceId,sourceName:s.name,occurrenceKey:r.occurrence_key,
  kind:r.kind,originalOn:r.original_on,currentOn:r.current_on,state:r.state,
  expectedCents:expected,receivedCents:r.received_cents,remainingCents:remaining,
  differenceCents:r.received_cents-expected};
}
function verifySource(input:SourceInput){
 if(!input||typeof input!=='object')throw new TypeError('Invalid source');
 key(input.idempotencyKey);
 const name=text(input.name);
 if(!['employment','public','continuous','freelance','other'].includes(input.relationship)||
  !['fixed','variable','mixed','occasional'].includes(input.payKind)||
  !['none','weekly','fortnightly','monthly','custom'].includes(input.periodicity))throw new TypeError('Invalid source type');
 const anchor=input.anchorOn??null,end=input.endOn??null,interval=input.intervalDays??null,fixed=input.fixedNetCents??null;
 if(anchor!==null)date(anchor);
 if(end!==null)date(end);
 if(input.periodicity==='none' ? anchor!==null||end!==null||interval!==null :
  anchor===null||end!==null&&end<anchor)throw new TypeError('Invalid recurrence dates');
 if(input.periodicity==='custom'? !Number.isInteger(interval)||interval!<1||interval!>365:interval!==null)
  throw new TypeError('Invalid recurrence interval');
 if(fixed!==null)amount(fixed);
 if(fixed!==null&&!['fixed','mixed'].includes(input.payKind))throw new TypeError('No fixed component on variable-only source');
 return {name,anchor,end,interval,fixed};
}
async function getSourceRow(db:FinancialDatabase,a:AuthenticatedActor,sourceId:string):Promise<SourceRow>{
 const row=await db.prepare('SELECT * FROM income_sources WHERE owner_user_id=? AND source_id=?')
  .bind(owner(a),id(sourceId)).first<SourceRow>();
 if(!row)throw new IncomeNotFound();
 return row;
}
export async function getSource(db:FinancialDatabase,a:AuthenticatedActor,sourceId:string){
 return asSource(await getSourceRow(db,a,sourceId));
}
export async function listSources(db:FinancialDatabase,a:AuthenticatedActor,limit=50,offset=0){
 page(limit,offset);
 const rows=await db.prepare('SELECT * FROM income_sources WHERE owner_user_id=? ORDER BY created_at DESC,source_id DESC LIMIT ? OFFSET ?')
  .bind(owner(a),limit,offset).all<SourceRow>();
 return rows.results.map(asSource);
}
export async function createSource(db:FinancialDatabase,a:AuthenticatedActor,input:SourceInput,clock=()=>new Date()){
 const who=owner(a),v=verifySource(input);
 const replay=async()=>{
  const r=await db.prepare('SELECT * FROM income_sources WHERE owner_user_id=? AND creation_key=?')
   .bind(who,input.idempotencyKey).first<SourceRow>();
  if(!r)return null;
  if(r.display_name!==v.name||r.relationship_kind!==input.relationship||r.pay_kind!==input.payKind||
   r.periodicity!==input.periodicity||r.anchor_on!==v.anchor||r.end_on!==v.end||
   r.interval_days!==v.interval||r.fixed_net_cents!==v.fixed)throw new IncomeConflict();
  return asSource(r);
 };
 const old=await replay();if(old)return old;
 const sourceId=crypto.randomUUID();
 try{
  await db.prepare('INSERT INTO income_sources(owner_user_id,source_id,creation_key,display_name,relationship_kind,pay_kind,periodicity,anchor_on,end_on,interval_days,fixed_net_cents,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
   .bind(who,sourceId,input.idempotencyKey,v.name,input.relationship,input.payKind,input.periodicity,v.anchor,v.end,v.interval,v.fixed,clock().toISOString()).run();
 }catch(e){const found=await replay();if(found)return found;throw e;}
 return getSource(db,a,sourceId);
}
async function persisted(db:FinancialDatabase,who:string,sourceId:string,occ:string):Promise<ExpectRow|null>{
 return db.prepare('SELECT * FROM income_expectation_totals WHERE owner_user_id=? AND source_id=? AND occurrence_key=?')
  .bind(who,sourceId,occ).first<ExpectRow>();
}
async function currentExpectation(db:FinancialDatabase,who:string,src:Source,occ:string):Promise<Expectation>{
 const row=await persisted(db,who,src.sourceId,occ);
 if(!row)throw new Error('Committed income expectation not readable');
 return makeExpectation(src,row);
}
export async function checkOccurrence(db:FinancialDatabase,a:AuthenticatedActor,sourceId:string,occ:string){
 const s=await getSource(db,a,sourceId);
 occurrence(occ);
 if(occ.startsWith('scheduled_')){
  const d=occ.slice(10);date(d);
  if(generate(s,d,d).length!==1)throw new IncomeNotFound();
  return {s,kind:'scheduled' as const,originalOn:d,amount:s.fixedNetCents!};
 }
 const row=await persisted(db,owner(a),sourceId,occ);
 if(!row||row.kind!=='manual')throw new IncomeNotFound();
 return {s,kind:'manual' as const,originalOn:row.original_on,amount:row.expected_cents};
}
export function ensureRow(db:FinancialDatabase,who:string,sourceId:string,occ:string,day:string,amountCents:number){
 // A statement that inserts zero rows on existing expectations; it is safe
 // under D1 batch serialization and doesn't use REPLACE/IGNORE on history.
 return db.prepare([
  'INSERT INTO income_expectations(owner_user_id,source_id,occurrence_key,creation_key,kind,original_on,expected_cents,created_at)',
  'SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM income_expectations WHERE owner_user_id=? AND source_id=? AND occurrence_key=?)',
 ].join(' ')).bind(who,sourceId,occ,'system:'+sourceId+':'+day,'scheduled',day,amountCents,new Date().toISOString(),who,sourceId,occ);
}
export async function createManualExpectation(db:FinancialDatabase,a:AuthenticatedActor,sourceId:string,input:{
 idempotencyKey:string;expectedOn:string;amountCents:number;
},clock=()=>new Date()){
 const who=owner(a),s=await getSource(db,a,sourceId),k=key(input.idempotencyKey),day=date(input.expectedOn),value=amount(input.amountCents);
 const replay=async()=>{
  const row=await db.prepare('SELECT * FROM income_expectations WHERE owner_user_id=? AND creation_key=?')
   .bind(who,k).first<{source_id:string;occurrence_key:string;original_on:string;expected_cents:number;kind:string}>();
  if(!row)return null;
  if(row.source_id!==s.sourceId||row.original_on!==day||row.expected_cents!==value||row.kind!=='manual')throw new IncomeConflict();
  return row.occurrence_key;
 };
 const old=await replay();if(old)return old;
 const occ='manual_'+crypto.randomUUID();
 try{
  await db.prepare('INSERT INTO income_expectations(owner_user_id,source_id,occurrence_key,creation_key,kind,original_on,expected_cents,created_at) VALUES(?,?,?,?,?,?,?,?)')
   .bind(who,s.sourceId,occ,k,'manual',day,value,clock().toISOString()).run();
 }catch(e){const saved=await replay();if(saved)return saved;throw e;}
 return occ;
}
export async function listCalendar(db:FinancialDatabase,a:AuthenticatedActor,from:string,to:string):Promise<Calendar>{
 const who=owner(a);date(from);date(to);
 const days=(jsDate(to).getTime()-jsDate(from).getTime())/MS_DAY;
 if(days<0||days>366)throw new TypeError('Calendar window must be at most 367 days');
 const all=await db.prepare('SELECT * FROM income_sources WHERE owner_user_id=? ORDER BY source_id LIMIT 501')
  .bind(who).all<SourceRow>();
 if(all.results.length>500)throw new IncomeTooLarge();
 const sources=all.results.map(asSource),byId=new Map(sources.map(s=>[s.sourceId,s]));
 const payroll=await loadPayrollOverlay(db,a,from,to);
 const override=(s:Source,row:ExpectRow):number|undefined=>{
  const statement=payroll.statements.get(s.sourceId+'|'+row.occurrence_key);
  if(statement!==undefined)return statement;
  if(row.kind==='manual')return undefined;
  // Effective salary changes use ORIGINAL competence, not postponed deposit date.
  const versions=payroll.revisions.get(s.sourceId)??[];
  return versions.length?baseForDate(s.fixedNetCents,row.original_on,versions):undefined;
 };
 const rows=await db.prepare(
  'SELECT * FROM income_expectation_totals WHERE owner_user_id=? AND (original_on BETWEEN ? AND ? OR current_on BETWEEN ? AND ?) ORDER BY source_id,original_on,occurrence_key LIMIT 2001'
 ).bind(who,from,to,from,to).all<ExpectRow>();
 if(rows.results.length>2000)throw new IncomeTooLarge();
 const state=new Map<string,ExpectRow>();
 for(const row of rows.results)state.set(row.source_id+'|'+row.occurrence_key,row);
 const result:Expectation[]=[];
 for(const s of sources){
  for(const day of generate(s,from,to)){
   const key='scheduled_'+day,r=state.get(s.sourceId+'|'+key);
   if(r){
    if(r.current_on>=from&&r.current_on<=to)result.push(makeExpectation(s,r,override(s,r)));
   }else{
    const row={source_id:s.sourceId,occurrence_key:key,original_on:day,current_on:day,
     expected_cents:s.fixedNetCents!,received_cents:0,kind:'scheduled' as const,state:'planned' as const,created_at:''};
    result.push(makeExpectation(s,row,override(s,row)));
   }
   if(result.length>2000)throw new IncomeTooLarge();
  }
 }
 for(const row of rows.results){
  const s=byId.get(row.source_id);
  if(!s||row.current_on<from||row.current_on>to)continue;
  if(row.kind==='manual'||row.original_on<from||row.original_on>to)result.push(makeExpectation(s,row,override(s,row)));
  if(result.length>2000)throw new IncomeTooLarge();
 }
 result.sort((x,y)=>x.currentOn.localeCompare(y.currentOn)||x.sourceId.localeCompare(y.sourceId)||x.occurrenceKey.localeCompare(y.occurrenceKey));
 let expected=0,received=0,remaining=0;
 for(const e of result){
  if(e.state!=='canceled'){expected=safeSum(expected,e.expectedCents);remaining=safeSum(remaining,e.remainingCents);}
  received=safeSum(received,e.receivedCents);
 }
 return {from,to,expectations:result,totals:{expectedCents:expected,receivedCents:received,remainingCents:remaining},
  basis:'user_defined_expectations_not_cash'};
}
export async function changeExpectation(db:FinancialDatabase,a:AuthenticatedActor,sourceId:string,occ:string,input:{
 idempotencyKey:string;state:'confirmed'|'delayed'|'canceled';newOn?:string|null;reason?:string|null;
},clock=()=>new Date()){
 const who=owner(a),k=key(input.idempotencyKey);
 const base=await checkOccurrence(db,a,sourceId,occ);
 if(!['confirmed','delayed','canceled'].includes(input.state))throw new TypeError('Invalid expectation status');
 const reason=note(input.reason);
 if(reason!==null&&input.state==='confirmed')throw new TypeError('Confirmation has no reason');
 if(input.state!=='delayed'&&input.newOn!=null)throw new TypeError('Date only for postponement');
 const requestedDelay=input.state==='delayed'?date(input.newOn!):null;
 const replay=async()=>{
  const row=await db.prepare('SELECT * FROM income_expectation_events WHERE owner_user_id=? AND creation_key=?')
   .bind(who,k).first<EventRow&{source_id:string;occurrence_key:string}>();
  if(!row)return false;
  // The persisted operation, not the latest date, determines idempotency:
  // replaying an old confirmation after another postponement must not fail.
  if(row.source_id!==sourceId||row.occurrence_key!==occ||row.state!==input.state||
     row.reason!==reason||(requestedDelay!==null&&row.expected_on!==requestedDelay))throw new IncomeConflict();
  return true;
 };
 if(await replay())return currentExpectation(db,who,base.s,occ);
 const current=await persisted(db,who,sourceId,occ);
 const currentOn=current?.current_on??base.originalOn;
 const next=requestedDelay??currentOn;
 if(input.state==='delayed'&&next<=currentOn)throw new IncomeConflict();
 if(current?.state==='canceled')throw new IncomeConflict();
 try{
  const insert=db.prepare('INSERT INTO income_expectation_events(owner_user_id,source_id,occurrence_key,creation_key,state,expected_on,reason,created_at) VALUES(?,?,?,?,?,?,?,?)')
   .bind(who,sourceId,occ,k,input.state,next,reason,clock().toISOString());
  if(base.kind==='scheduled'&&!current)await db.batch([ensureRow(db,who,sourceId,occ,base.originalOn,base.amount),insert]);
  else await insert.run();
 }catch(e){
  if(!await replay()){
   if(e instanceof Error&&/INCOME_EVENT_INVALID|INCOME_IMMUTABLE|SQLITE_CONSTRAINT|UNIQUE constraint/.test(e.message))throw new IncomeConflict();
   throw e;
  }
 }
 return currentExpectation(db,who,base.s,occ);
}
export async function linkIncomeReceipt(db:FinancialDatabase,a:AuthenticatedActor,sourceId:string,occ:string,input:{
 idempotencyKey:string;movementId:string;
},clock=()=>new Date()){
 const who=owner(a),k=key(input.idempotencyKey),mid=id(input.movementId);
 const base=await checkOccurrence(db,a,sourceId,occ);
 const movement=await getMovement(db,a,mid);
 if(!movement||movement.direction!=='income'||movement.eventKind==='refund')throw new IncomeNotFound();
 const replay=async()=>{
  const row=await db.prepare('SELECT * FROM income_receipt_links WHERE owner_user_id=? AND creation_key=?')
   .bind(who,k).first<{source_id:string;occurrence_key:string;movement_id:string}>();
  if(!row)return false;
  if(row.source_id!==sourceId||row.occurrence_key!==occ||row.movement_id!==mid)throw new IncomeConflict();
  return true;
 };
 if(await replay())return currentExpectation(db,who,base.s,occ);
 const stored=await persisted(db,who,sourceId,occ);
 if(stored?.state==='canceled')throw new IncomeConflict();
 try{
  const insert=db.prepare('INSERT INTO income_receipt_links(owner_user_id,source_id,occurrence_key,movement_id,creation_key,created_at) VALUES(?,?,?,?,?,?)')
   .bind(who,sourceId,occ,mid,k,clock().toISOString());
  if(base.kind==='scheduled'&&!stored)await db.batch([ensureRow(db,who,sourceId,occ,base.originalOn,base.amount),insert]);
  else await insert.run();
 }catch(e){
  if(!await replay()){
   if(e instanceof Error&&/INCOME_RECEIPT_INVALID|INCOME_RECEIPT_TOO_LARGE|INCOME_IMMUTABLE|SQLITE_CONSTRAINT|UNIQUE constraint/.test(e.message))throw new IncomeConflict();
   throw e;
  }
 }
 return currentExpectation(db,who,base.s,occ);
}
export async function listAvailableIncomeMovements(db:FinancialDatabase,a:AuthenticatedActor,limit=50,offset=0){
 const who=owner(a);page(limit,offset);
 const rows=await db.prepare([
  "SELECT m.movement_id,m.amount_cents,m.occurred_on,m.description FROM posted_cash_movements m",
  "WHERE m.owner_user_id=? AND m.direction='income'",
  "AND NOT EXISTS(SELECT 1 FROM income_receipt_links l WHERE l.owner_user_id=m.owner_user_id AND l.movement_id=m.movement_id)",
  "AND NOT EXISTS(SELECT 1 FROM cash_refunds r WHERE r.owner_user_id=m.owner_user_id AND r.refund_movement_id=m.movement_id)",
  "ORDER BY m.occurred_on DESC,m.movement_id DESC LIMIT ? OFFSET ?",
 ].join(' ')).bind(who,limit,offset).all<LinkRow>();
 return rows.results.map(r=>({movementId:r.movement_id,amountCents:r.amount_cents,occurredOn:r.occurred_on,description:r.description}));
}
export async function listExpectationEvents(db:FinancialDatabase,a:AuthenticatedActor,sourceId:string,occ:string,limit=50,offset=0){
 const who=owner(a);page(limit,offset);await checkOccurrence(db,a,sourceId,occ);
 const rows=await db.prepare('SELECT state,expected_on,reason,created_at FROM income_expectation_events WHERE owner_user_id=? AND source_id=? AND occurrence_key=? ORDER BY seq DESC LIMIT ? OFFSET ?')
  .bind(who,sourceId,occ,limit,offset).all<EventRow>();
 return rows.results.map(e=>({state:e.state,newOn:e.expected_on,reason:e.reason,createdAt:e.created_at}));
}
export async function listExpectationReceipts(db:FinancialDatabase,a:AuthenticatedActor,sourceId:string,occ:string,limit=50,offset=0){
 const who=owner(a);page(limit,offset);await checkOccurrence(db,a,sourceId,occ);
 const rows=await db.prepare([
  'SELECT m.movement_id,m.amount_cents,m.occurred_on,m.description FROM income_receipt_links l',
  'JOIN posted_cash_movements m ON m.owner_user_id=l.owner_user_id AND m.movement_id=l.movement_id',
  'WHERE l.owner_user_id=? AND l.source_id=? AND l.occurrence_key=?',
  'ORDER BY m.occurred_on DESC,m.movement_id DESC LIMIT ? OFFSET ?'
 ].join(' ')).bind(who,sourceId,occ,limit,offset).all<LinkRow>();
 return rows.results.map(r=>({movementId:r.movement_id,amountCents:r.amount_cents,occurredOn:r.occurred_on,description:r.description}));
}
