import {estimatePotential,PotentialNotApplicable,PotentialTooLarge} from '../planning/historical-potential.ts';
import {createRenegotiation,getRenegotiation,listRenegotiations,payRenegotiation,listRenegotiationPayments,DebtRenegotiationUnavailable,DebtRenegotiationConflict,DebtRenegotiationTooLarge,type DebtSubject} from '../renegotiations/renegotiations.ts';
import {grantLoan,getLoan,listLoans,receiveLoanRepayment,listLoanRepayments,LoanConflict,LoanUnavailable} from '../loans/loans.ts';
import {simulatePlanning,SimulationConflict,SimulationTooLarge} from '../planning/scenarios.ts';
import {createIntention,getIntention,listIntentions,listIntentionEvents,transitionIntention,getPlanningSummary,IntentionUnavailable,IntentionConflict,PlanningTooLarge} from '../planning/intentions.ts';
import {confirmSalaryWithholding,listSalaryWithholdings,listObligationWithholdings,WithholdingConflict,WithholdingNotFound,WithholdingNotApplicable} from '../payroll/withholdings.ts';
import {createRevision,listRevisions,createStatement,getStatement,listStatements,SalaryConflict,SalaryNotApplicable,SalaryTooLarge} from '../payroll/payroll.ts';
import {createSource,getSource,listSources,createManualExpectation,listCalendar,changeExpectation,linkIncomeReceipt,listAvailableIncomeMovements,listExpectationEvents,listExpectationReceipts,IncomeNotFound,IncomeConflict,IncomeTooLarge} from '../income/income.ts';
import { createWork,listWorks,getWork,changeWorkState,linkWorkMovement,getWorkHistory,getWorkMovements,availableWorkMovements,WorkNotFound,WorkConflict } from '../work/work.ts';
import { createAccount, getAccount, listAccounts, type AuthenticatedActor, type FinancialDatabase } from '../accounts/accounts.ts';
import { parseCents } from '../../domain/money.ts';
import { getMovement, listMovements, postMovement } from '../movements/movements.ts';
import { createObligation, getObligation, listObligations, listObligationPayments, payObligation } from '../obligations/obligations.ts';
import { createInternalTransfer, getInternalTransfer, listInternalTransfers } from '../transfers/transfers.ts';
import { cancelUnpaidObligation, getExpenseRefund, listExpenseRefunds, refundPaidExpense } from '../compensations/compensations.ts';
import { getDashboard } from '../dashboard/dashboard.ts';
import { listTimeline, listDueAlerts } from '../timeline/timeline.ts';
import { makeReport, ReportAccountNotFound, ReportReconciliationError } from '../reports/report.ts';
import { ReportTooLargeError } from '../timeline/timeline.ts';
import { createCard, listCards, getCard, createPurchase, listPurchases, getPurchase,
 getPurchaseInstallments, listInvoices, getInvoice,
 CreditCardUnavailable, CreditPurchaseUnavailable, CreditIdempotencyConflict,
 CreditResultTooLarge } from '../cards/cards.ts';
import { payInvoice, listInvoicePayments, CreditInvoiceUnavailable,
 CreditInvoiceInsufficient } from '../cards/invoice-payments.ts';
import { readInvoiceReconciliation,recordInvoiceBankTotal,parseReportedInvoiceCents } from '../cards/reconciliation.ts';

/** Session shape returned by the independently verified Better Auth server call. */
export type VerifiedSession = {
  user: { id: string };
  session: { userId: string; expiresAt: Date | string | number };
};
export type SessionLookup = (headers: Headers) => Promise<VerifiedSession | null>;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});
const error = (status: number, code: string) => json({ error: code }, status);

/**
 * Security boundary for API routes: identity is only derived from Better Auth's
 * database-verified session lookup. Headers like x-user-id and JSON ownerId are
 * deliberately ignored. We do NOT accept user identifiers as function inputs.
 */
