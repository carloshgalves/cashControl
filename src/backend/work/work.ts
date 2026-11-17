import type { AuthenticatedActor,FinancialDatabase } from '../accounts/accounts.ts';
import { assertCents } from '../../domain/money.ts';
import { validateDate } from '../timeline/timeline.ts';
import { getMovement } from '../movements/movements.ts';
export class WorkNotFound extends Error {}
export class WorkConflict extends Error {}
type State='planned'|'confirmed'|'realized'|'canceled';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function owner(a:AuthenticatedActor){if(!a||typeof a.userId!=='string'||!a.userId.trim()||a.userId.length>128)throw new TypeError('Invalid actor');return a.userId;}
function id(x:string){if(typeof x!=='string'||!UUID.test(x))throw new TypeError('Invalid ID');return x;}
function key(x:string){if(typeof x!=='string'||!/^[A-Za-z0-9_-]{12,128}$/.test(x))throw new TypeError('Invalid key');return x;}
function label(x:unknown,max=120){if(x===null||x===undefined)return null;if(typeof x!=='string'||!x.trim()||x.trim().length>max||/[\x00-\x1f\x7f]/.test(x))throw new TypeError('Invalid label');return x.trim();}
function date(x:unknown){if(x===null||x===undefined)return null;if(typeof x!=='string')throw new TypeError('Invalid date');validateDate(x);return x;}
function paging(limit:number,offset:number){if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>100000)throw new TypeError('Invalid page');}
interface Row{work_id:string;title:string;client_label:string|null;expected_cents:number|null;planned_on:string|null;due_on:string|null;category:string|null;notes:string|null;created_at:string;state:State;received_cents:number;cost_cents:number}
interface EventRow{seq:number;state:State;reason:string|null;created_at:string;work_id:string}
interface LinkRow{work_id:string;movement_id:string;direction:'income'|'expense';description:string;amount_cents:number;occurred_on:string;refunded_cents:number}
function view(r:Row){
 const received=r.received_cents,cost=r.cost_cents,expected=r.expected_cents;
 if(![received,cost].every(n=>Number.isSafeInteger(n)&&n>=0)||!r.state)throw new RangeError('Invalid work aggregate');
 const remainder=expected===null?null:Math.max(0,expected-received);
 return {workId:r.work_id,title:r.title,client:r.client_label,expectedCents:expected,plannedOn:r.planned_on,dueOn:r.due_on,
 category:r.category,notes:r.notes,createdAt:r.created_at,state:r.state,receivedCents:received,costCents:cost,
 netCents:received-cost,remainingCents:remainder,receiptState:expected===null?'unspecified':received>expected?'above_expected':
 received===expected?'received':received===0?'unreceived':'partial'};
}
export interface NewWork {idempotencyKey:string;title:string;client?:string|null;expectedCents?:number|null;plannedOn?:string|null;dueOn?:string|null;category?:string|null;notes?:string|null}
export async function getWork(db:FinancialDatabase,a:AuthenticatedActor,workId:string){
 const r=await db.prepare('SELECT * FROM work_service_totals WHERE owner_user_id=? AND work_id=?').bind(owner(a),id(workId)).first<Row>();
 if(!r)throw new WorkNotFound();return view(r);
}
export async function listWorks(db:FinancialDatabase,a:AuthenticatedActor,limit=50,offset=0){
 paging(limit,offset);const rows=await db.prepare('SELECT * FROM work_service_totals WHERE owner_user_id=? ORDER BY created_at DESC,work_id DESC LIMIT ? OFFSET ?').bind(owner(a),limit,offset).all<Row>();
 return rows.results.map(view);
}
export async function createWork(db:FinancialDatabase,a:AuthenticatedActor,input:NewWork,clock=()=>new Date()){
 const who=owner(a),k=key(input.idempotencyKey),title=label(input.title),client=label(input.client),category=label(input.category,80),notes=label(input.notes,500);
 if(!title)throw new TypeError('Title required');
 const expected=input.expectedCents??null;if(expected!==null)assertCents(expected);
 const planned=date(input.plannedOn),due=date(input.dueOn);
 const replay=async()=>{const row=await db.prepare('SELECT * FROM work_service_totals WHERE owner_user_id=? AND creation_key=?').bind(who,k).first<Row>();
 if(!row)return null;
 if(row.title!==title||row.client_label!==client||row.expected_cents!==expected||row.planned_on!==planned||row.due_on!==due||row.category!==category||row.notes!==notes)throw new WorkConflict();
 return view(row);};
 const old=await replay();if(old)return old;
 const workId=crypto.randomUUID(),now=clock().toISOString();
 try{await db.batch([
 db.prepare('INSERT INTO work_services(owner_user_id,work_id,creation_key,title,client_label,expected_cents,planned_on,due_on,category,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(who,workId,k,title,client,expected,planned,due,category,notes,now),
 db.prepare("INSERT INTO work_state_events(owner_user_id,work_id,creation_key,state,created_at) VALUES(?,?,?,'planned',?)").bind(who,workId,'initial:'+k,now)
 ]);}catch(e){const found=await replay();if(found)return found;throw e;}
 return getWork(db,a,workId);
}
export async function changeWorkState(db:FinancialDatabase,a:AuthenticatedActor,workId:string,input:{idempotencyKey:string;state:State;reason?:string|null},clock=()=>new Date()){
 const who=owner(a),wid=id(workId),k=key(input.idempotencyKey),reason=label(input.reason);
 if(!['confirmed','realized','canceled'].includes(input.state)|| (reason!==null&&input.state!=='canceled'))throw new TypeError('Invalid state');
 await getWork(db,a,wid);
 const replay=async()=>{const row=await db.prepare('SELECT * FROM work_state_events WHERE owner_user_id=? AND creation_key=?').bind(who,k).first<EventRow>();if(!row)return false;if(row.work_id!==wid||row.state!==input.state||row.reason!==reason)throw new WorkConflict();return true;};
 if(await replay())return getWork(db,a,wid);
 try{await db.prepare('INSERT INTO work_state_events(owner_user_id,work_id,creation_key,state,reason,created_at) VALUES(?,?,?,?,?,?)').bind(who,wid,k,input.state,reason,clock().toISOString()).run();}
 catch(e){if(!await replay()){if(e instanceof Error&&e.message.includes('WORK_STATE_INVALID'))throw new WorkConflict();throw e;}}
 return getWork(db,a,wid);
}
export async function linkWorkMovement(db:FinancialDatabase,a:AuthenticatedActor,workId:string,input:{idempotencyKey:string;movementId:string},clock=()=>new Date()){
 const who=owner(a),wid=id(workId),mid=id(input.movementId),k=key(input.idempotencyKey);
 await getWork(db,a,wid);
 const movement=await getMovement(db,a,mid);if(!movement)throw new WorkNotFound();
 const replay=async()=>{const row=await db.prepare('SELECT work_id,movement_id FROM work_movement_links WHERE owner_user_id=? AND creation_key=?').bind(who,k).first<{work_id:string;movement_id:string}>();if(!row)return false;if(row.work_id!==wid||row.movement_id!==mid)throw new WorkConflict();return true;};
 if(await replay())return getWork(db,a,wid);
 try{await db.prepare('INSERT INTO work_movement_links(owner_user_id,work_id,movement_id,creation_key,created_at) VALUES(?,?,?,?,?)').bind(who,wid,mid,k,clock().toISOString()).run();}
 catch(e){if(!await replay())throw new WorkConflict();}
 return getWork(db,a,wid);
}
export async function getWorkHistory(db:FinancialDatabase,a:AuthenticatedActor,workId:string,limit=50,offset=0){
 const who=owner(a);paging(limit,offset);await getWork(db,a,workId);
 const rows=await db.prepare('SELECT * FROM work_state_events WHERE owner_user_id=? AND work_id=? ORDER BY seq DESC LIMIT ? OFFSET ?').bind(who,workId,limit,offset).all<EventRow>();
 return rows.results.map(r=>({sequence:r.seq,state:r.state,reason:r.reason,createdAt:r.created_at}));
}
export async function getWorkMovements(db:FinancialDatabase,a:AuthenticatedActor,workId:string,limit=50,offset=0){
 const who=owner(a);paging(limit,offset);await getWork(db,a,workId);
 const rows=await db.prepare('SELECT l.work_id,m.movement_id,m.direction,m.description,m.amount_cents,m.occurred_on,COALESCE((SELECT SUM(r.amount_cents) FROM cash_refunds r WHERE r.owner_user_id=m.owner_user_id AND r.original_movement_id=m.movement_id),0) AS refunded_cents FROM work_movement_links l JOIN posted_cash_movements m ON m.owner_user_id=l.owner_user_id AND m.movement_id=l.movement_id WHERE l.owner_user_id=? AND l.work_id=? ORDER BY m.occurred_on DESC,m.movement_id DESC LIMIT ? OFFSET ?').bind(who,workId,limit,offset).all<LinkRow>();
 return rows.results.map(r=>({movementId:r.movement_id,direction:r.direction,description:r.description,amountCents:r.amount_cents,occurredOn:r.occurred_on,refundedCents:r.refunded_cents}));
}
