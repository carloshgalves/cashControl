import type {AuthenticatedActor,FinancialDatabase} from '../accounts/accounts.ts';
import {assertCents} from '../../domain/money.ts';
import {validateDate} from '../timeline/timeline.ts';
import {checkOccurrence,ensureRow,getSource,IncomeNotFound,IncomeConflict} from '../income/income.ts';

const KEY=/^[A-Za-z0-9_-]{12,128}$/;
const MAX=9_000_000_000_000n;
const MAX_SAFE=BigInt(Number.MAX_SAFE_INTEGER);
export class SalaryConflict extends Error {}
export class SalaryNotApplicable extends Error {}
export class SalaryTooLarge extends Error {}
export type PayComponent={kind:'overtime'|'bonus'|'other'|'reduction';reason:string;amountCents:number};
export type PayDeduction={label:string;amountCents:number};
export interface StatementInput {
 idempotencyKey:string;netCents:number;grossCents?:number|null;
 discounts:PayDeduction[];components:PayComponent[];
}
export interface StatementView{
 statementId:number;sourceId:string;occurrenceKey:string;netCents:number;grossCents:number|null;
 discounts:PayDeduction[];components:PayComponent[];discountsTotalCents:number;componentsTotalCents:number;
 grossDifferenceCents:number|null;grossStatus:'not_provided'|'matched'|'pending';
 baseNetCents:number;componentsDifferenceCents:number;
 createdAt:string;source:'user_entered';
}
export interface RevisionView{
 sourceId:string;effectiveOn:string;netCents:number;reason:string;createdAt:string;
}
interface RevisionRow{
 source_id:string;effective_on:string;net_cents:number;reason:string;created_at:string;creation_key:string;
}
interface StatementRow{
 statement_seq:number;owner_user_id:string;source_id:string;occurrence_key:string;creation_key:string;
 net_cents:number;gross_cents:number|null;discounts_json:string;components_json:string;created_at:string;
}
const authorized=(actor:AuthenticatedActor)=>{
 if(!actor||typeof actor.userId!=='string'||!actor.userId.trim()||actor.userId.length>128)
  throw new TypeError('Invalid user');
 return actor.userId;
};
const idem=(v:string)=>{
 if(typeof v!=='string'||!KEY.test(v))throw new TypeError('Invalid idempotency key');
 return v;
};
const date=(v:string)=>{validateDate(v);return v;};
function text(v:unknown,max=120):string{
 if(typeof v!=='string'||!v.trim()||v.trim().length>max||/[\u0000-\u001f\u007f]/.test(v))throw new TypeError('Invalid label');
 return v.trim();
}
function money(v:number,nonzero=false){
 assertCents(v);if(nonzero&&v===0)throw new RangeError('Must be positive');
 return v;
}
function signed(v:number){
 if(!Number.isSafeInteger(v)||v===0||v< -9_000_000_000_000||v>9_000_000_000_000)
  throw new RangeError('Invalid signed component');
 return v;
}
function num(v:bigint):number{
 if(v>MAX_SAFE||v< -MAX_SAFE)throw new SalaryTooLarge();
 return Number(v);
}
function parseItems(input:StatementInput){
 if(!input||typeof input!=='object')throw new TypeError('Invalid statement');
 idem(input.idempotencyKey);
 const net=money(input.netCents),gross=input.grossCents??null;
 if(gross!==null)money(gross);
 if(!Array.isArray(input.discounts)||!Array.isArray(input.components)||
  input.discounts.length>20||input.components.length>20)throw new TypeError('Invalid components');
 const discounts=input.discounts.map(d=>({
  label:text(d?.label,80),amountCents:money(d?.amountCents,true),
 }));
 const components=input.components.map(c=>{
  if(!['overtime','bonus','other','reduction'].includes(c?.kind))throw new TypeError('Unknown component');
  const amount=signed(c?.amountCents);
  if(c.kind==='reduction'?amount>0:amount<0)throw new TypeError('Component sign mismatch');
  return {kind:c.kind,reason:text(c.reason),amountCents:amount};
 });
 if(gross===null&&discounts.length)throw new TypeError('Discounts require gross amount');
 const deductions=num(discounts.reduce((a,d)=>a+BigInt(d.amountCents),0n));
 const extras=num(components.reduce((a,c)=>a+BigInt(c.amountCents),0n));
 if(BigInt(net)>MAX||BigInt(gross??0)>MAX)throw new RangeError('Amount too large');
 return {net,gross,discounts,components,discountsJson:JSON.stringify(discounts),
  componentsJson:JSON.stringify(components),deductions,extras};
}
function ensureSource(s:Awaited<ReturnType<typeof getSource>>){
 if(!['fixed','mixed'].includes(s.payKind))throw new SalaryNotApplicable();
}
function revision(r:RevisionRow):RevisionView{
 return {sourceId:r.source_id,effectiveOn:r.effective_on,netCents:r.net_cents,reason:r.reason,createdAt:r.created_at};
}
export function baseForDate(initial:number|null,dateOn:string,revisions:RevisionView[]):number{
 let value=initial;
 for(const r of revisions){if(r.effectiveOn<=dateOn)value=r.netCents;}
 if(value===null)throw new SalaryNotApplicable();
 return value;
}
export async function listRevisions(db:FinancialDatabase,actor:AuthenticatedActor,sourceId:string,limit=50,offset=0){
 await getSource(db,actor,sourceId);
 if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>100000)throw new TypeError('Invalid pagination');
 const rows=await db.prepare('SELECT * FROM salary_base_revisions WHERE owner_user_id=? AND source_id=? ORDER BY effective_on DESC LIMIT ? OFFSET ?')
  .bind(authorized(actor),sourceId,limit,offset).all<RevisionRow>();
 return rows.results.map(revision);
}
export async function createRevision(db:FinancialDatabase,actor:AuthenticatedActor,sourceId:string,input:{
 idempotencyKey:string;effectiveOn:string;netCents:number;reason:string;
},clock=()=>new Date()):Promise<RevisionView>{
 const s=await getSource(db,actor,sourceId);ensureSource(s);
 const who=authorized(actor),key=idem(input.idempotencyKey),on=date(input.effectiveOn),net=money(input.netCents,true),reason=text(input.reason);
 if(s.fixedNetCents===null||s.fixedNetCents===0||s.periodicity==='none'||!s.anchorOn||
  on<s.anchorOn||s.endOn!==null&&on>s.endOn)throw new SalaryNotApplicable();
 const replay=async()=>{
  const row=await db.prepare('SELECT * FROM salary_base_revisions WHERE owner_user_id=? AND creation_key=?')
   .bind(who,key).first<RevisionRow>();
  if(!row)return null;
  if(row.source_id!==sourceId||row.effective_on!==on||row.net_cents!==net||row.reason!==reason)throw new SalaryConflict();
  return revision(row);
 };
 const original=await replay();if(original)return original;
 try{
  await db.prepare('INSERT INTO salary_base_revisions(owner_user_id,source_id,creation_key,effective_on,net_cents,reason,created_at) VALUES(?,?,?,?,?,?,?)')
   .bind(who,sourceId,key,on,net,reason,clock().toISOString()).run();
 }catch(e){
  const found=await replay();if(found)return found;
  if(e instanceof Error&&/SALARY_REVISION_INVALID|UNIQUE constraint|SQLITE_CONSTRAINT|SALARY_IMMUTABLE/.test(e.message))throw new SalaryConflict();
  throw e;
 }
 return (await replay())!;
}
function view(row:StatementRow,base:number):StatementView{
 const discounts=JSON.parse(row.discounts_json) as PayDeduction[];
 const components=JSON.parse(row.components_json) as PayComponent[];
 const deductions=num(discounts.reduce((a,d)=>a+BigInt(d.amountCents),0n));
 const additions=num(components.reduce((a,d)=>a+BigInt(d.amountCents),0n));
 const grossDifference=row.gross_cents===null?null:num(BigInt(row.gross_cents)-BigInt(deductions)-BigInt(row.net_cents));
 const componentsDifference=num(BigInt(row.net_cents)-BigInt(base)-BigInt(additions));
 return {statementId:row.statement_seq,sourceId:row.source_id,occurrenceKey:row.occurrence_key,
  netCents:row.net_cents,grossCents:row.gross_cents,discounts,components,
  discountsTotalCents:deductions,componentsTotalCents:additions,
  grossDifferenceCents:grossDifference,grossStatus:grossDifference===null?'not_provided':grossDifference===0?'matched':'pending',
  baseNetCents:base,componentsDifferenceCents:componentsDifference,
  createdAt:row.created_at,source:'user_entered'};
}
async function getStatementRow(db:FinancialDatabase,who:string,sourceId:string,occ:string){
 return db.prepare('SELECT * FROM salary_period_statements WHERE owner_user_id=? AND source_id=? AND occurrence_key=? ORDER BY statement_seq DESC LIMIT 1')
  .bind(who,sourceId,occ).first<StatementRow>();
}
async function calculateBase(db:FinancialDatabase,actor:AuthenticatedActor,sourceId:string,day:string):Promise<number>{
 const src=await getSource(db,actor,sourceId);
 const list=await db.prepare('SELECT * FROM salary_base_revisions WHERE owner_user_id=? AND source_id=? AND effective_on<=? ORDER BY effective_on ASC LIMIT 5001')
  .bind(authorized(actor),sourceId,day).all<RevisionRow>();
 if(list.results.length>5000)throw new SalaryTooLarge();
 return baseForDate(src.fixedNetCents,day,list.results.map(revision));
}
export async function getStatement(db:FinancialDatabase,actor:AuthenticatedActor,sourceId:string,occ:string){
 const base=await checkOccurrence(db,actor,sourceId,occ);
 ensureSource(base.s);
 const row=await getStatementRow(db,authorized(actor),sourceId,occ);
 if(!row)return null;
 const amountBase=base.kind==='scheduled'?await calculateBase(db,actor,sourceId,base.originalOn):base.amount;
 return view(row,amountBase);
}
export async function listStatements(db:FinancialDatabase,actor:AuthenticatedActor,sourceId:string,occ:string,limit=25,offset=0){
 const base=await checkOccurrence(db,actor,sourceId,occ);ensureSource(base.s);
 if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>100000)throw new TypeError('Invalid pagination');
 const rows=await db.prepare('SELECT * FROM salary_period_statements WHERE owner_user_id=? AND source_id=? AND occurrence_key=? ORDER BY statement_seq DESC LIMIT ? OFFSET ?')
  .bind(authorized(actor),sourceId,occ,limit,offset).all<StatementRow>();
 const amountBase=base.kind==='scheduled'?await calculateBase(db,actor,sourceId,base.originalOn):base.amount;
 return rows.results.map(r=>view(r,amountBase));
}
export async function createStatement(db:FinancialDatabase,actor:AuthenticatedActor,sourceId:string,occ:string,
 input:StatementInput,clock=()=>new Date()):Promise<StatementView>{
 const base=await checkOccurrence(db,actor,sourceId,occ);ensureSource(base.s);
 const who=authorized(actor),data=parseItems(input);
 const replay=async()=>{
  const row=await db.prepare('SELECT * FROM salary_period_statements WHERE owner_user_id=? AND creation_key=?')
   .bind(who,input.idempotencyKey).first<StatementRow>();
  if(!row)return null;
  if(row.source_id!==sourceId||row.occurrence_key!==occ||row.net_cents!==data.net||row.gross_cents!==data.gross||
   row.discounts_json!==data.discountsJson||row.components_json!==data.componentsJson)throw new SalaryConflict();
  const baseNet=base.kind==='scheduled'?await calculateBase(db,actor,sourceId,base.originalOn):base.amount;
  return view(row,baseNet);
 };
 const old=await replay();if(old)return old;
 // If the occurrence is still virtual, materialize the ORIGINAL E2 salary
 // snapshot atomically with this new statement. The latest salary base is
 // calculated by overlay when reading, without rewriting historical E2 rows.
 const existing=await db.prepare('SELECT state FROM income_expectation_totals WHERE owner_user_id=? AND source_id=? AND occurrence_key=?')
  .bind(who,sourceId,occ).first<{state:string}>();
 if(existing?.state==='canceled')throw new SalaryConflict();
 const insert=db.prepare('INSERT INTO salary_period_statements(owner_user_id,source_id,occurrence_key,creation_key,net_cents,gross_cents,discounts_json,components_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .bind(who,sourceId,occ,input.idempotencyKey,data.net,data.gross,data.discountsJson,data.componentsJson,clock().toISOString());
 try{
  if(base.kind==='scheduled'&&!existing)await db.batch([ensureRow(db,who,sourceId,occ,base.originalOn,base.amount),insert]);
  else await insert.run();
 }catch(e){
  const saved=await replay();if(saved)return saved;
  if(e instanceof Error&&/SALARY_STATEMENT_INVALID|SQLITE_CONSTRAINT|UNIQUE constraint|SALARY_IMMUTABLE/.test(e.message))throw new SalaryConflict();
  throw e;
 }
 return (await replay())!;
}
export interface PayrollOverlay {
 revisions:Map<string,RevisionView[]>;
 statements:Map<string,number>;
}
export async function loadPayrollOverlay(db:FinancialDatabase,actor:AuthenticatedActor,from:string,to:string):Promise<PayrollOverlay>{
 const who=authorized(actor);
 const [rs,ps]=await Promise.all([
  db.prepare('SELECT * FROM salary_base_revisions WHERE owner_user_id=? AND effective_on<=? ORDER BY source_id,effective_on ASC LIMIT 5001')
   .bind(who,to).all<RevisionRow>(),
  db.prepare([
   'SELECT p.* FROM salary_period_statements p JOIN income_expectation_totals e',
   'ON e.owner_user_id=p.owner_user_id AND e.source_id=p.source_id AND e.occurrence_key=p.occurrence_key',
   'WHERE p.owner_user_id=? AND (e.original_on BETWEEN ? AND ? OR e.current_on BETWEEN ? AND ?)',
   'ORDER BY p.statement_seq DESC LIMIT 2001',
  ].join(' ')).bind(who,from,to,from,to).all<StatementRow>(),
 ]);
 if(rs.results.length>5000||ps.results.length>2000)throw new SalaryTooLarge();
 const revisions=new Map<string,RevisionView[]>();
 for(const row of rs.results){
  const v=revisions.get(row.source_id)??[];v.push(revision(row));revisions.set(row.source_id,v);
 }
 const statements=new Map<string,number>();
 for(const row of ps.results){
  const k=row.source_id+'|'+row.occurrence_key;
  if(!statements.has(k))statements.set(k,row.net_cents);
 }
 return {revisions,statements};
}
