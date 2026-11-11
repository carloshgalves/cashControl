import { getAccount, listAccounts, type AuthenticatedActor, type FinancialDatabase } from '../accounts/accounts.ts';
import { getDashboard } from '../dashboard/dashboard.ts';
import { readExportTimeline, validateDate, ReportTooLargeError,
  type TimelineEvent, type TimelineKind } from '../timeline/timeline.ts';
import { createXlsx, type SheetCell } from './xlsx.ts';
import { createPdf, type PdfReport } from './pdf.ts';

export type ReportFormat = 'xlsx' | 'pdf';
export interface ReportOptions {
  from:string;to:string;asOf:string;status:string;format:ReportFormat;accountId?:string;
}
export class ReportAccountNotFound extends Error {
  constructor(){super('REPORT_ACCOUNT_NOT_FOUND');}
}
export class ReportReconciliationError extends Error {
  constructor(){super('REPORT_RECONCILIATION_FAILED');}
}
const kinds:Record<TimelineKind,string>={
 income:'Receita',expense:'Despesa',payment:'Pagamento',
 refund:'Reembolso',transfer:'Transferência',obligation:'Obrigação',cancellation:'Cancelamento',
};
const statuses:Record<string,string>={
 realized:'Realizado',planned:'Previsto',pending:'Pendente',
 overdue:'Atrasado',canceled:'Cancelado',
};
const addSafe=(a:number,b:number):number=>{
 if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||!Number.isSafeInteger(a+b)){
  throw new ReportTooLargeError();
 }
 return a+b;
};
export interface ReportTotals {
 incomeCents:number;expensesCents:number;refundsCents:number;
 transfersCents:number;outstandingCents:number;netCents:number;
}
export function totalsOf(events:TimelineEvent[]):ReportTotals {
 const total:ReportTotals={
  incomeCents:0,expensesCents:0,refundsCents:0,
  transfersCents:0,outstandingCents:0,netCents:0,
 };
 for(const e of events){
  if(!Number.isSafeInteger(e.amountCents)||e.amountCents<0)throw new TypeError('Bad money');
  if(e.kind==='income')total.incomeCents=addSafe(total.incomeCents,e.amountCents);
  else if(e.kind==='expense'||e.kind==='payment')total.expensesCents=addSafe(total.expensesCents,e.amountCents);
  else if(e.kind==='refund')total.refundsCents=addSafe(total.refundsCents,e.amountCents);
  else if(e.kind==='transfer')total.transfersCents=addSafe(total.transfersCents,e.amountCents);
  else if(e.kind==='obligation')total.outstandingCents=addSafe(total.outstandingCents,e.amountCents);
  else if(e.kind!=='cancellation')throw new TypeError('Bad event kind');
 }
 total.netCents=addSafe(addSafe(total.incomeCents,-total.expensesCents),total.refundsCents);
 return total;
}
export interface Download {
 bytes:Uint8Array;format:ReportFormat;filename:string;contentType:string;rows:number;
}
const t=(value:string,style=0):SheetCell=>({type:'text',value,style});
const n=(value:number,style=2):SheetCell=>({type:'number',value,style});
export async function makeReport(
 db:FinancialDatabase, actor:AuthenticatedActor, options:ReportOptions,
):Promise<Download> {
 if(!options||typeof options!=='object')throw new TypeError('Report options required');
 validateDate(options.from);validateDate(options.to);validateDate(options.asOf);
 if(options.from>options.to||!['pdf','xlsx'].includes(options.format))throw new TypeError('Invalid report filter');
 let scope='Todas as contas e obrigações';
 if(options.accountId){
  if(!/^[0-9a-f-]{36}$/.test(options.accountId))throw new TypeError('Invalid account identifier');
  const account=await getAccount(db,actor,options.accountId);
  if(!account)throw new ReportAccountNotFound();
  scope='Somente conta: '+account.name+' (obrigações sem conta excluídas)';
 }
 // Single read query, not offset paging; abort rather than return partial history.
 const events=await readExportTimeline(db,actor,options);
 const total=totalsOf(events);
 if(!options.accountId&&options.status==='all'){
  const d=await getDashboard(db,actor,{from:options.from,to:options.to});
  if(total.incomeCents!==d.cashFlow.incomeCents ||
     total.expensesCents!==d.cashFlow.expensesCents ||
     total.refundsCents!==d.cashFlow.refundsCents ||
     total.netCents!==d.cashFlow.netCents ||
     total.outstandingCents!==d.obligations.dueInPeriodCents) {
    // Race between read queries, or an invariant broken by future backend
    // changes. Do not produce a self-contradictory financial document.
    throw new ReportReconciliationError();
  }
 }
 const accounts=await listAccounts(db,actor);
 const names=new Map(accounts.map(a=>[a.accountId,a.name]));
 const humanAccount=(e:TimelineEvent)=>{
  if(e.kind==='transfer'){
   return (names.get(e.accountId??'')??'Conta própria')+' para '+
     (names.get(e.relatedId??'')??'Conta própria');
  }
  return e.accountId?names.get(e.accountId)??'Conta própria':'—';
 };
 const rows=events.map(e=>({
  date:e.date,kind:kinds[e.kind],title:e.title,
  status:statuses[e.status]??'Não classificado',
  account:humanAccount(e),amountCents:e.amountCents,
 }));
 const filename='cashcontrol_'+options.from+'_'+options.to+'.'+options.format;
 const contentType=options.format==='xlsx'
  ?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  :'application/pdf';
 let bytes:Uint8Array;
 if(options.format==='pdf'){
  const report:PdfReport={
   ...options,scope,rows,totals:total,
  };
  try { bytes=createPdf(report); }
  catch(cause){
   if(cause instanceof RangeError && cause.message==='PDF page limit exceeded')throw new ReportTooLargeError();
   throw cause;
  }
 }else{
  const heads=['Data','Tipo','Descrição','Situação','Conta','Valor do evento (BRL)'];
  const sheet:SheetCell[][]=[
   [t('cashControl | Relatório financeiro',1)],
   [t('Período: '+options.from+' a '+options.to)],
   [t('Referência (data civil): '+options.asOf)],
   [t('Escopo: '+scope)],
   [t('Filtro de situação: '+options.status)],
   [t('Eventos confirmados e obrigações pendentes separados; não somar transferências ou obrigações como receita.')],
   heads.map(v=>t(v,1)),
  ];
  for(const e of rows)sheet.push([
   t(e.date),t(e.kind),t(e.title),t(e.status),t(e.account),
   n(e.amountCents/100),
  ]);
  sheet.push([]);
  for(const [label,value] of [
   ['Receitas confirmadas',total.incomeCents],
   ['Saídas confirmadas, incluindo baixas',total.expensesCents],
   ['Reembolsos confirmados',total.refundsCents],
   ['Transferências entre contas (não compõem fluxo)',total.transfersCents],
   ['Obrigações ainda pendentes no período (não debitadas)',total.outstandingCents],
   ['Fluxo líquido efetivo (não é saldo patrimonial)',total.netCents],
  ] as const){
   sheet.push([t(label,1),t(''),t(''),t(''),t(''),n(value/100)]);
  }
  bytes=createXlsx({name:'Histórico financeiro',rows:sheet,columnWidths:[16,17,43,17,40,24]});
 }
 // No persistence, no external files, no access to other user's data.
 return {bytes,filename,format:options.format,contentType,rows:events.length};
}
