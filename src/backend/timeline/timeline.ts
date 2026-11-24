import type { AuthenticatedActor, FinancialDatabase } from '../accounts/accounts.ts';
import { assertCents } from '../../domain/money.ts';

export type TimelineStatus = 'realized' | 'pending' | 'overdue' | 'planned' | 'canceled';
export type TimelineKind = 'income' | 'expense' | 'payment' | 'refund' |
  'transfer' | 'obligation' | 'cancellation' | 'loan_disbursement' | 'loan_repayment' | 'loan_receivable';
export interface TimelineEvent {
  id: string;
  date: string;
  kind: TimelineKind;
  status: TimelineStatus;
  title: string;
  amountCents: number;
  accountId: string | null;
  obligationId: string | null;
  relatedId: string | null;
}
export interface TimelineOptions {
  from: string; to: string; asOf: string;
  // HTTP supplies a string; checkOptions rejects all unknown statuses.
  status?: string;
  limit?: number; offset?: number;
}
export interface TimelinePage {
  events: TimelineEvent[];
  hasMore: boolean;
  limit: number;
  offset: number;
}
export type AlertLevel = 'D-10' | 'D-5' | 'overdue';
export interface DueAlert {
  // Existing ordinary bills keep obligationId; credit invoices use a synthetic
  // "card-invoice:" key and explicit cardId/cycle to route the user safely.
  obligationId: string;
  title: string;
  dueOn: string;
  outstandingCents: number;
  daysUntil: number;
  level: AlertLevel;
  cardId?: string;
  cycle?: string;
}
export interface AlertPage {
  alerts: DueAlert[];
  hasMore: boolean;
  limit: number;
  offset: number;
  asOf: string;
}
interface EventRow {
  event_id: string; event_date: string; event_kind: TimelineKind;
  event_status: TimelineStatus; title: string; amount_cents: number;
  account_id: string | null; obligation_id: string | null; related_id: string | null;
}
interface AlertRow {
  obligation_id: string; title: string; due_on: string;
  outstanding_cents: number; card_id: string | null; invoice_cycle: string | null;
}
const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const statuses = new Set<string>(['all', 'realized', 'pending', 'overdue', 'planned', 'canceled']);

export function validateDate(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !DATE.test(value)) throw new TypeError('Invalid calendar date');
  const [year, month, day] = value.split('-').map(Number);
  if (!year || year < 1000 || year > 9999 || !month || !day) throw new TypeError('Invalid calendar date');
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) {
    throw new TypeError('Invalid calendar date');
  }
}
export function daysBetween(asOf: string, dueOn: string): number {
  validateDate(asOf); validateDate(dueOn);
  const timestamp = (value: string) => {
    const y = Number(value.slice(0,4)), m = Number(value.slice(5,7)), d = Number(value.slice(8,10));
    return Date.UTC(y, m - 1, d);
  };
  return (timestamp(dueOn) - timestamp(asOf)) / 86_400_000;
}
function owner(actor: AuthenticatedActor): string {
  if (!actor || typeof actor.userId !== 'string' || !actor.userId.trim() || actor.userId.length > 128) {
    throw new TypeError('Verified session required');
  }
  return actor.userId;
}
function page(limit: number, offset: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new TypeError('Invalid pagination');
  }
}
function checkOptions(options: TimelineOptions) {
  if (!options || typeof options !== 'object') throw new TypeError('Timeline parameters required');
  validateDate(options.from); validateDate(options.to); validateDate(options.asOf);
  if (options.from > options.to) throw new TypeError('Invalid timeline range');
  const status = options.status ?? 'all';
  if (!statuses.has(status)) throw new TypeError('Invalid timeline status');
  const limit = options.limit ?? 30, offset = options.offset ?? 0;
  page(limit, offset);
  return { status, limit, offset };
}

/**
 * A single owner-scoped SQL statement produces the ledger chronology.
 *
 * Payment cash expense appears ONCE (as "payment", never a second expense).
 * Refund credit appears ONCE (as "refund", never an earned income).
 * A transfer appears ONCE, neutral to income and expense.
 *
 * Only outstanding, uncanceled obligations have future/pending due events.
 * A canceled obligation generates an historical cancellation event instead.
 * No speculative salary/receipt or unsaved purchase intention is fabricated.
 */
