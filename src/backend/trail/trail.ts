import { assertCents } from '../../domain/money.ts';
import type { AuthenticatedActor, FinancialDatabase } from '../accounts/accounts.ts';

export type TrailStatus = 'realized' | 'pending' | 'overdue' | 'canceled';
export type TrailKind = 'income' | 'expense' | 'refund' | 'payment' | 'transfer' | 'obligation' | 'cancellation';
export type TrailFilter = 'all' | TrailStatus | 'scheduled';
export interface TrailQuery { from: string; to: string; asOf: string; status?: TrailFilter; limit?: number; offset?: number }
export interface TrailEvent {
  id: string; kind: TrailKind; status: TrailStatus; timing: 'actual' | 'scheduled';
  date: string; title: string; amountCents: number;
  accountId: string | null; obligationId: string | null; relatedMovementId: string | null;
}
export interface TrailPage {
  events: TrailEvent[]; hasMore: boolean; limit: number; offset: number;
  period: { from: string; to: string }; asOf: string; status: TrailFilter;
}
export interface DueAlert {
  obligationId: string; title: string; dueOn: string; outstandingCents: number;
  daysUntilDue: number; stage: 'D-10' | 'D-5' | 'TODAY';
}
export interface DueAlertPage { alerts: DueAlert[]; hasMore: boolean; asOf: string; limit: number; offset: number }
interface EventRow {
  id: string; kind: TrailKind; status: TrailStatus; timing: 'actual' | 'scheduled';
  event_date: string; title: string; amount_cents: number;
  account_id: string | null; obligation_id: string | null;
  related_movement_id: string | null; created_at: string;
}
interface AlertRow {
  obligation_id: string; title: string; due_on: string;
  outstanding_cents: number; days_until_due: number;
}
const STATUS: TrailFilter[] = ['all', 'realized', 'pending', 'overdue', 'canceled', 'scheduled'];

export function checkCivilDate(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value)) {
    throw new TypeError('Invalid civil date');
  }
  const [year, month, day] = value.split('-').map(Number);
  if (!year || year < 1000 || year > 9999 || !month || !day) throw new TypeError('Invalid civil date');
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (actual.getUTCFullYear() !== year || actual.getUTCMonth() + 1 !== month ||
      actual.getUTCDate() !== day) throw new TypeError('Invalid civil date');
}
function ownerOf(actor: AuthenticatedActor): string {
  if (!actor || typeof actor.userId !== 'string' || !actor.userId.trim() || actor.userId.length > 128) {
    throw new TypeError('Verified session required');
  }
  return actor.userId;
}
function pagination(limit = 40, offset = 0): { limit: number; offset: number } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new TypeError('Invalid pagination');
  }
  return { limit, offset };
}
function eventView(row: EventRow): TrailEvent {
  if (!['income','expense','refund','payment','transfer','obligation','cancellation'].includes(row.kind) ||
      !['realized','pending','overdue','canceled'].includes(row.status) ||
      !['actual','scheduled'].includes(row.timing)) throw new TypeError('Invalid event');
  if (row.kind === 'cancellation') {
    if (row.amount_cents !== 0) throw new RangeError('Canceled event cannot create money');
  } else {
    assertCents(row.amount_cents);
    if (row.amount_cents === 0) throw new RangeError('Invalid event amount');
  }
  return {
    id: row.id, kind: row.kind, status: row.status, timing: row.timing,
    date: row.event_date, title: row.title, amountCents: row.amount_cents,
    accountId: row.account_id, obligationId: row.obligation_id,
    relatedMovementId: row.related_movement_id,
  };
}
// One UNION query, GLOBAL sort and pagination: per-source pagination loses events.
// Each arm constrains owner_user_id from the verified Better Auth session.
const TRAIL_SQL = [
'WITH events AS (',
' SELECT m.movement_id AS id,',
" CASE WHEN r.refund_id IS NOT NULL THEN 'refund'",
"      WHEN p.payment_id IS NOT NULL THEN 'payment'",
'      ELSE m.direction END AS kind,',
" 'realized' AS status, 'actual' AS timing,",
' m.occurred_on AS event_date, m.description AS title,',
' m.amount_cents, m.account_id, p.obligation_id,',
' r.original_movement_id AS related_movement_id, m.created_at',
' FROM posted_cash_movements m',
' LEFT JOIN cash_refunds r ON r.owner_user_id = m.owner_user_id AND r.refund_movement_id = m.movement_id',
' LEFT JOIN financial_obligation_payments p ON p.owner_user_id = m.owner_user_id AND p.movement_id = m.movement_id',
' WHERE m.owner_user_id = ?',
' UNION ALL',
" SELECT t.transfer_id, 'transfer', 'realized', 'actual', t.transferred_on,",
" COALESCE(t.note, 'Transferência entre contas'), t.amount_cents,",
' t.source_account_id, NULL, NULL, t.created_at',
' FROM internal_transfers t WHERE t.owner_user_id = ?',
' UNION ALL',
' SELECT o.obligation_id,',
" 'obligation', CASE WHEN o.due_on < ? THEN 'overdue' ELSE 'pending' END,",
" 'scheduled', o.due_on, o.title, o.outstanding_cents,",
' NULL, o.obligation_id, NULL, o.created_at',
' FROM financial_obligation_balances o',
' WHERE o.owner_user_id = ? AND o.outstanding_cents > 0',
' UNION ALL',
" SELECT c.cancellation_id, 'cancellation', 'canceled', 'actual',",
" c.canceled_on, ('Cancelamento: ' || o.title), 0,",
' NULL, c.obligation_id, NULL, c.created_at',
' FROM obligation_cancellations c',
' JOIN financial_obligations o ON o.owner_user_id = c.owner_user_id AND o.obligation_id = c.obligation_id',
' WHERE c.owner_user_id = ?',
')',
'SELECT id, kind, status, timing, event_date, title, amount_cents,',
' account_id, obligation_id, related_movement_id, created_at',
' FROM events WHERE event_date BETWEEN ? AND ?',
" AND (? = 'all' OR (? = 'scheduled' AND timing = 'scheduled') OR status = ?)",
' ORDER BY event_date ASC, created_at ASC, kind ASC, id ASC',
' LIMIT ? OFFSET ?',
].join('\n');

