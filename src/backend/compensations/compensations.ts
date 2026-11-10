import { assertCents, type Cents } from '../../domain/money.ts';
import type { AuthenticatedActor, FinancialDatabase } from '../accounts/accounts.ts';
import { getMovement } from '../movements/movements.ts';
import type { PaymentMethod } from '../movements/movements.ts';

export interface CancelObligationInput {
  idempotencyKey: string;
  obligationId: string;
  canceledOn: string;
  reason?: string | null;
}
export interface ObligationCancellationView {
  cancellationId: string;
  obligationId: string;
  canceledOn: string;
  reason: string | null;
  createdAt: string;
}
export interface RefundExpenseInput {
  idempotencyKey: string;
  originalMovementId: string;
  accountId: string;
  amountCents: Cents;
  method: PaymentMethod;
  refundedOn: string;
  reason?: string | null;
}
export interface ExpenseRefundView {
  refundId: string;
  originalMovementId: string;
  refundMovementId: string;
  accountId: string;
  obligationId: string | null;
  amountCents: Cents;
  method: PaymentMethod;
  refundedOn: string;
  reason: string | null;
  createdAt: string;
}
export interface RefundFilter {
  originalMovementId?: string;
  limit?: number;
  offset?: number;
}
interface CancellationRow {
  cancellation_id: string;
  creation_key: string;
  obligation_id: string;
  canceled_on: string;
  reason: string | null;
  created_at: string;
}
interface RefundRow {
  refund_id: string;
  creation_key: string;
  original_movement_id: string;
  refund_movement_id: string;
  account_id: string;
  obligation_id: string | null;
  amount_cents: number;
  payment_method: PaymentMethod;
  refunded_on: string;
  reason: string | null;
  created_at: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{12,128}$/;
const REFUND_SQL = 'SELECT r.*, m.account_id, m.payment_method, p.obligation_id ' +
  'FROM cash_refunds r ' +
  'JOIN posted_cash_movements m ON m.owner_user_id = r.owner_user_id AND m.movement_id = r.refund_movement_id ' +
  'LEFT JOIN financial_obligation_payments p ON p.owner_user_id = r.owner_user_id ' +
  'AND p.movement_id = r.original_movement_id';

function requireOwner(actor: AuthenticatedActor): string {
  if (!actor || typeof actor.userId !== 'string' ||
      !actor.userId.trim() || actor.userId.length > 128) {
    throw new TypeError('Verified session required');
  }
  return actor.userId;
}
function checkKey(value: unknown): void {
  if (typeof value !== 'string' || !KEY.test(value)) {
    throw new TypeError('Invalid idempotency key');
  }
}
function checkId(value: unknown): void {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError('Invalid resource ID');
  }
}
function checkCivilDate(value: unknown): void {
  if (typeof value !== 'string' ||
      !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value)) {
    throw new TypeError('Invalid business date');
  }
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined ||
      year < 1000 || year > 9999) throw new TypeError('Invalid business date');
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (actual.getUTCFullYear() !== year || actual.getUTCMonth() + 1 !== month ||
      actual.getUTCDate() !== day) throw new TypeError('Invalid business date');
}
function normalizeReason(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 ||
      /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('Invalid reason');
  return value.trim();
}
function checkPage(limit: number, offset: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new TypeError('Invalid pagination');
  }
}
function cancelView(row: CancellationRow): ObligationCancellationView {
  return {
    cancellationId: row.cancellation_id,
    obligationId: row.obligation_id,
    canceledOn: row.canceled_on,
    reason: row.reason,
    createdAt: row.created_at,
  };
}
function refundView(row: RefundRow): ExpenseRefundView {
  assertCents(row.amount_cents);
  return {
    refundId: row.refund_id,
    originalMovementId: row.original_movement_id,
    refundMovementId: row.refund_movement_id,
    accountId: row.account_id,
    obligationId: row.obligation_id,
    amountCents: row.amount_cents,
    method: row.payment_method,
    refundedOn: row.refunded_on,
    reason: row.reason,
    createdAt: row.created_at,
  };
}
export async function getObligationCancellation(
  db: FinancialDatabase, actor: AuthenticatedActor, obligationId: string,
): Promise<ObligationCancellationView | null> {
  const owner = requireOwner(actor);
  const found = await db.prepare(
    'SELECT * FROM obligation_cancellations WHERE owner_user_id = ? AND obligation_id = ?',
  ).bind(owner, obligationId).first<CancellationRow>();
  return found ? cancelView(found) : null;
}
export async function cancelUnpaidObligation(
  db: FinancialDatabase, actor: AuthenticatedActor, input: CancelObligationInput,
  clock: () => Date = () => new Date(),
): Promise<ObligationCancellationView> {
  const owner = requireOwner(actor);
  if (!input || typeof input !== 'object') throw new TypeError('Invalid cancellation');
  checkKey(input.idempotencyKey);
  checkId(input.obligationId);
  checkCivilDate(input.canceledOn);
  const reason = normalizeReason(input.reason);
  const replay = async (): Promise<ObligationCancellationView | null> => {
    const row = await db.prepare(
      'SELECT * FROM obligation_cancellations WHERE owner_user_id = ? AND creation_key = ?',
    ).bind(owner, input.idempotencyKey).first<CancellationRow>();
    if (!row) return null;
    if (row.obligation_id !== input.obligationId ||
        row.canceled_on !== input.canceledOn || row.reason !== reason) {
      throw new Error('Idempotency conflict');
    }
    return cancelView(row);
  };
  const existing = await replay();
  if (existing) return existing;
  const cancellationId = crypto.randomUUID();
  try {
    await db.prepare(
      'INSERT INTO obligation_cancellations ' +
      '(owner_user_id, cancellation_id, creation_key, obligation_id, canceled_on, reason, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(owner, cancellationId, input.idempotencyKey, input.obligationId,
      input.canceledOn, reason, clock().toISOString()).run();
  } catch (cause) {
    const committed = await replay();
    if (committed) return committed;
    throw cause;
  }
  const result = await getObligationCancellation(db, actor, input.obligationId);
  if (!result) throw new Error('Cancellation was not persisted');
  return result;
}
export async function getExpenseRefund(
  db: FinancialDatabase, actor: AuthenticatedActor, refundId: string,
): Promise<ExpenseRefundView | null> {
  const owner = requireOwner(actor);
  const found = await db.prepare(
    REFUND_SQL + ' WHERE r.owner_user_id = ? AND r.refund_id = ?',
  ).bind(owner, refundId).first<RefundRow>();
  return found ? refundView(found) : null;
}
export async function listExpenseRefunds(
  db: FinancialDatabase, actor: AuthenticatedActor, filter: RefundFilter = {},
): Promise<ExpenseRefundView[]> {
  const owner = requireOwner(actor);
  const { originalMovementId, limit = 50, offset = 0 } = filter;
  if (originalMovementId !== undefined) checkId(originalMovementId);
  checkPage(limit, offset);
  const rows = await db.prepare(
    REFUND_SQL + ' WHERE r.owner_user_id = ? AND (? IS NULL OR r.original_movement_id = ?) ' +
    'ORDER BY r.refunded_on DESC, r.created_at DESC, r.refund_id DESC LIMIT ? OFFSET ?',
  ).bind(owner, originalMovementId ?? null, originalMovementId ?? null, limit, offset).all<RefundRow>();
  return rows.results.map(refundView);
}
export async function refundPaidExpense(
  db: FinancialDatabase, actor: AuthenticatedActor, input: RefundExpenseInput,
  clock: () => Date = () => new Date(),
): Promise<ExpenseRefundView> {
  const owner = requireOwner(actor);
  if (!input || typeof input !== 'object') throw new TypeError('Invalid refund');
  checkKey(input.idempotencyKey);
  checkId(input.originalMovementId);
  checkId(input.accountId);
  assertCents(input.amountCents);
  if (input.amountCents === 0) throw new RangeError('Refund must be positive');
  if (!['cash', 'pix', 'debit', 'bank_transfer'].includes(input.method)) {
    throw new TypeError('Invalid refund receipt method');
  }
  checkCivilDate(input.refundedOn);
  const reason = normalizeReason(input.reason);
  const replay = async (): Promise<ExpenseRefundView | null> => {
    const row = await db.prepare(
      REFUND_SQL + ' WHERE r.owner_user_id = ? AND r.creation_key = ?',
    ).bind(owner, input.idempotencyKey).first<RefundRow>();
    if (!row) return null;
    if (row.original_movement_id !== input.originalMovementId ||
        row.account_id !== input.accountId || row.amount_cents !== input.amountCents ||
        row.payment_method !== input.method || row.refunded_on !== input.refundedOn ||
        row.reason !== reason) {
      throw new Error('Idempotency conflict');
    }
    return refundView(row);
  };
  const prior = await replay();
  if (prior) return prior;

  const original = await getMovement(db, actor, input.originalMovementId);
  if (!original || original.direction !== 'expense') {
    throw new Error('Original expense unavailable');
  }
  if (input.refundedOn < original.occurredOn) throw new TypeError('Refund precedes expense');
  const refundId = crypto.randomUUID(), movementId = crypto.randomUUID();
  const now = clock().toISOString();
  const creditKey = 'cash-refund:' + input.idempotencyKey;
  try {
    await db.batch([
      db.prepare(
        'INSERT INTO posted_cash_movements ' +
        '(owner_user_id, movement_id, creation_key, account_id, direction, amount_cents, ' +
        'payment_method, description, source_label, category, occurred_on, created_at) ' +
        "VALUES (?, ?, ?, ?, 'income', ?, ?, ?, NULL, ?, ?, ?)",
      ).bind(owner, movementId, creditKey, input.accountId, input.amountCents,
        input.method, ('Reembolso: ' + original.description).slice(0, 120),
        original.category, input.refundedOn, now),
      db.prepare(
        'INSERT INTO cash_refunds ' +
        '(owner_user_id, refund_id, creation_key, original_movement_id, ' +
        'refund_movement_id, amount_cents, refunded_on, reason, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(owner, refundId, input.idempotencyKey, input.originalMovementId,
        movementId, input.amountCents, input.refundedOn, reason, now),
    ]);
  } catch (cause) {
    const committed = await replay();
    if (committed) return committed;
    throw cause;
  }
  const result = await getExpenseRefund(db, actor, refundId);
  if (!result) throw new Error('Refund was not persisted');
  return result;
}