const EVENT_SQL = [
  'WITH loan_events(event_id,event_date,event_kind,event_status,title,amount_cents,account_id,obligation_id,related_id,created_at) AS (',
  " SELECT 'loan:' || l.loan_id, l.lent_on, 'loan_disbursement', 'realized',",
  " 'Empréstimo concedido: ' || l.borrower, l.principal_cents,",
  ' l.source_account_id, NULL, l.loan_id, l.created_at',
  ' FROM personal_loans l WHERE l.owner_user_id = ?',
  ' UNION ALL',
  " SELECT 'loan-repayment:' || r.repayment_id, r.received_on, 'loan_repayment', 'realized',",
  " 'Devolução de principal: ' || l.borrower, r.amount_cents,",
  ' r.destination_account_id, NULL, r.loan_id, r.created_at',
  ' FROM personal_loan_repayments r JOIN personal_loans l',
  ' ON l.owner_user_id=r.owner_user_id AND l.loan_id=r.loan_id',
  ' WHERE r.owner_user_id = ?',
  ' UNION ALL',
  " SELECT 'loan-receivable:' || l.loan_id, l.due_on, 'loan_receivable',",
  " CASE WHEN l.due_on > ? THEN 'planned' WHEN l.due_on < ? THEN 'overdue' ELSE 'pending' END,",
  " 'A receber de: ' || l.borrower, l.outstanding_cents, NULL, NULL, l.loan_id, l.created_at",
  ' FROM personal_loan_balances l',
  ' WHERE l.owner_user_id=? AND l.outstanding_cents>0',
  '),',
  'account_events AS (',
  " SELECT 'movement:' || m.movement_id AS event_id,",
  ' m.occurred_on AS event_date,',
  " CASE WHEN r.refund_id IS NOT NULL THEN 'refund'",
  "      WHEN p.payment_id IS NOT NULL OR cp.payment_id IS NOT NULL OR rp.payment_id IS NOT NULL THEN 'payment'",
  '      ELSE m.direction END AS event_kind,',
  " 'realized' AS event_status, m.description AS title,",
  ' m.amount_cents AS amount_cents, m.account_id AS account_id,',
  ' p.obligation_id AS obligation_id, r.original_movement_id AS related_id,',
  ' m.created_at AS created_at',
  ' FROM posted_cash_movements m',
  ' LEFT JOIN cash_refunds r ON r.owner_user_id = m.owner_user_id',
  '   AND r.refund_movement_id = m.movement_id',
  ' LEFT JOIN financial_obligation_payments p ON p.owner_user_id = m.owner_user_id',
  '   AND p.movement_id = m.movement_id',
  ' LEFT JOIN card_invoice_payments cp ON cp.owner_user_id = m.owner_user_id',
  '   AND cp.movement_id = m.movement_id',
  ' LEFT JOIN debt_renegotiation_payments rp ON rp.owner_user_id = m.owner_user_id',
  '   AND rp.movement_id = m.movement_id',
  ' WHERE m.owner_user_id = ?',
  ' UNION ALL',
  " SELECT 'transfer:' || t.transfer_id, t.transferred_on,",
  " 'transfer', 'realized',",
  " COALESCE(t.note, 'Transferência entre contas próprias'), t.amount_cents,",
  ' t.source_account_id, NULL, t.target_account_id, t.created_at',
  ' FROM internal_transfers t WHERE t.owner_user_id = ?',
  ' UNION ALL',
  " SELECT 'obligation:' || o.obligation_id, o.due_on,",
  " 'obligation', CASE WHEN o.due_on > ? THEN 'planned' WHEN o.due_on < ? THEN 'overdue' ELSE 'pending' END,",
  ' o.title, o.outstanding_cents, NULL, o.obligation_id, NULL, o.created_at',
  ' FROM financial_obligation_balances o',
  ' WHERE o.owner_user_id = ? AND o.outstanding_cents > 0 AND o.cancellation_id IS NULL',
  ' AND NOT EXISTS(SELECT 1 FROM debt_renegotiations a WHERE a.owner_user_id=o.owner_user_id AND a.obligation_id=o.obligation_id)',
  ' UNION ALL',
  " SELECT 'card-invoice:' || v.card_id || ':' || v.invoice_cycle, v.due_on,",
  " 'obligation', CASE WHEN v.due_on > ? THEN 'planned' WHEN v.due_on < ? THEN 'overdue' ELSE 'pending' END,",
  " 'Fatura: ' || c.display_name || ' (' || v.invoice_cycle || ')',",
  ' v.outstanding_cents, NULL, NULL, v.card_id, c.created_at',
  ' FROM credit_invoice_balances v',
  ' JOIN credit_cards c ON c.owner_user_id = v.owner_user_id AND c.card_id = v.card_id',
  ' WHERE v.owner_user_id = ? AND v.outstanding_cents > 0',
  ' AND NOT EXISTS(SELECT 1 FROM debt_renegotiations a WHERE a.owner_user_id=v.owner_user_id AND a.card_id=v.card_id AND a.invoice_cycle=v.invoice_cycle)',
  ' UNION ALL',
  " SELECT 'cancellation:' || c.cancellation_id, c.canceled_on,",
  " 'cancellation', 'canceled', o.title, 0, NULL, c.obligation_id, NULL, c.created_at",
  ' FROM obligation_cancellations c',
  ' JOIN financial_obligations o ON o.owner_user_id = c.owner_user_id',
  '   AND o.obligation_id = c.obligation_id',
  ' WHERE c.owner_user_id = ?',
  '),',
  'renegotiation_events AS (',
  " SELECT 'renegotiation:' || i.agreement_id || ':' || i.installment_no, i.due_on,",
  " 'obligation', CASE WHEN i.due_on > ? THEN 'planned' WHEN i.due_on < ? THEN 'overdue' ELSE 'pending' END,",
  " 'Acordo: parcela ' || i.installment_no || ' de ' || json_array_length(a.schedule_json),",
  ' i.outstanding_cents, NULL, NULL, i.agreement_id, a.created_at',
  ' FROM debt_renegotiation_installment_balances i',
  ' JOIN debt_renegotiations a ON a.owner_user_id=i.owner_user_id AND a.agreement_id=i.agreement_id',
  ' WHERE i.owner_user_id=? AND i.outstanding_cents>0',
  '),',
  'all_events AS (',
  ' SELECT event_id,event_date,event_kind,event_status,title,amount_cents,account_id,obligation_id,related_id,created_at FROM account_events',
  ' UNION ALL',
  ' SELECT event_id,event_date,event_kind,event_status,title,amount_cents,account_id,obligation_id,related_id,created_at FROM loan_events',
  ' UNION ALL',
  ' SELECT event_id,event_date,event_kind,event_status,title,amount_cents,account_id,obligation_id,related_id,created_at FROM renegotiation_events',
  ')',
  'SELECT event_id, event_date, event_kind, event_status, title, amount_cents,',
  ' account_id, obligation_id, related_id',
  ' FROM all_events WHERE event_date BETWEEN ? AND ?',
  " AND (? = 'all' OR event_status = ?)",
  // A selected account includes both legs of a transfer, but an unassigned
  // obligation is never silently attributed to an account.
  " AND (? IS NULL OR account_id = ? OR (event_kind = 'transfer' AND related_id = ?))",
  // The approved rail reads left-to-right chronologically within the month.
  ' ORDER BY event_date ASC, created_at ASC, event_id ASC',
  ' LIMIT ? OFFSET ?',
].join('\n');