export async function listTrail(db: FinancialDatabase, actor: AuthenticatedActor, query: TrailQuery): Promise<TrailPage> {
  const owner = ownerOf(actor);
  if (!query || typeof query !== 'object') throw new TypeError('Query required');
  checkCivilDate(query.from); checkCivilDate(query.to); checkCivilDate(query.asOf);
  if (query.from > query.to) throw new TypeError('Reversed period');
  const status = query.status ?? 'all';
  if (!STATUS.includes(status)) throw new TypeError('Invalid status filter');
  const { limit, offset } = pagination(query.limit, query.offset);
  const rows = await db.prepare(TRAIL_SQL).bind(
    owner, owner, query.asOf, owner, owner,
    query.from, query.to, status, status, status, limit + 1, offset,
  ).all<EventRow>();
  return {
    events: rows.results.slice(0, limit).map(eventView),
    hasMore: rows.results.length > limit,
    limit, offset, asOf: query.asOf, status,
    period: { from: query.from, to: query.to },
  };
}
const ALERT_SQL = [
'SELECT o.obligation_id, o.title, o.due_on, o.outstanding_cents,',
' CAST(julianday(o.due_on) - julianday(?) AS INTEGER) AS days_until_due',
' FROM financial_obligation_balances o',
' WHERE o.owner_user_id = ? AND o.outstanding_cents > 0',
" AND o.due_on >= ? AND o.due_on <= date(?, '+10 days')",
' ORDER BY o.due_on ASC, o.obligation_id ASC',
' LIMIT ? OFFSET ?',
].join('\n');

export async function listDueAlerts(
  db: FinancialDatabase, actor: AuthenticatedActor,
  options: { asOf: string; limit?: number; offset?: number },
): Promise<DueAlertPage> {
  const owner = ownerOf(actor);
  if (!options || typeof options !== 'object') throw new TypeError('Query required');
  checkCivilDate(options.asOf);
  const { limit, offset } = pagination(options.limit, options.offset);
  const rows = await db.prepare(ALERT_SQL)
    .bind(options.asOf, owner, options.asOf, options.asOf, limit + 1, offset)
    .all<AlertRow>();
  return {
    alerts: rows.results.slice(0,limit).map(row=>{
      assertCents(row.outstanding_cents);
      if (!Number.isInteger(row.days_until_due) || row.days_until_due < 0 || row.days_until_due > 10) {
        throw new RangeError('Invalid due-date distance');
      }
      return {
        obligationId: row.obligation_id, title: row.title, dueOn: row.due_on,
        outstandingCents: row.outstanding_cents, daysUntilDue: row.days_until_due,
        stage: row.days_until_due === 0 ? 'TODAY' : row.days_until_due <= 5 ? 'D-5' : 'D-10',
      };
    }),
    hasMore: rows.results.length > limit, asOf: options.asOf, limit, offset,
  };
}