export async function handleFinancialHttp(
  request: Request,
  database: FinancialDatabase,
  lookupSession: SessionLookup,
  configuredOrigin: string,
  clock: () => number = () => Date.now(),
): Promise<Response> {
  const requestURL = new URL(request.url);
  let expectedOrigin: string;
  try {
    const baseURL = new URL(configuredOrigin);
    if (!['https:', 'http:'].includes(baseURL.protocol) || baseURL.username || baseURL.password || baseURL.pathname !== '/' || baseURL.search || baseURL.hash) {
      return error(503, 'AUTH_NOT_CONFIGURED');
    }
    expectedOrigin = baseURL.origin;
  } catch { return error(503, 'AUTH_NOT_CONFIGURED'); }
  // Reject unexpected hosts even behind a proxy; the configured canonical URL
  // comes from the Worker secret/binding, NEVER client-supplied forwarded headers.
  if (requestURL.origin !== expectedOrigin) return error(403, 'FORBIDDEN_ORIGIN');

  const method = request.method.toUpperCase();
  if (!['GET','POST'].includes(method)) return error(405, 'METHOD_NOT_ALLOWED');
  if (method === 'POST' && request.headers.get('origin') !== expectedOrigin) return error(403, 'FORBIDDEN_ORIGIN');
  if (!request.headers.get('cookie')) return error(401, 'UNAUTHORIZED');

  let session: VerifiedSession | null;
  try { session = await lookupSession(request.headers); }
  catch { return error(401, 'UNAUTHORIZED'); }
  if (!session?.user || typeof session.user.id !== 'string' || !session.user.id.trim() ||
      session.user.id.length > 128 || session.session?.userId !== session.user.id) return error(401, 'UNAUTHORIZED');
  const expiry = new Date(session.session.expiresAt).getTime();
  if (!Number.isFinite(expiry) || expiry <= clock()) return error(401, 'UNAUTHORIZED');
  // Construct actor only after the backend session has been verified.
  const actor: AuthenticatedActor = { userId: session.user.id };

  try {
    const path = requestURL.pathname;
    if (method === 'GET' && path === '/api/reports/export') {
      const query=requestURL.searchParams;
      const allowed=new Set(['format','from','to','asOf','status','accountId']);
      let bad=false;
      query.forEach((_value,key)=>{
        if(!allowed.has(key)||query.getAll(key).length!==1)bad=true;
      });
      if(bad)return error(400,'INVALID_FILTER');
      const format=query.get('format'),from=query.get('from'),
        to=query.get('to'),asOf=query.get('asOf'),status=query.get('status')??'all';
      if(!format||!from||!to||!asOf||(format!=='pdf'&&format!=='xlsx')){
        return error(400,'INVALID_REPORT');
      }
      const download=await makeReport(database,actor,{
        format,from,to,asOf,status,accountId:query.get('accountId')??undefined,
      });
      return new Response(download.bytes as BodyInit,{
        status:200,headers:{
          'content-type':download.contentType,
          'content-disposition':'attachment; filename="'+download.filename+'"',
          'cache-control':'private, no-store, max-age=0',
          'pragma':'no-cache',
          'x-content-type-options':'nosniff',
          'x-robots-tag':'noindex, nofollow',
          'content-security-policy':"default-src 'none'; sandbox",
        },
      });
    }
    if (method === 'GET' && (path === '/api/timeline' || path === '/api/alerts')) {
      const query = requestURL.searchParams;
      const allowed = path === '/api/timeline'
        ? new Set(['from', 'to', 'asOf', 'status', 'limit', 'offset'])
        : new Set(['asOf', 'limit', 'offset']);
      let unknown = false;
      query.forEach((_value, name) => {
        if (!allowed.has(name) || query.getAll(name).length > 1) unknown = true;
      });
      if (unknown) return error(400, 'INVALID_FILTER');
      const asOf = query.get('asOf');
      if (!asOf) return error(400, 'INVALID_PERIOD');
      const number = (name: string, fallback: number) => {
        const raw = query.get(name);
        if (raw === null) return fallback;
        if (!/^(?:0|[1-9]\d{0,6})$/.test(raw)) throw new TypeError('Invalid pagination');
        return Number(raw);
      };
      if (path === '/api/alerts') {
        return json(await listDueAlerts(database, actor, {
          asOf, limit: number('limit', 20), offset: number('offset', 0),
        }));
      }
      const from = query.get('from'), to = query.get('to');
      if (!from || !to) return error(400, 'INVALID_PERIOD');
      return json(await listTimeline(database, actor, {
        from, to, asOf, status: query.get('status') ?? 'all',
        limit: number('limit', 30), offset: number('offset', 0),
      }));
    }
    if (method === 'GET' && path === '/api/dashboard') {
      // Never silently ignore unsupported filters: a caller could otherwise
      // mistake an all-account total for a per-account or per-category total.
      let unsupportedFilter = false;
      requestURL.searchParams.forEach((_value, name) => {
        if (name !== 'from' && name !== 'to') unsupportedFilter = true;
      });
      if (unsupportedFilter) return error(400, 'INVALID_FILTER');
      const from = requestURL.searchParams.get('from');
      const to = requestURL.searchParams.get('to');
      if (from === null || to === null ||
          requestURL.searchParams.getAll('from').length !== 1 ||
          requestURL.searchParams.getAll('to').length !== 1) {
        return error(400, 'INVALID_PERIOD');
      }
      return json({ dashboard: await getDashboard(database, actor, { from, to }) });
    }
    if (method === 'GET' && path === '/api/refunds') {
      const query = requestURL.searchParams;
      const page = (name: string, fallback: number): number => {
        const raw = query.get(name);
        if (raw === null) return fallback;
        if (!/^(?:0|[1-9]\d{0,6})$/.test(raw)) throw new TypeError('Invalid pagination');
        return Number(raw);
      };
      return json({ refunds: await listExpenseRefunds(database, actor, {
        originalMovementId: query.get('originalMovementId') ?? undefined,
        limit: page('limit', 50), offset: page('offset', 0),
      }) });
    }
    if (method === 'GET' && /^\/api\/refunds\/[0-9a-f-]{36}$/.test(path)) {
      const refund = await getExpenseRefund(database, actor, path.slice('/api/refunds/'.length));
      return refund ? json({ refund }) : error(404, 'NOT_FOUND');
    }
    if (method === 'POST' && path === '/api/refunds') {
      if (!request.body) return error(400, 'INVALID_BODY');
      const bytes = await readBounded(request, 4096);
      if (bytes === null) return error(413, 'PAYLOAD_TOO_LARGE');
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { return error(400, 'INVALID_JSON'); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return error(400, 'INVALID_BODY');
      const value = raw as Record<string, unknown>;
      if (typeof value.idempotencyKey !== 'string' ||
          typeof value.originalMovementId !== 'string' || typeof value.accountId !== 'string' ||
          typeof value.amount !== 'string' || typeof value.refundedOn !== 'string' ||
          (value.method !== 'cash' && value.method !== 'pix' &&
           value.method !== 'debit' && value.method !== 'bank_transfer') ||
          (value.reason !== undefined && value.reason !== null && typeof value.reason !== 'string')) {
        return error(400, 'INVALID_BODY');
      }
      let amount;
      try { amount = parseCents(value.amount); }
      catch { return error(400, 'INVALID_AMOUNT'); }
      const refund = await refundPaidExpense(database, actor, {
        idempotencyKey: value.idempotencyKey,
        originalMovementId: value.originalMovementId,
        accountId: value.accountId, amountCents: amount, method: value.method,
        refundedOn: value.refundedOn, reason: value.reason as string | null | undefined,
      });
      return json({ refund }, 201);
    }
    const cancellationPath = path.match(/^\/api\/obligations\/([0-9a-f-]{36})\/cancel$/);
    if (method === 'POST' && cancellationPath) {
      if (!request.body) return error(400, 'INVALID_BODY');
      const bytes = await readBounded(request, 4096);
      if (bytes === null) return error(413, 'PAYLOAD_TOO_LARGE');
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { return error(400, 'INVALID_JSON'); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return error(400, 'INVALID_BODY');
      const value = raw as Record<string, unknown>;
      if (typeof value.idempotencyKey !== 'string' ||
          typeof value.canceledOn !== 'string' ||
          (value.reason !== undefined && value.reason !== null && typeof value.reason !== 'string')) {
        return error(400, 'INVALID_BODY');
      }
      const cancellation = await cancelUnpaidObligation(database, actor, {
        obligationId: cancellationPath[1]!,
        idempotencyKey: value.idempotencyKey,
        canceledOn: value.canceledOn,
        reason: value.reason as string | null | undefined,
      });
      return json({ cancellation }, 201);
    }
    if (method === 'GET' && path === '/api/transfers') {
      const query = requestURL.searchParams;
      const parsePage = (name: string, fallback: number): number => {
        const value = query.get(name);
        if (value === null) return fallback;
        if (!/^(?:0|[1-9]\d{0,6})$/.test(value)) throw new TypeError('Invalid pagination');
        return Number(value);
      };
      return json({ transfers: await listInternalTransfers(database, actor, {
        accountId: query.get('accountId') ?? undefined,
        limit: parsePage('limit', 50),
        offset: parsePage('offset', 0),
      }) });
    }
    if (method === 'GET' && /^\/api\/transfers\/[0-9a-f-]{36}$/.test(path)) {
      const transfer = await getInternalTransfer(database, actor, path.slice('/api/transfers/'.length));
      return transfer ? json({ transfer }) : error(404, 'NOT_FOUND');
    }
    if (method === 'POST' && path === '/api/transfers') {
      if (!request.body) return error(400, 'INVALID_BODY');
      const bytes = await readBounded(request, 4096);
      if (bytes === null) return error(413, 'PAYLOAD_TOO_LARGE');
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { return error(400, 'INVALID_JSON'); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return error(400, 'INVALID_BODY');
      const value = raw as Record<string, unknown>;
      if (typeof value.idempotencyKey !== 'string' ||
          typeof value.sourceAccountId !== 'string' || typeof value.targetAccountId !== 'string' ||
          typeof value.amount !== 'string' || typeof value.transferredOn !== 'string' ||
          (value.note !== undefined && value.note !== null && typeof value.note !== 'string')) {
        return error(400, 'INVALID_BODY');
      }
      let amount;
      try { amount = parseCents(value.amount); }
      catch { return error(400, 'INVALID_AMOUNT'); }
      const transfer = await createInternalTransfer(database, actor, {
        idempotencyKey: value.idempotencyKey,
        sourceAccountId: value.sourceAccountId,
        targetAccountId: value.targetAccountId,
        amountCents: amount,
        transferredOn: value.transferredOn,
        note: value.note as string | null | undefined,
      });
      return json({ transfer }, 201);
    }






    // F2 read-only scenario: POST carries hypothetical parameters but never
    // writes, confirms purchases, changes reserves, or posts cash.
    // G2: append-only replacement schedule, requires exact user-supplied
    // original outstanding and real, manually provided charges.
    if(path==='/api/renegotiations'||/^\/api\/renegotiations\/[0-9a-f-]{36}(?:\/payments)?$/.test(path)){
      const matched=path.match(/^\/api\/renegotiations\/([0-9a-f-]{36})(\/payments)?$/);
      const agreementId=matched?.[1],payments=Boolean(matched?.[2]);
      if(method==='GET'){
        const q=requestURL.searchParams,allowed=new Set(agreementId&&!payments?[]:['limit','offset']);
        let bad=false;q.forEach((_v,k)=>{if(!allowed.has(k)||q.getAll(k).length!==1)bad=true;});
        if(bad)return error(400,'INVALID_FILTER');
        const pag=(k:string,def:number)=>{const v=q.get(k);if(v===null)return def;if(!/^(?:0|[1-9]\d{0,6})$/.test(v))throw new TypeError('Invalid page');return Number(v);};
        if(!agreementId)return json({renegotiations:await listRenegotiations(database,actor,pag('limit',50),pag('offset',0))});
        if(!payments){const result=await getRenegotiation(database,actor,agreementId);return result?json({renegotiation:result}):error(404,'NOT_FOUND');}
        return json({payments:await listRenegotiationPayments(database,actor,agreementId,pag('limit',50),pag('offset',0))});
      }
      if(method!=='POST'||(agreementId&&!payments)||requestURL.search)return error(405,'METHOD_NOT_ALLOWED');
      if(!request.body)return error(400,'INVALID_BODY');
      const bytes=await readBounded(request,8192);
      if(bytes===null)return error(413,'PAYLOAD_TOO_LARGE');
      let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
      catch{return error(400,'INVALID_JSON');}
      if(!raw||typeof raw!=='object'||Array.isArray(raw))return error(400,'INVALID_BODY');
      const v=raw as Record<string,unknown>;
      if(typeof v.idempotencyKey!=='string')return error(400,'INVALID_BODY');
      if(payments){
        if(Object.keys(v).some(k=>!['idempotencyKey','installmentNo','accountId','amount','method','paidOn'].includes(k))||
         !Number.isInteger(v.installmentNo)||typeof v.accountId!=='string'||
         typeof v.amount!=='string'||typeof v.paidOn!=='string'||typeof v.method!=='string')
         return error(400,'INVALID_BODY');
        const payment=await payRenegotiation(database,actor,{
         idempotencyKey:v.idempotencyKey,agreementId:agreementId!,installmentNo:v.installmentNo as number,
         accountId:v.accountId,amountCents:parseCents(v.amount),
         method:v.method as 'cash'|'pix'|'debit'|'bank_transfer',paidOn:v.paidOn,
        });return json({payment},201);
      }
      if(Object.keys(v).some(k=>!['idempotencyKey','subject','expectedOutstanding','fees','agreedOn','installments','reason'].includes(k))||
       !v.subject||typeof v.subject!=='object'||Array.isArray(v.subject)||
       typeof v.expectedOutstanding!=='string'||typeof v.fees!=='string'||
       typeof v.agreedOn!=='string'||!Array.isArray(v.installments)||
       (v.reason!==undefined&&v.reason!==null&&typeof v.reason!=='string'))return error(400,'INVALID_BODY');
      const installments:( {dueOn:string;amountCents:number} )[]=[];
      if(v.installments.length<1||v.installments.length>24)return error(400,'INVALID_BODY');
      for(const item of v.installments){
       if(!item||typeof item!=='object'||Array.isArray(item))return error(400,'INVALID_BODY');
       const entry=item as Record<string,unknown>;
       if(Object.keys(entry).some(k=>!['dueOn','amount'].includes(k))||typeof entry.dueOn!=='string'||typeof entry.amount!=='string')
         return error(400,'INVALID_BODY');
       installments.push({dueOn:entry.dueOn,amountCents:parseCents(entry.amount)});
      }
      const agreement=await createRenegotiation(database,actor,{
       idempotencyKey:v.idempotencyKey,subject:v.subject as DebtSubject,
       expectedOutstandingCents:parseCents(v.expectedOutstanding),
       feesCents:parseCents(v.fees),agreedOn:v.agreedOn,installments,
       reason:v.reason as string|null|undefined,
      });return json({renegotiation:agreement},201);
    }
    // G1 loan/receivable API: loan principal is NOT earned income.
    if(path==='/api/loans'||/^\/api\/loans\/[0-9a-f-]{36}(?:\/repayments)?$/.test(path)){
      const loanMatch=path.match(/^\/api\/loans\/([0-9a-f-]{36})(\/repayments)?$/);
      const key=loanMatch?.[1];
      const isPayments=Boolean(loanMatch?.[2]);
      if(method==='GET'){
        const query=requestURL.searchParams;
        const allowed=new Set(isPayments||!key?['limit','offset']:[]);
        let bad=false;query.forEach((_v,k)=>{if(!allowed.has(k)||query.getAll(k).length!==1)bad=true;});
        if(bad)return error(400,'INVALID_FILTER');
        const p=(name:string,fallback:number)=>{const v=query.get(name);if(v===null)return fallback;
          if(!/^(?:0|[1-9]\d{0,6})$/.test(v))throw new TypeError('Invalid pagination');return Number(v);};
        if(!key)return json({loans:await listLoans(database,actor,p('limit',50),p('offset',0))});
        if(!isPayments){const loan=await getLoan(database,actor,key);return loan?json({loan}):error(404,'NOT_FOUND');}
        return json({repayments:await listLoanRepayments(database,actor,key,p('limit',50),p('offset',0))});
      }
      if(method!=='POST'||(key&&!isPayments)||requestURL.search)return error(405,'METHOD_NOT_ALLOWED');
      if(!request.body)return error(400,'INVALID_BODY');
      const bytes=await readBounded(request,4096);
      if(bytes===null)return error(413,'PAYLOAD_TOO_LARGE');
      let raw:unknown;
      try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
      catch{return error(400,'INVALID_JSON');}
      if(!raw||typeof raw!=='object'||Array.isArray(raw))return error(400,'INVALID_BODY');
      const v=raw as Record<string,unknown>;
      const fields=isPayments?['idempotencyKey','destinationAccountId','amount','receivedOn']:
        ['idempotencyKey','borrower','title','sourceAccountId','principal','lentOn','dueOn'];
      if(Object.keys(v).some(k=>!fields.includes(k))||typeof v.idempotencyKey!=='string'||
         typeof (isPayments?v.amount:v.principal)!=='string')return error(400,'INVALID_BODY');
      if(isPayments){
        if(typeof v.destinationAccountId!=='string'||typeof v.receivedOn!=='string')return error(400,'INVALID_BODY');
        const repayment=await receiveLoanRepayment(database,actor,{
          idempotencyKey:v.idempotencyKey,loanId:key!,destinationAccountId:v.destinationAccountId,
          amountCents:parseCents(v.amount as string),receivedOn:v.receivedOn,
        });
        return json({repayment},201);
      }
      if(typeof v.borrower!=='string'||typeof v.title!=='string'||
         typeof v.sourceAccountId!=='string'||typeof v.lentOn!=='string'||typeof v.dueOn!=='string')
         return error(400,'INVALID_BODY');
      const loan=await grantLoan(database,actor,{
        idempotencyKey:v.idempotencyKey,borrower:v.borrower,title:v.title,sourceAccountId:v.sourceAccountId,
        principalCents:parseCents(v.principal as string),lentOn:v.lentOn,dueOn:v.dueOn,
      });
      return json({loan},201);
    }
    if(path==='/api/planning/potential'){
      if(method!=='POST')return error(405,'METHOD_NOT_ALLOWED');
      if(requestURL.search)return error(400,'INVALID_FILTER');
      if(!request.body)return error(400,'INVALID_BODY');
      const bytes=await readBounded(request,2048);
      if(bytes===null)return error(413,'PAYLOAD_TOO_LARGE');
      let raw:unknown;
      try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
      catch{return error(400,'INVALID_JSON');}
      if(!raw||typeof raw!=='object'||Array.isArray(raw))return error(400,'INVALID_BODY');
      const v=raw as Record<string,unknown>;
      if(Object.keys(v).some(k=>!['include','sourceId','asOf','from','to'].includes(k))||
       typeof v.include!=='boolean'||typeof v.asOf!=='string'||
       typeof v.from!=='string'||typeof v.to!=='string'||
       (v.sourceId!==undefined&&typeof v.sourceId!=='string'))return error(400,'INVALID_BODY');
      return json({potential:await estimatePotential(database,actor,{
        include:v.include,sourceId:typeof v.sourceId==='string'?v.sourceId:'',
        asOf:v.asOf,from:v.from,to:v.to,
      },()=>new Date(clock()))});
    }
    if(path==='/api/planning/simulate'){
      if(method!=='POST')return error(405,'METHOD_NOT_ALLOWED');
      if(requestURL.search) return error(400,'INVALID_FILTER');
      if(!request.body)return error(400,'INVALID_BODY');
      const bytes=await readBounded(request,2048);
      if(bytes===null)return error(413,'PAYLOAD_TOO_LARGE');
      let raw:unknown;
      try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
      catch{return error(400,'INVALID_JSON');}
      if(!raw||typeof raw!=='object'||Array.isArray(raw))return error(400,'INVALID_BODY');
      const v=raw as Record<string,unknown>;
      if(Object.keys(v).some(k=>!['from','to','hypothetical'].includes(k))||
       typeof v.from!=='string'||typeof v.to!=='string')
       return error(400,'INVALID_BODY');
      let what:undefined|{amountCents:number;purchaseOn:string;dueOn:string;intentionId?:string};
      if(v.hypothetical!==undefined&&v.hypothetical!==null){
       const x=v.hypothetical;
       if(!x||typeof x!=='object'||Array.isArray(x))return error(400,'INVALID_BODY');
       const p=x as Record<string,unknown>;
       if(Object.keys(p).some(k=>!['amount','purchaseOn','dueOn','intentionId'].includes(k))||
        typeof p.amount!=='string'||typeof p.purchaseOn!=='string'||typeof p.dueOn!=='string'||
        (p.intentionId!==undefined&&typeof p.intentionId!=='string'))return error(400,'INVALID_BODY');
       what={amountCents:parseCents(p.amount),purchaseOn:p.purchaseOn,dueOn:p.dueOn,
        ...(p.intentionId!==undefined?{intentionId:p.intentionId as string}:{})};
      }
      const simulation=await simulatePlanning(database,actor,{from:v.from,to:v.to,
       ...(what?{hypothetical:what}:{})});
      return json({simulation});
    }

    // F1: planning is virtual. Converting an intention atomically adds exactly
    // one ordinary payable and removes the virtual reserve. No cash posting.
    if(path==='/api/intentions'||path==='/api/planning-summary'||path.startsWith('/api/intentions/')){
      const intentId=path.match(/^\/api\/intentions\/([0-9a-f-]{36})$/);
      const intentEvents=path.match(/^\/api\/intentions\/([0-9a-f-]{36})\/events$/);
      const paged=method==='GET'&&(path==='/api/intentions'||intentEvents!==null);
      const allowed=paged?new Set(['limit','offset']):new Set<string>();
      let unexpected=false;
      requestURL.searchParams.forEach((_v,k)=>{if(!allowed.has(k)||requestURL.searchParams.getAll(k).length!==1)unexpected=true;});
      if(unexpected)return error(400,'INVALID_FILTER');
      const page=(name:string,def:number)=>{
        const v=requestURL.searchParams.get(name);
        if(v===null)return def;
        if(!/^(?:0|[1-9]\d{0,5})$/.test(v))throw new TypeError('Invalid paging');
        return Number(v);
      };
      if(method==='GET'){
        if(path==='/api/planning-summary')return json({summary:await getPlanningSummary(database,actor)});
        if(path==='/api/intentions')return json({intentions:await listIntentions(database,actor,page('limit',50),page('offset',0))});
        if(intentId){
          const v=await getIntention(database,actor,intentId[1]!);
          return v?json({intention:v}):error(404,'NOT_FOUND');
        }
        if(intentEvents)return json({events:await listIntentionEvents(database,actor,intentEvents[1]!,page('limit',50),page('offset',0))});
        return error(404,'NOT_FOUND');
      }
      if(path==='/api/planning-summary'||intentId)return error(405,'METHOD_NOT_ALLOWED');
      if(path!=='/api/intentions'&&!intentEvents)return error(404,'NOT_FOUND');
      if(!request.body)return error(400,'INVALID_BODY');
      const bytes=await readBounded(request,4096);
      if(bytes===null)return error(413,'PAYLOAD_TOO_LARGE');
      let raw:unknown;
      try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
      catch{return error(400,'INVALID_JSON');}
      if(!raw||typeof raw!=='object'||Array.isArray(raw))return error(400,'INVALID_BODY');
      const v=raw as Record<string,unknown>;
      if(typeof v.idempotencyKey!=='string')return error(400,'INVALID_BODY');
      if(path==='/api/intentions'){
        if(Object.keys(v).some(k=>!['idempotencyKey','title','description','amount','plannedOn'].includes(k))||
          typeof v.title!=='string'||typeof v.amount!=='string'||typeof v.plannedOn!=='string'||
          (v.description!==undefined&&v.description!==null&&typeof v.description!=='string'))
          return error(400,'INVALID_BODY');
        const intention=await createIntention(database,actor,{
          idempotencyKey:v.idempotencyKey,title:v.title,
          description:v.description as string|null|undefined,
          amountCents:parseCents(v.amount),plannedOn:v.plannedOn,
        });
        return json({intention},201);
      }
      if(Object.keys(v).some(k=>!['idempotencyKey','action','reserveAmount','dueOn'].includes(k))||
         !['reserve','plan','exclude','convert'].includes(String(v.action))||
         (v.action==='reserve'?typeof v.reserveAmount!=='string':v.reserveAmount!==undefined)||
         (v.action==='convert'?typeof v.dueOn!=='string':v.dueOn!==undefined))
        return error(400,'INVALID_BODY');
      const result=await transitionIntention(database,actor,intentEvents![1]!,{
        idempotencyKey:v.idempotencyKey,
        action:v.action as 'reserve'|'plan'|'exclude'|'convert',
        ...(v.action==='reserve'?{reservedCents:parseCents(v.reserveAmount as string)}:{}),
        ...(v.action==='convert'?{dueOn:v.dueOn as string}:{}),
      });
      return json(result,201);
    }

    // E4: only a separate EXPLICIT retention confirmation may reduce a debt.
    // These routes never create posted_cash_movements or bank debits.
    {
      const payrollPath=path.match(/^\/api\/income-sources\/([0-9a-f-]{36})\/expectations\/(scheduled_\d{4}-\d{2}-\d{2}|manual_[0-9a-f-]{36})\/salary\/withholdings$/);
      const obligationPath=path.match(/^\/api\/obligations\/([0-9a-f-]{36})\/withholdings$/);
      if(payrollPath||obligationPath){
        let invalidFilter=false;
        const allowed=method==='GET'?new Set(['limit','offset']):new Set<string>();
        requestURL.searchParams.forEach((_v,k)=>{if(!allowed.has(k)||requestURL.searchParams.getAll(k).length!==1)invalidFilter=true;});
        if(invalidFilter)return error(400,'INVALID_FILTER');
        const pg=(k:string,def:number)=>{
          const raw=requestURL.searchParams.get(k);
          if(raw===null)return def;
          if(!/^(?:0|[1-9]\d{0,5})$/.test(raw))throw new TypeError('Invalid page');
          return Number(raw);
        };
        if(method==='GET'){
          if(payrollPath)return json({withholdings:await listSalaryWithholdings(database,actor,payrollPath[1]!,payrollPath[2]!,pg('limit',50),pg('offset',0))});
          return json({withholdings:await listObligationWithholdings(database,actor,obligationPath![1]!,pg('limit',50),pg('offset',0))});
        }
        if(!payrollPath)return error(404,'NOT_FOUND');
        if(!request.body)return error(400,'INVALID_BODY');
        const bytes=await readBounded(request,4096);
        if(bytes===null)return error(413,'PAYLOAD_TOO_LARGE');
        let raw:unknown;
        try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
        catch{return error(400,'INVALID_JSON');}
        if(!raw||typeof raw!=='object'||Array.isArray(raw))return error(400,'INVALID_BODY');
        const p=raw as Record<string,unknown>;
        if(Object.keys(p).some(k=>!['idempotencyKey','statementId','discountIndex','obligationId','amount','confirmedOn','confirmRetained'].includes(k))||
           typeof p.idempotencyKey!=='string'||!Number.isSafeInteger(p.statementId)||
           !Number.isInteger(p.discountIndex)||typeof p.obligationId!=='string'||
           typeof p.amount!=='string'||typeof p.confirmedOn!=='string'||p.confirmRetained!==true)
           return error(400,'INVALID_BODY');
        const withholding=await confirmSalaryWithholding(database,actor,payrollPath[1]!,payrollPath[2]!,{
          idempotencyKey:p.idempotencyKey,statementId:p.statementId as number,
          discountIndex:p.discountIndex as number,obligationId:p.obligationId,
          amountCents:parseCents(p.amount),confirmedOn:p.confirmedOn,confirmRetained:true,
        });
        return json({withholding},201);
      }
    }

    // E3 payroll composition is analytic: never credit income or pay obligations.
    if(path.startsWith('/api/income-sources/')){
      const salaryRevisions=path.match(/^\/api\/income-sources\/([0-9a-f-]{36})\/salary-revisions$/);
      const salaryStatement=path.match(/^\/api\/income-sources\/([0-9a-f-]{36})\/expectations\/(scheduled_\d{4}-\d{2}-\d{2}|manual_[0-9a-f-]{36})\/salary$/);
      if(salaryRevisions||salaryStatement){
        let unknown=false;
        const allowed=method==='GET'?new Set(['limit','offset']):new Set<string>();
        requestURL.searchParams.forEach((_v,k)=>{if(!allowed.has(k)||requestURL.searchParams.getAll(k).length!==1)unknown=true;});
        if(unknown)return error(400,'INVALID_FILTER');
        const pg=(k:string,def:number)=>{
          const v=requestURL.searchParams.get(k);
          if(v===null)return def;
          if(!/^(?:0|[1-9]\d{0,5})$/.test(v))throw new TypeError('Invalid paging');
          return Number(v);
        };
        if(method==='GET'){
          if(salaryRevisions){
            return json({revisions:await listRevisions(database,actor,salaryRevisions[1]!,pg('limit',50),pg('offset',0))});
          }
          return json({
            statement:await getStatement(database,actor,salaryStatement![1]!,salaryStatement![2]!),
            history:await listStatements(database,actor,salaryStatement![1]!,salaryStatement![2]!,pg('limit',25),pg('offset',0)),
          });
        }
        if(!request.body)return error(400,'INVALID_BODY');
        const bytes=await readBounded(request,8192);
        if(bytes===null)return error(413,'PAYLOAD_TOO_LARGE');
        let raw:unknown;
        try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
        catch{return error(400,'INVALID_JSON');}
        if(!raw||typeof raw!=='object'||Array.isArray(raw))return error(400,'INVALID_BODY');
        const p=raw as Record<string,unknown>;
        if(typeof p.idempotencyKey!=='string')return error(400,'INVALID_BODY');
        if(salaryRevisions){
          if(Object.keys(p).some(k=>!['idempotencyKey','effectiveOn','net','reason'].includes(k))||
            typeof p.effectiveOn!=='string'||typeof p.net!=='string'||typeof p.reason!=='string')
            return error(400,'INVALID_BODY');
          return json({revision:await createRevision(database,actor,salaryRevisions[1]!,{
            idempotencyKey:p.idempotencyKey,effectiveOn:p.effectiveOn,netCents:parseCents(p.net),reason:p.reason,
          })},201);
        }
        if(Object.keys(p).some(k=>!['idempotencyKey','net','gross','discounts','components'].includes(k))||
          typeof p.net!=='string'||(p.gross!==null&&p.gross!==undefined&&typeof p.gross!=='string')||
          !Array.isArray(p.discounts)||!Array.isArray(p.components)||p.discounts.length>20||p.components.length>20)
          return error(400,'INVALID_BODY');
        const signedCents=(text:string):number=>{
          if(typeof text!=='string')throw new TypeError('Invalid signed decimal');
          if(text.startsWith('-'))return -parseCents(text.slice(1));
          return parseCents(text);
        };
        const discounts=p.discounts.map((d:unknown)=>{
          if(!d||typeof d!=='object'||Array.isArray(d))throw new TypeError('Invalid deduction');
          const v=d as Record<string,unknown>;
          if(Object.keys(v).some(k=>!['label','amount'].includes(k))||typeof v.label!=='string'||typeof v.amount!=='string')
            throw new TypeError('Invalid deduction');
          return {label:v.label,amountCents:parseCents(v.amount)};
        });
        const components=p.components.map((c:unknown)=>{
          if(!c||typeof c!=='object'||Array.isArray(c))throw new TypeError('Invalid component');
          const v=c as Record<string,unknown>;
          if(Object.keys(v).some(k=>!['kind','reason','amount'].includes(k))||
            !['overtime','bonus','other','reduction'].includes(String(v.kind))||
            typeof v.reason!=='string'||typeof v.amount!=='string')
            throw new TypeError('Invalid component');
          return {kind:v.kind as 'overtime'|'bonus'|'other'|'reduction',reason:v.reason,amountCents:signedCents(v.amount)};
        });
        const statement=await createStatement(database,actor,salaryStatement![1]!,salaryStatement![2]!,{
          idempotencyKey:p.idempotencyKey,netCents:parseCents(p.net),
          grossCents:typeof p.gross==='string'?parseCents(p.gross):null,
          discounts,components,
        });
        return json({statement},201);
      }
    }

    // E2: forecasts and receipt attribution never write or manufacture cash.
    if(path==='/api/income-sources'||path==='/api/income-calendar'||path==='/api/income-receipts/available'||path.startsWith('/api/income-sources/')){
      const sourcePath=path.match(/^\/api\/income-sources\/([0-9a-f-]{36})$/);
      const manualPath=path.match(/^\/api\/income-sources\/([0-9a-f-]{36})\/expectations$/);
      const expectedPath=path.match(/^\/api\/income-sources\/([0-9a-f-]{36})\/expectations\/(scheduled_\d{4}-\d{2}-\d{2}|manual_[0-9a-f-]{36})\/(events|receipts)$/);
      const paged=method==='GET'&&(path==='/api/income-sources'||path==='/api/income-receipts/available'||expectedPath!==null);
      const allowed=path==='/api/income-calendar'&&method==='GET'?new Set(['from','to']):paged?new Set(['limit','offset']):new Set<string>();
      let bad=false;requestURL.searchParams.forEach((_v,k)=>{if(!allowed.has(k)||requestURL.searchParams.getAll(k).length!==1)bad=true;});
      if(bad)return error(400,'INVALID_FILTER');
      const pg=(k:string,def:number)=>{const v=requestURL.searchParams.get(k);if(v===null)return def;if(!/^(?:0|[1-9]\d{0,5})$/.test(v))throw new TypeError('Invalid page');return Number(v);};
      if(method==='GET'){
        if(path==='/api/income-sources')return json({sources:await listSources(database,actor,pg('limit',50),pg('offset',0))});
        if(path==='/api/income-calendar'){
          const from=requestURL.searchParams.get('from'),to=requestURL.searchParams.get('to');
          if(!from||!to)return error(400,'INVALID_PERIOD');
          return json({calendar:await listCalendar(database,actor,from,to)});
        }
        if(path==='/api/income-receipts/available')return json({movements:await listAvailableIncomeMovements(database,actor,pg('limit',50),pg('offset',0))});
        if(sourcePath)return json({source:await getSource(database,actor,sourcePath[1]!)});
        if(expectedPath&&expectedPath[3]==='events')return json({events:await listExpectationEvents(database,actor,expectedPath[1]!,expectedPath[2]!,pg('limit',50),pg('offset',0))});
        if(expectedPath&&expectedPath[3]==='receipts')return json({receipts:await listExpectationReceipts(database,actor,expectedPath[1]!,expectedPath[2]!,pg('limit',50),pg('offset',0))});
        return error(404,'NOT_FOUND');
      }
      if(path!=='/api/income-sources'&&!manualPath&&!expectedPath)return error(404,'NOT_FOUND');
      if(!request.body)return error(400,'INVALID_BODY');
      const bytes=await readBounded(request,4096);
      if(bytes===null)return error(413,'PAYLOAD_TOO_LARGE');
      let raw:unknown;
      try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return error(400,'INVALID_JSON');}
      if(!raw||typeof raw!=='object'||Array.isArray(raw))return error(400,'INVALID_BODY');
      const p=raw as Record<string,unknown>;
      const fields=path==='/api/income-sources'
        ? ['idempotencyKey','name','relationship','payKind','periodicity','anchorOn','endOn','intervalDays','fixedNet']
        : manualPath?['idempotencyKey','expectedOn','amount']
        : expectedPath?.[3]==='events'?['idempotencyKey','state','newOn','reason']
        : ['idempotencyKey','movementId'];
      if(Object.keys(p).some(k=>!fields.includes(k))||typeof p.idempotencyKey!=='string')return error(400,'INVALID_BODY');
      if(path==='/api/income-sources'){
        if(typeof p.name!=='string'||
           !['employment','public','continuous','freelance','other'].includes(String(p.relationship))||
           !['fixed','variable','mixed','occasional'].includes(String(p.payKind))||
           !['none','weekly','fortnightly','monthly','custom'].includes(String(p.periodicity))||
           ['anchorOn','endOn'].some(k=>p[k]!==undefined&&p[k]!==null&&typeof p[k]!=='string')||
           (p.intervalDays!==undefined&&p.intervalDays!==null&&!Number.isInteger(p.intervalDays))||
           (p.fixedNet!==undefined&&p.fixedNet!==null&&typeof p.fixedNet!=='string'))return error(400,'INVALID_BODY');
        return json({source:await createSource(database,actor,{
          idempotencyKey:p.idempotencyKey,name:p.name,
          relationship:p.relationship as 'employment'|'public'|'continuous'|'freelance'|'other',
          payKind:p.payKind as 'fixed'|'variable'|'mixed'|'occasional',
          periodicity:p.periodicity as 'none'|'weekly'|'fortnightly'|'monthly'|'custom',
          anchorOn:p.anchorOn as string|null|undefined,endOn:p.endOn as string|null|undefined,
          intervalDays:p.intervalDays as number|null|undefined,
          fixedNetCents:typeof p.fixedNet==='string'?parseCents(p.fixedNet):null,
        })},201);
      }
      if(manualPath){
        if(typeof p.expectedOn!=='string'||typeof p.amount!=='string')return error(400,'INVALID_BODY');
        const occurrenceKey=await createManualExpectation(database,actor,manualPath[1]!,{
          idempotencyKey:p.idempotencyKey,expectedOn:p.expectedOn,amountCents:parseCents(p.amount),
        });
        return json({occurrenceKey},201);
      }
      if(expectedPath?.[3]==='events'){
        if(!['confirmed','delayed','canceled'].includes(String(p.state))||
          (p.newOn!==undefined&&p.newOn!==null&&typeof p.newOn!=='string')||
          (p.reason!==undefined&&p.reason!==null&&typeof p.reason!=='string'))return error(400,'INVALID_BODY');
        const expectation=await changeExpectation(database,actor,expectedPath[1]!,expectedPath[2]!,{
          idempotencyKey:p.idempotencyKey,state:p.state as 'confirmed'|'delayed'|'canceled',
          newOn:p.newOn as string|null|undefined,reason:p.reason as string|null|undefined,
        });
        return json({expectation},201);
      }
      if(expectedPath?.[3]==='receipts'){
        if(typeof p.movementId!=='string')return error(400,'INVALID_BODY');
        const expectation=await linkIncomeReceipt(database,actor,expectedPath[1]!,expectedPath[2]!,{
          idempotencyKey:p.idempotencyKey,movementId:p.movementId,
        });
        return json({expectation},201);
      }
      return error(404,'NOT_FOUND');
    }

    if(path==='/api/works'||path==='/api/work-movements/available'||path.startsWith('/api/works/')){
      const match=path.match(/^\/api\/works\/([0-9a-f-]{36})(?:\/(states|movements))?$/);
      const paged=path==='/api/works'||path==='/api/work-movements/available'||!!match?.[2];
      const allowed=method==='GET'&&paged?new Set(['limit','offset']):new Set<string>();
      let invalid=false;
      requestURL.searchParams.forEach((_v,k)=>{if(!allowed.has(k)||requestURL.searchParams.getAll(k).length!==1)invalid=true;});
      if(invalid)return error(400,'INVALID_FILTER');
      const page=(k:string,def:number)=>{const v=requestURL.searchParams.get(k);if(v===null)return def;if(!/^(?:0|[1-9]\d{0,5})$/.test(v))throw new TypeError('Invalid page');return Number(v);};
      if(method==='GET'){
        if(path==='/api/works')return json({works:await listWorks(database,actor,page('limit',50),page('offset',0))});
        if(path==='/api/work-movements/available')return json({movements:await availableWorkMovements(database,actor,page('limit',50),page('offset',0))});
        if(match?.[2]==='states')return json({states:await getWorkHistory(database,actor,match[1]!,page('limit',50),page('offset',0))});
        if(match?.[2]==='movements')return json({movements:await getWorkMovements(database,actor,match[1]!,page('limit',50),page('offset',0))});
        if(match)return json({work:await getWork(database,actor,match[1]!)});
        return error(404,'NOT_FOUND');
      }
      if(path!=='/api/works'&&!match?.[2])return error(404,'NOT_FOUND');
      if(!request.body)return error(400,'INVALID_BODY');
      const bytes=await readBounded(request,4096);if(!bytes)return error(413,'PAYLOAD_TOO_LARGE');
      let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return error(400,'INVALID_JSON');}
      if(!raw||typeof raw!=='object'||Array.isArray(raw))return error(400,'INVALID_BODY');
      const p=raw as Record<string,unknown>;
      const fields=path==='/api/works'?['idempotencyKey','title','client','expected','plannedOn','dueOn','category','notes']:
        match?.[2]==='states'?['idempotencyKey','state','reason']:['idempotencyKey','movementId'];
      if(Object.keys(p).some(k=>!fields.includes(k))||typeof p.idempotencyKey!=='string')return error(400,'INVALID_BODY');
      if(path==='/api/works'){
        if(typeof p.title!=='string'||['client','expected','plannedOn','dueOn','category','notes'].some(k=>p[k]!==undefined&&p[k]!==null&&typeof p[k]!=='string'))return error(400,'INVALID_BODY');
        const str=(k:string)=>p[k] as string|null|undefined;
        return json({work:await createWork(database,actor,{idempotencyKey:p.idempotencyKey,title:p.title,
          client:str('client'),expectedCents:typeof p.expected==='string'?parseCents(p.expected):null,
          plannedOn:str('plannedOn'),dueOn:str('dueOn'),category:str('category'),notes:str('notes')})},201);
      }
      if(match?.[2]==='states'){
        if((p.state!=='confirmed'&&p.state!=='realized'&&p.state!=='canceled')||(p.reason!==undefined&&p.reason!==null&&typeof p.reason!=='string'))return error(400,'INVALID_BODY');
        return json({work:await changeWorkState(database,actor,match[1]!,{idempotencyKey:p.idempotencyKey,state:p.state,reason:p.reason as string|null|undefined})},201);
      }
      if(typeof p.movementId!=='string')return error(400,'INVALID_BODY');
      return json({work:await linkWorkMovement(database,actor,match![1]!,{idempotencyKey:p.idempotencyKey,movementId:p.movementId})},201);
    }

    // SPEC-004 / D1: credit is a commitment, never an immediate cash flow.
    // All paths share the verified Better Auth principal and strict origin.
    if (path.startsWith('/api/cards')) {
      const cardMatch=path.match(/^\/api\/cards\/([0-9a-f-]{36})$/);
      const purchaseList=path.match(/^\/api\/cards\/([0-9a-f-]{36})\/purchases$/);
      const purchaseDetail=path.match(/^\/api\/cards\/([0-9a-f-]{36})\/purchases\/([0-9a-f-]{36})$/);
      const invoiceList=path.match(/^\/api\/cards\/([0-9a-f-]{36})\/invoices$/);
      const invoiceDetail=path.match(/^\/api\/cards\/([0-9a-f-]{36})\/invoices\/(\d{4}-\d{2})$/);
      const paymentPath=path.match(/^\/api\/cards\/([0-9a-f-]{36})\/invoices\/(\d{4}-\d{2})\/payments$/);
      const reconciliationPath=path.match(/^\/api\/cards\/([0-9a-f-]{36})\/invoices\/(\d{4}-\d{2})\/reconciliation$/);
      const page=(name:string,defaultValue:number)=>{
        const raw=requestURL.searchParams.get(name);
        if(raw===null)return defaultValue;
        if(!/^(?:0|[1-9]\d{0,6})$/.test(raw))throw new TypeError('Invalid paging');
        return Number(raw);
      };
      const allowed=method==='GET'&&
        (purchaseList!==null||invoiceList!==null||paymentPath!==null||reconciliationPath!==null)?new Set(['limit','offset']):new Set<string>();
      let unknownQuery=false;
      requestURL.searchParams.forEach((_value,key)=>{
        if(!allowed.has(key)||requestURL.searchParams.getAll(key).length!==1)unknownQuery=true;
      });
      if(unknownQuery)return error(400,'INVALID_FILTER');
      if (method==='GET' && path==='/api/cards')return json({cards:await listCards(database,actor)});
      if (method==='GET' && cardMatch){
        const card=await getCard(database,actor,cardMatch[1]!);
        return card?json({card}):error(404,'NOT_FOUND');
      }
      if (method==='GET' && purchaseList){
        return json({purchases:await listPurchases(database,actor,purchaseList[1]!,
         page('limit',50),page('offset',0))});
      }
      if (method==='GET' && purchaseDetail){
        const cardId=purchaseDetail[1]!,purchaseId=purchaseDetail[2]!;
        const purchase=await getPurchase(database,actor,cardId,purchaseId);
        if(!purchase)return error(404,'NOT_FOUND');
        const installments=await getPurchaseInstallments(database,actor,cardId,purchaseId);
        if(!installments)return error(404,'NOT_FOUND');
        return json({purchase,installments});
      }
      if (method==='GET' && invoiceList){
        return json({invoices:await listInvoices(database,actor,invoiceList[1]!,
         page('limit',50),page('offset',0))});
      }
      if (method==='GET' && invoiceDetail){
        const data=await getInvoice(database,actor,invoiceDetail[1]!,invoiceDetail[2]!);
        return data?json(data):error(404,'NOT_FOUND');
      }
      if(method==='GET'&&reconciliationPath){
        return json(await readInvoiceReconciliation(database,actor,reconciliationPath[1]!,reconciliationPath[2]!,
          page('limit',25),page('offset',0)));
      }
      if(method==='POST'&&reconciliationPath){
        if(!request.body)return error(400,'INVALID_BODY');
        const bytes=await readBounded(request,4096);
        if(bytes===null)return error(413,'PAYLOAD_TOO_LARGE');
        let raw:unknown;
        try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
        catch{return error(400,'INVALID_JSON');}
        if(!raw||typeof raw!=='object'||Array.isArray(raw))return error(400,'INVALID_BODY');
        const p=raw as Record<string,unknown>;
        if(Object.keys(p).some(k=>!['idempotencyKey','reportedTotal'].includes(k))||
           typeof p.idempotencyKey!=='string'||typeof p.reportedTotal!=='string')
          return error(400,'INVALID_BODY');
        let reportedTotalCents;
        try{reportedTotalCents=parseReportedInvoiceCents(p.reportedTotal);}
        catch{return error(400,'INVALID_AMOUNT');}
        const reconciliation=await recordInvoiceBankTotal(database,actor,{
          idempotencyKey:p.idempotencyKey,
          cardId:reconciliationPath[1]!,cycle:reconciliationPath[2]!,reportedTotalCents,
        });
        return json({reconciliation},201);
      }
      if (method==='GET'&&paymentPath){
        return json({payments:await listInvoicePayments(database,actor,paymentPath[1]!,paymentPath[2]!,
          page('limit',50),page('offset',0))});
      }
      if (method==='POST'&&paymentPath){
        if(!request.body)return error(400,'INVALID_BODY');
        const bytes=await readBounded(request,4096);
        if(bytes===null)return error(413,'PAYLOAD_TOO_LARGE');
        let raw:unknown;
        try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
        catch{return error(400,'INVALID_JSON');}
        if(!raw||typeof raw!=='object'||Array.isArray(raw))return error(400,'INVALID_BODY');
        const p=raw as Record<string,unknown>,keys=Object.keys(p);
        if(keys.some(k=>!['idempotencyKey','accountId','amount','method','paidOn'].includes(k))||
          typeof p.idempotencyKey!=='string'||typeof p.accountId!=='string'||
          typeof p.amount!=='string'||typeof p.paidOn!=='string'||
          (p.method!=='cash'&&p.method!=='pix'&&p.method!=='debit'&&p.method!=='bank_transfer'))
          return error(400,'INVALID_BODY');
        let amount;
        try{amount=parseCents(p.amount);}catch{return error(400,'INVALID_AMOUNT');}
        const payment=await payInvoice(database,actor,{
          idempotencyKey:p.idempotencyKey,cardId:paymentPath[1]!,cycle:paymentPath[2]!,
          accountId:p.accountId,amountCents:amount,method:p.method,paidOn:p.paidOn
        });
        return json({payment},201);
      }
      if(method==='POST'&&(path==='/api/cards'||purchaseList)){
        if(!request.body)return error(400,'INVALID_BODY');
        const bytes=await readBounded(request,4096);
        if(bytes===null)return error(413,'PAYLOAD_TOO_LARGE');
        let raw:unknown;
        try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
        catch{return error(400,'INVALID_JSON');}
        if(!raw||typeof raw!=='object'||Array.isArray(raw))return error(400,'INVALID_BODY');
        const v=raw as Record<string,unknown>;
        const keys=Object.keys(v);
        const allowedBody=new Set(path==='/api/cards'?
          ['idempotencyKey','name','institution','limit','closingDay','dueDay']:
          ['idempotencyKey','title','merchant','category','purchasedOn','total','installments']);
        if(keys.some(key=>!allowedBody.has(key)))return error(400,'INVALID_BODY');
        if(path==='/api/cards'){
          if(typeof v.idempotencyKey!=='string'||typeof v.name!=='string'||
             typeof v.limit!=='string'||typeof v.closingDay!=='number'||
             typeof v.dueDay!=='number'||
             (v.institution!==undefined&&v.institution!==null&&typeof v.institution!=='string'))return error(400,'INVALID_BODY');
          let limit;
          try{limit=parseCents(v.limit);}catch{return error(400,'INVALID_AMOUNT');}
          const card=await createCard(database,actor,{
           idempotencyKey:v.idempotencyKey,name:v.name,institution:v.institution as string|null|undefined,
           limitCents:limit,closingDay:v.closingDay,dueDay:v.dueDay
          });
          return json({card},201);
        }
        if(typeof v.idempotencyKey!=='string'||typeof v.title!=='string'||
           typeof v.purchasedOn!=='string'||typeof v.total!=='string'||
           typeof v.installments!=='number'||
           (v.merchant!==undefined&&v.merchant!==null&&typeof v.merchant!=='string')||
           (v.category!==undefined&&v.category!==null&&typeof v.category!=='string'))return error(400,'INVALID_BODY');
        let total;
        try{total=parseCents(v.total);}catch{return error(400,'INVALID_AMOUNT');}
        const purchase=await createPurchase(database,actor,{
          cardId:purchaseList![1]!,idempotencyKey:v.idempotencyKey,title:v.title,
          merchant:v.merchant as string|null|undefined,category:v.category as string|null|undefined,
          purchasedOn:v.purchasedOn,totalCents:total,installments:v.installments
        });
        return json(purchase,201);
      }
      return error(404,'NOT_FOUND');
    }
    if (method === 'GET' && path === '/api/obligations') {
      const query = requestURL.searchParams;
      const pagination = (name: string, fallback: number): number => {
        const raw = query.get(name);
        if (raw === null) return fallback;
        if (!/^(?:0|[1-9]\d{0,6})$/.test(raw)) throw new TypeError('Invalid pagination');
        return Number(raw);
      };
      return json({ obligations: await listObligations(database, actor, {
        limit: pagination('limit', 50), offset: pagination('offset', 0),
      }) });
    }
    const paymentPath = path.match(/^\/api\/obligations\/([0-9a-f-]{36})\/payments$/);
    if (method === 'GET' && paymentPath) {
      const obligationId = paymentPath[1]!;
      if (!await getObligation(database, actor, obligationId)) return error(404, 'NOT_FOUND');
      const query = requestURL.searchParams;
      const pagination = (name: string, fallback: number): number => {
        const raw = query.get(name);
        if (raw === null) return fallback;
        if (!/^(?:0|[1-9]\d{0,6})$/.test(raw)) throw new TypeError('Invalid pagination');
        return Number(raw);
      };
      return json({ payments: await listObligationPayments(database, actor, obligationId, {
        limit: pagination('limit', 50), offset: pagination('offset', 0),
      }) });
    }
    if (method === 'GET' && /^\/api\/obligations\/[0-9a-f-]{36}$/.test(path)) {
      const obligation = await getObligation(database, actor, path.slice('/api/obligations/'.length));
      return obligation ? json({ obligation }) : error(404, 'NOT_FOUND');
    }
    if (method === 'POST' && path === '/api/obligations') {
      if (!request.body) return error(400, 'INVALID_BODY');
      const bytes = await readBounded(request, 4096);
      if (bytes === null) return error(413, 'PAYLOAD_TOO_LARGE');
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { return error(400, 'INVALID_JSON'); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return error(400, 'INVALID_BODY');
      const value = raw as Record<string, unknown>;
      if (typeof value.idempotencyKey !== 'string' || typeof value.title !== 'string' ||
          typeof value.amount !== 'string' || typeof value.dueOn !== 'string' ||
          (value.category !== undefined && value.category !== null && typeof value.category !== 'string')) {
        return error(400, 'INVALID_BODY');
      }
      let amount;
      try { amount = parseCents(value.amount); }
      catch { return error(400, 'INVALID_AMOUNT'); }
      const obligation = await createObligation(database, actor, {
        idempotencyKey: value.idempotencyKey, title: value.title,
        category: value.category as string | null | undefined,
        totalCents: amount, dueOn: value.dueOn,
      });
      return json({ obligation }, 201);
    }
    if (method === 'POST' && paymentPath) {
      if (!request.body) return error(400, 'INVALID_BODY');
      const bytes = await readBounded(request, 4096);
      if (bytes === null) return error(413, 'PAYLOAD_TOO_LARGE');
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { return error(400, 'INVALID_JSON'); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return error(400, 'INVALID_BODY');
      const value = raw as Record<string, unknown>;
      if (typeof value.idempotencyKey !== 'string' || typeof value.accountId !== 'string' ||
          typeof value.amount !== 'string' || typeof value.paidOn !== 'string' ||
          (value.method !== 'cash' && value.method !== 'pix' &&
           value.method !== 'debit' && value.method !== 'bank_transfer')) {
        return error(400, 'INVALID_BODY');
      }
      let amount;
      try { amount = parseCents(value.amount); }
      catch { return error(400, 'INVALID_AMOUNT'); }
      const payment = await payObligation(database, actor, {
        idempotencyKey: value.idempotencyKey, obligationId: paymentPath[1]!,
        accountId: value.accountId, amountCents: amount, method: value.method,
        paidOn: value.paidOn,
      });
      return json({ payment }, 201);
    }
    if (method === 'GET' && path === '/api/accounts') {
      return json({ accounts: await listAccounts(database, actor) });
    }
    if (method === 'GET' && /^\/api\/accounts\/[0-9a-f-]{36}$/.test(path)) {
      const account = await getAccount(database, actor, path.slice('/api/accounts/'.length));
      return account ? json({ account }) : error(404, 'NOT_FOUND');
    }
    if (method === 'GET' && path === '/api/movements') {
      const query = requestURL.searchParams;
      const parsePage = (raw: string | null, fallback: number): number => {
        if (raw === null) return fallback;
        if (!/^(?:0|[1-9]\d{0,6})$/.test(raw)) throw new TypeError('Invalid pagination');
        return Number(raw);
      };
      const accountId = query.get('accountId');
      return json({ movements: await listMovements(database, actor, {
        accountId: accountId ?? undefined,
        limit: parsePage(query.get('limit'), 50),
        offset: parsePage(query.get('offset'), 0),
      }) });
    }
    if (method === 'GET' && /^\/api\/movements\/[0-9a-f-]{36}$/.test(path)) {
      const movement = await getMovement(database, actor, path.slice('/api/movements/'.length));
      return movement ? json({ movement }) : error(404, 'NOT_FOUND');
    }
    if (method === 'POST' && path === '/api/movements') {
      if (!request.body) return error(400, 'INVALID_BODY');
      const bodyBytes = await readBounded(request, 4096);
      if (bodyBytes === null) return error(413, 'PAYLOAD_TOO_LARGE');
      let data: unknown;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes)); }
      catch { return error(400, 'INVALID_JSON'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return error(400, 'INVALID_BODY');
      const v = data as Record<string, unknown>;
      if (typeof v.amount !== 'string' || typeof v.idempotencyKey !== 'string' ||
          typeof v.accountId !== 'string' || typeof v.description !== 'string' ||
          typeof v.occurredOn !== 'string' ||
          (v.direction !== 'income' && v.direction !== 'expense') ||
          (v.method !== 'cash' && v.method !== 'pix' && v.method !== 'debit' && v.method !== 'bank_transfer') ||
          (v.sourceLabel !== undefined && v.sourceLabel !== null && typeof v.sourceLabel !== 'string') ||
          (v.category !== undefined && v.category !== null && typeof v.category !== 'string')) {
        return error(400, 'INVALID_BODY');
      }
      let amount;
      try { amount = parseCents(v.amount); } catch { return error(400, 'INVALID_AMOUNT'); }
      const movement = await postMovement(database, actor, {
        accountId: v.accountId, idempotencyKey: v.idempotencyKey,
        direction: v.direction, amountCents: amount, method: v.method,
        description: v.description, occurredOn: v.occurredOn,
        sourceLabel: v.sourceLabel as string | null | undefined,
        category: v.category as string | null | undefined,
      });
      return json({ movement }, 201);
    }
    if (method === 'POST' && path === '/api/accounts') {
      // Financial API requests must be bounded. A forged Content-Length is not sufficient.
      if (!request.body) return error(400, 'INVALID_BODY');
      const bodyBytes = await readBounded(request, 4096);
      if (bodyBytes === null) return error(413, 'PAYLOAD_TOO_LARGE');
      let data: unknown;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes)); }
      catch { return error(400, 'INVALID_JSON'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return error(400, 'INVALID_BODY');
      const value = data as Record<string, unknown>;
      const f = value.funding;
      if (typeof value.idempotencyKey !== 'string' || typeof value.name !== 'string' ||
          (value.kind !== 'general' && value.kind !== 'bank' && value.kind !== 'cash') ||
          !f || typeof f !== 'object' || Array.isArray(f)) return error(400, 'INVALID_BODY');
      const funding = f as Record<string, unknown>;
      if (typeof funding.amount !== 'string' || (funding.mode !== 'external' && funding.mode !== 'reallocate')) {
        return error(400, 'INVALID_BODY');
      }
      let amount;
      try { amount = parseCents(funding.amount); }
      catch { return error(400, 'INVALID_AMOUNT'); }
      if (funding.mode === 'reallocate' && typeof funding.fromAccountId !== 'string') return error(400, 'INVALID_BODY');
      const result = await createAccount(database, actor, {
        idempotencyKey: value.idempotencyKey,
        name: value.name,
        kind: value.kind,
        funding: funding.mode === 'external'
          ? { mode: 'external', cents: amount }
          : { mode: 'reallocate', cents: amount, fromAccountId: funding.fromAccountId as string },
      });
      return json({ account: result }, 201);
    }
    return error(404, 'NOT_FOUND');
  } catch (cause) {
    // Do not disclose SQL errors, unique keys, customer names or IDs to clients.
    if(cause instanceof DebtRenegotiationUnavailable)return error(404,'NOT_FOUND');
    if(cause instanceof DebtRenegotiationConflict)return error(409,'CONFLICT');
    if(cause instanceof DebtRenegotiationTooLarge)return error(413,'RESULT_TOO_LARGE');
    if(cause instanceof LoanUnavailable)return error(404,'NOT_FOUND');
    if(cause instanceof LoanConflict)return error(409,'CONFLICT');
    if(cause instanceof PotentialNotApplicable)return error(404,'NOT_APPLICABLE');
    if(cause instanceof PotentialTooLarge)return error(413,'RESULT_TOO_LARGE');
    if(cause instanceof SimulationConflict)return error(409,'SIMULATION_STALE');
    if(cause instanceof SimulationTooLarge)return error(413,'RESULT_TOO_LARGE');
    if(cause instanceof IntentionUnavailable)return error(404,'NOT_FOUND');
    if(cause instanceof IntentionConflict)return error(409,'CONFLICT');
    if(cause instanceof PlanningTooLarge)return error(413,'RESULT_TOO_LARGE');
    if(cause instanceof WithholdingNotFound)return error(404,'NOT_FOUND');
    if(cause instanceof WithholdingConflict)return error(409,'CONFLICT');
    if(cause instanceof WithholdingNotApplicable)return error(409,'NOT_APPLICABLE');
    if(cause instanceof SalaryConflict)return error(409,'CONFLICT');
    if(cause instanceof SalaryNotApplicable)return error(409,'NOT_APPLICABLE');
    if(cause instanceof SalaryTooLarge)return error(413,'RESULT_TOO_LARGE');
    if(cause instanceof IncomeNotFound)return error(404,'NOT_FOUND');
    if(cause instanceof IncomeConflict)return error(409,'CONFLICT');
    if(cause instanceof IncomeTooLarge)return error(413,'RESULT_TOO_LARGE');
    if(cause instanceof WorkNotFound)return error(404,'NOT_FOUND');
    if(cause instanceof WorkConflict)return error(409,'CONFLICT');
    if (cause instanceof CreditCardUnavailable || cause instanceof CreditPurchaseUnavailable ||
      cause instanceof CreditInvoiceUnavailable) return error(404,'NOT_FOUND');
    if (cause instanceof CreditInvoiceInsufficient) return error(409,'INVOICE_OVERPAYMENT');
    if (cause instanceof CreditIdempotencyConflict) return error(409,'CONFLICT');
    if (cause instanceof CreditResultTooLarge) return error(413,'RESULT_TOO_LARGE');
    if (cause instanceof ReportAccountNotFound) return error(404,'NOT_FOUND');
    if (cause instanceof ReportTooLargeError) return error(413,'REPORT_TOO_LARGE');
    if (cause instanceof ReportReconciliationError) return error(409,'REPORT_NOT_CONSISTENT');
    if (cause instanceof TypeError || cause instanceof RangeError) return error(400, 'INVALID_REQUEST');
    if (cause instanceof Error && cause.message.startsWith('Idempotency key reused')) return error(409, 'CONFLICT');
    return error(409, 'OPERATION_REJECTED');
  }
}

async function readBounded(request: Request, max: number): Promise<Uint8Array | null> {
  const reader = request.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

// Backwards-compatible alias for the auth/accounts integration tests.
export const handleAccountsHttp = handleFinancialHttp;
