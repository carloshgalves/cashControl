import {validateDate} from '../timeline/timeline.ts';
import {getSource,IncomeNotFound,listCalendar} from '../income/income.ts';
import type {AuthenticatedActor,FinancialDatabase} from '../accounts/accounts.ts';

/** F3 exploratory, explicit opt-in, READ-ONLY. Never credits cash or replaces F2. */
export class PotentialTooLarge extends Error {}
export class PotentialNotApplicable extends Error {}
export interface PotentialInput{
 sourceId:string;asOf:string;from:string;to:string;include:boolean;
}
export interface PotentialWeek{
 from:string;to:string;historicalReceiptsCents?:number;
 explicitExpectedCents:number;potentialAdditionalCents:number;
}
export interface PotentialReport{
 basis:'historical_linked_actual_income_not_bank_cash';
 status:'disabled'|'insufficient'|'estimated';
 currency:'BRL';sourceId:string|null;asOf:string;from:string;to:string;
 method:{weeks:number;percentile:'nearest_rank_p25';minPositiveWeeks:number;projectionMaxWeeks:number};
 observedWeeks:number;positiveWeeks:number;zeroWeeks:number;canceledExpectations:number;
 historyFrom:string|null;historyTo:string|null;observedWeeklyCents:number[];
 p25WeeklyCents:number;potentialAdditionalCents:number;weekly:PotentialWeek[];
 notes:string[];
}
const MS=86400000,RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const owner=(a:AuthenticatedActor)=>{if(!a||typeof a.userId!=='string'||!a.userId.trim()||a.userId.length>128)throw new TypeError('Verified owner required');return a.userId;};
const stamp=(d:string)=>Date.parse(d+'T00:00:00.000Z');
const civil=(n:number)=>new Date(n).toISOString().slice(0,10);
function add(a:number,b:number):number{const n=a+b;if(!Number.isSafeInteger(n))throw new PotentialTooLarge();return n;}
const weekStart=(date:string):number=>{const t=stamp(date),day=new Date(t).getUTCDay();return t-((day+6)%7)*MS;};
const notes=[
 'Histórico de recebimentos efetivos vinculados à fonte selecionada; valores cancelados não são recebimentos.',
 'Semanas sem lançamentos contam como zero; histórico insuficiente não gera números previstos.',
 'Estimativa é exploratória, não garantida; valores potenciais nunca entram no saldo bancário ou no cenário conservador.',
 'Previsões explícitas da mesma fonte e semana são deduzidas da faixa potencial para evitar dupla contagem.',
 'Recebimentos sem vínculo de origem, juros, impostos e custos externos não são inferidos; confira os vínculos no módulo Rendas.',
];
interface MoveRow{occurred_on:string;amount_cents:number}
interface Count{n:number}
export async function estimatePotential(db:FinancialDatabase,a:AuthenticatedActor,v:PotentialInput,
 clock:()=>Date=()=>new Date()):Promise<PotentialReport>{
 const who=owner(a);
 if(!v||typeof v!=='object'||typeof v.include!=='boolean'||typeof v.sourceId!=='string'||
   (v.include&&!RE.test(v.sourceId)))throw new TypeError('Invalid potential request');
 validateDate(v.asOf);validateDate(v.from);validateDate(v.to);
 const today=clock().toISOString().slice(0,10);
 if(v.from>v.to||v.asOf>today||v.from<v.asOf||stamp(v.to)-stamp(v.from)>13*7*MS)
   throw new TypeError('Potential range outside allowed civil horizon');
 const common={
  basis:'historical_linked_actual_income_not_bank_cash' as const,currency:'BRL' as const,
  sourceId:v.include?v.sourceId:null,asOf:v.asOf,from:v.from,to:v.to,
  method:{weeks:12,percentile:'nearest_rank_p25' as const,minPositiveWeeks:4,projectionMaxWeeks:13},
 };
 const off=():PotentialReport=>({...common,status:'disabled',observedWeeks:0,positiveWeeks:0,zeroWeeks:0,
  canceledExpectations:0,historyFrom:null,historyTo:null,observedWeeklyCents:[],
  p25WeeklyCents:0,potentialAdditionalCents:0,weekly:[],notes:[notes[2]!,'Seleção opcional desativada.']});
 if(!v.include)return off();
 let src;
 try{src=await getSource(db,a,v.sourceId);}catch(e){if(e instanceof IncomeNotFound)throw new PotentialNotApplicable();throw e;}
 // Mixed sources include unknown fixed salary portions. Without an explicit
 // split it is unsafe to convert those into hypothetical extra-income trends.
 if(!['variable','occasional'].includes(src.payKind))throw new PotentialNotApplicable();
 const endWeek=weekStart(v.asOf)-MS;
 const startWeek=endWeek-83*MS;
 const historyFrom=civil(startWeek),historyTo=civil(endWeek);
 const rows=await db.prepare([
  'SELECT m.occurred_on,m.amount_cents FROM income_receipt_links l',
  'JOIN posted_cash_movements m ON m.owner_user_id=l.owner_user_id AND m.movement_id=l.movement_id',
  'WHERE l.owner_user_id=? AND l.source_id=? AND m.direction=\'income\'',
  'AND m.occurred_on BETWEEN ? AND ?',
  'AND NOT EXISTS(SELECT 1 FROM cash_refunds r WHERE r.owner_user_id=m.owner_user_id AND r.refund_movement_id=m.movement_id)',
  'ORDER BY m.occurred_on,m.movement_id LIMIT 2001',
 ].join(' ')).bind(who,v.sourceId,historyFrom,historyTo).all<MoveRow>();
 if(rows.results.length>2000)throw new PotentialTooLarge();
 const weekly=Array<number>(12).fill(0);
 for(const row of rows.results){
  if(!Number.isSafeInteger(row.amount_cents)||row.amount_cents<1)throw new PotentialTooLarge();
  validateDate(row.occurred_on);
  const i=Math.floor((weekStart(row.occurred_on)-startWeek)/(7*MS));
  if(i<0||i>=12)throw new Error('Historical week out of bounds');
  weekly[i]=add(weekly[i]!,row.amount_cents);
 }
 const canceled=await db.prepare([
  'SELECT COUNT(*) AS n FROM income_expectation_totals e',
  'WHERE e.owner_user_id=? AND e.source_id=? AND e.state=\'canceled\'',
  'AND e.original_on BETWEEN ? AND ?',
 ].join(' ')).bind(who,v.sourceId,historyFrom,historyTo).first<Count>();
 if(!canceled||!Number.isSafeInteger(canceled.n)||canceled.n<0)throw new PotentialTooLarge();
 const positiveWeeks=weekly.filter(x=>x>0).length,zeroWeeks=12-positiveWeeks;
 const sorted=[...weekly].sort((x,y)=>x-y);
 const p25=sorted[2]!;
 const historicalEligible=positiveWeeks>=4&&weekly.slice(0,4).some(x=>x>0);
 const weeks:PotentialWeek[]=[];
 const cal=await listCalendar(db,a,v.from,v.to);
 const explicit=new Map<number,number>();
 for(const e of cal.expectations){
  if(e.sourceId!==v.sourceId||e.state==='canceled'||e.remainingCents<=0)continue;
  if(!Number.isSafeInteger(e.remainingCents))throw new PotentialTooLarge();
  const week=weekStart(e.currentOn);
  explicit.set(week,add(explicit.get(week)??0,e.remainingCents));
 }
 const firstWeek=weekStart(v.from)+(weekStart(v.from)===stamp(v.from)?0:7*MS);
 let total=0;
 for(let w=firstWeek;w+6*MS<=stamp(v.to);w+=7*MS){
  const known=explicit.get(w)??0;
  const extra=historicalEligible?Math.max(0,p25-known):0;
  total=add(total,extra);
  weeks.push({from:civil(w),to:civil(w+6*MS),explicitExpectedCents:known,potentialAdditionalCents:extra});
 }
 if(weeks.length>13)throw new PotentialTooLarge();
 return {...common,status:historicalEligible?'estimated':'insufficient',
  observedWeeks:12,positiveWeeks,zeroWeeks,canceledExpectations:canceled.n,historyFrom,historyTo,
  observedWeeklyCents:weekly,p25WeeklyCents:historicalEligible?p25:0,
  potentialAdditionalCents:total,weekly:weeks,
  notes:[...notes,
   'Regra experimental versionada: 12 semanas completas anteriores à data de referência, 4 semanas positivas mínimas, uma na primeira janela de 4, 25º percentil por nearest rank.',
   ...(historicalEligible?[]:['Sem histórico suficiente: estimativa numérica deliberadamente zerada.']),
   ...(weeks.length===0?['O período pedido não contém nenhuma semana completa; nenhuma extrapolação parcial foi calculada.']:[]),
  ]};
}