export async function listTimeline(db: FinancialDatabase, actor: AuthenticatedActor,
  options: TimelineOptions): Promise<TimelinePage> {
  const who = owner(actor), { status, limit, offset } = checkOptions(options);
  const rows = await db.prepare(EVENT_SQL).bind(
    who, who, options.asOf, options.asOf, who, who, who, options.asOf, options.asOf, who, options.asOf, options.asOf, who, who, options.asOf, options.asOf, who,
    options.from, options.to, status, status, null, null, null, limit + 1, offset,
  ).all<EventRow>();
  const events = rows.results.slice(0, limit).map((r): TimelineEvent => {
    assertCents(r.amount_cents);
    if (!r.event_id || !r.title || !statuses.has(r.event_status)) {
      throw new Error('Inconsistent timeline event');
    }
    return {
      id: r.event_id, date: r.event_date, kind: r.event_kind, status: r.event_status,
      title: r.title, amountCents: r.amount_cents,
      accountId: r.account_id, obligationId: r.obligation_id, relatedId: r.related_id,
    };
  });
  return { events, hasMore: rows.results.length > limit, limit, offset };
}

/**
 * In-app attention bands: D-10 on days 10..6, D-5 on days 5..0;
 * overdue remains explicitly overdue. Paid/canceled obligations never alert.
 *
 * All calculations use UTC arithmetic on ISO civil dates, not UTC clock hours.
 * The UI supplies a local civil asOf date; callers cannot authorize another
 * owner's data or cause a financial mutation by changing that display date.
 */
export async function listDueAlerts(db: FinancialDatabase, actor: AuthenticatedActor,
  options: { asOf: string; limit?: number; offset?: number }): Promise<AlertPage> {
  const who = owner(actor);
  if (!options) throw new TypeError('Alert options required');
  validateDate(options.asOf);
  const limit = options.limit ?? 20, offset = options.offset ?? 0;
  page(limit, offset);
  const rows = await db.prepare([
    'SELECT d.due_id AS obligation_id,',
    " CASE WHEN o.obligation_id IS NOT NULL THEN o.title",
    " WHEN v.card_id IS NOT NULL THEN 'Fatura: ' || c.display_name || ' (' || v.invoice_cycle || ')'",
    " ELSE 'Acordo: parcela ' || r.installment_no END AS title,",
    ' d.due_on,d.outstanding_cents,v.card_id,v.invoice_cycle',
    ' FROM financial_active_due_items d',
    " LEFT JOIN financial_obligations o ON o.owner_user_id=d.owner_user_id AND d.due_id='obligation:'||o.obligation_id",
    ' LEFT JOIN credit_invoice_balances v ON v.owner_user_id=d.owner_user_id',
    "   AND d.due_id='card-invoice:'||v.card_id||':'||v.invoice_cycle",
    ' LEFT JOIN credit_cards c ON c.owner_user_id=v.owner_user_id AND c.card_id=v.card_id',
    ' LEFT JOIN debt_renegotiation_installment_balances r ON r.owner_user_id=d.owner_user_id',
    "   AND d.due_id='renegotiation:'||r.agreement_id||':'||r.installment_no",
    " WHERE d.owner_user_id=? AND d.due_on<=date(?,'+10 days')",
    ' ORDER BY CASE WHEN d.due_on < ? THEN 1 ELSE 0 END ASC,',
    ' CASE WHEN d.due_on >= ? THEN d.due_on END ASC,',
    ' CASE WHEN d.due_on < ? THEN d.due_on END DESC,d.due_id ASC',
    ' LIMIT ? OFFSET ?',
  ].join(' ')).bind(who,options.asOf,options.asOf,options.asOf,options.asOf,
    limit+1,offset).all<AlertRow>();
  const alerts = rows.results.slice(0, limit).map((row): DueAlert => {
    assertCents(row.outstanding_cents);
    const daysUntil = daysBetween(options.asOf, row.due_on);
    return {
      obligationId: row.obligation_id.startsWith('obligation:') ? row.obligation_id.slice('obligation:'.length) : row.obligation_id,
      title: row.title,
      dueOn: row.due_on, outstandingCents: row.outstanding_cents,
      daysUntil, level: daysUntil < 0 ? 'overdue' : daysUntil <= 5 ? 'D-5' : 'D-10',
      ...(row.card_id && row.invoice_cycle ? {cardId:row.card_id,cycle:row.invoice_cycle} : {}),
    };
  });
  return { alerts, hasMore: rows.results.length > limit, limit, offset, asOf: options.asOf };
}


export class ReportTooLargeError extends Error {
  constructor() { super('REPORT_TOO_LARGE'); this.name = 'ReportTooLargeError'; }
}
/** One SQLite/D1 SELECT: obtain a complete, globally ordered, owner-scoped
 *  export snapshot or reject over the bound. Never export a partial page.
 *  accountId is separately owner-authorized by the HTTP controller.
 */
export async function readExportTimeline(
  db: FinancialDatabase, actor: AuthenticatedActor,
  options: Pick<TimelineOptions,'from'|'to'|'asOf'|'status'> & { accountId?: string },
  maxEvents = 2000,
): Promise<TimelineEvent[]> {
  const who = owner(actor);
  const { status } = checkOptions({ ...options, limit:100, offset:0 });
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 2000) {
    throw new TypeError('Invalid report limit');
  }
  const account = options.accountId ?? null;
  if (account !== null && !/^[0-9a-f-]{36}$/.test(account)) {
    throw new TypeError('Invalid account id');
  }
  const rows = await db.prepare(EVENT_SQL).bind(
    who, who, options.asOf, options.asOf, who, who, who, options.asOf, options.asOf, who, options.asOf, options.asOf, who, who, options.asOf, options.asOf, who,
    options.from, options.to, status, status, account, account, account,
    maxEvents + 1, 0,
  ).all<EventRow>();
  if (rows.results.length > maxEvents) throw new ReportTooLargeError();
  return rows.results.map(r=>{
    assertCents(r.amount_cents);
    if (!r.event_id || !r.title || !statuses.has(r.event_status) ||
        !['income','expense','payment','refund','transfer','obligation','cancellation','loan_disbursement','loan_repayment','loan_receivable'].includes(r.event_kind)) {
      throw new Error('Inconsistent timeline event');
    }
    return {
      id:r.event_id, date:r.event_date,kind:r.event_kind,status:r.event_status,
      title:r.title,amountCents:r.amount_cents,accountId:r.account_id,
      obligationId:r.obligation_id,relatedId:r.related_id,
    };
  });
}
