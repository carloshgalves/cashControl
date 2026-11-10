import { assertCents, MAX_CENTS, type Cents } from '../../domain/money.ts';
import type { AuthenticatedActor, FinancialDatabase } from '../accounts/accounts.ts';

export type MovementDirection = 'income' | 'expense';
export type PaymentMethod = 'cash' | 'pix' | 'debit' | 'bank_transfer';
export interface PostMovementRequest {
  idempotencyKey: string;
  accountId: string;
  direction: MovementDirection;
  amountCents: Cents;
  method: PaymentMethod;
  description: string;
  occurredOn: string;
  sourceLabel?: string | null;
  category?: string | null;
}
export interface MovementView {
  movementId: string;
  accountId: string;
  direction: MovementDirection;
  amountCents: Cents;
  method: PaymentMethod;
  description: string;
  occurredOn: string;
  sourceLabel: string | null;
  category: string | null;
  createdAt: string;
  eventKind: 'ordinary' | 'refund';
  refundOfMovementId: string | null;
  refundedCents: Cents;
}
interface MovementRow {
  movement_id: string;
  account_id: string;
  creation_key: string;
  direction: MovementDirection;
  amount_cents: number;
  payment_method: PaymentMethod;
  description: string;
  occurred_on: string;
  source_label: string | null;
  category: string | null;
  created_at: string;
  refund_of_movement_id: string | null;
  refunded_cents: number;
}

const MOVEMENT_SELECT = 'SELECT m.*, r.original_movement_id AS refund_of_movement_id, ' +
  'COALESCE((SELECT SUM(rr.amount_cents) FROM cash_refunds rr ' +
  'WHERE rr.owner_user_id = m.owner_user_id AND rr.original_movement_id = m.movement_id), 0) ' +
  'AS refunded_cents FROM posted_cash_movements m LEFT JOIN cash_refunds r ' +
  'ON r.owner_user_id = m.owner_user_id AND r.refund_movement_id = m.movement_id';

function ownerOf(actor: AuthenticatedActor): string {
  if (!actor || typeof actor.userId !== 'string' || !actor.userId.trim() || actor.userId.length > 128) {
    throw new TypeError('Verified session required');
  }
  return actor.userId;
}
function optionalLabel(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value.trim();
}
function validateDate(date: string): void {
  if (typeof date !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(date)) {
    throw new TypeError('Invalid occurredOn');
  }
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || year < 1000 || year > 9999) {
    throw new TypeError('Invalid occurredOn');
  }
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (actual.getUTCFullYear() !== year || actual.getUTCMonth() + 1 !== month || actual.getUTCDate() !== day) {
    throw new TypeError('Invalid occurredOn');
  }
}
function validate(input: PostMovementRequest): { description: string; sourceLabel: string | null; category: string | null } {
  if (!input || typeof input !== 'object' || typeof input.idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9_-]{12,128}$/.test(input.idempotencyKey)) throw new TypeError('Invalid idempotencyKey');
  if (typeof input.accountId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.accountId)) {
    throw new TypeError('Invalid accountId');
  }
  if (input.direction !== 'income' && input.direction !== 'expense') throw new TypeError('Invalid direction');
  assertCents(input.amountCents);
  if (input.amountCents === 0 || input.amountCents > MAX_CENTS) throw new RangeError('Movement must be positive');
  if (!['cash', 'pix', 'debit', 'bank_transfer'].includes(input.method)) throw new TypeError('Invalid payment method');
  const description = optionalLabel(input.description, 120, 'description');
  if (description === null) throw new TypeError('Description required');
  validateDate(input.occurredOn);
  return {
    description,
    sourceLabel: optionalLabel(input.sourceLabel, 120, 'sourceLabel'),
    category: optionalLabel(input.category, 80, 'category'),
  };
}
function toView(r: MovementRow): MovementView {
  assertCents(r.amount_cents);
  assertCents(r.refunded_cents);
  return {
    movementId: r.movement_id,
    accountId: r.account_id,
    direction: r.direction,
    amountCents: r.amount_cents,
    method: r.payment_method,
    description: r.description,
    occurredOn: r.occurred_on,
    sourceLabel: r.source_label,
    category: r.category,
    createdAt: r.created_at,
    eventKind: r.refund_of_movement_id === null ? 'ordinary' : 'refund',
    refundOfMovementId: r.refund_of_movement_id,
    refundedCents: r.refunded_cents,
  };
}
export async function getMovement(db: FinancialDatabase, actor: AuthenticatedActor, id: string): Promise<MovementView | null> {
  const owner = ownerOf(actor);
  const row = await db.prepare(MOVEMENT_SELECT +
    ' WHERE m.owner_user_id = ? AND m.movement_id = ?')
    .bind(owner, id).first<MovementRow>();
  return row ? toView(row) : null;
}
export interface ListMovementsFilter { accountId?: string; limit?: number; offset?: number }
export async function listMovements(db: FinancialDatabase, actor: AuthenticatedActor, filter: ListMovementsFilter = {}): Promise<MovementView[]> {
  const owner = ownerOf(actor);
  const { accountId, limit = 50, offset = 0 } = filter;
  if (accountId !== undefined && (typeof accountId !== 'string' || !/^[0-9a-f-]{36}$/.test(accountId))) throw new TypeError('Invalid filter');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new TypeError('Invalid pagination');
  const rows = await db.prepare(MOVEMENT_SELECT +
    ' WHERE m.owner_user_id = ? AND (? IS NULL OR m.account_id = ?) ' +
    'ORDER BY m.occurred_on DESC, m.created_at DESC, m.movement_id DESC LIMIT ? OFFSET ?')
    .bind(owner, accountId ?? null, accountId ?? null, limit, offset).all<MovementRow>();
  return rows.results.map(toView);
}
export async function postMovement(
  db: FinancialDatabase, actor: AuthenticatedActor, input: PostMovementRequest,
  clock: () => Date = () => new Date(),
): Promise<MovementView> {
  const owner = ownerOf(actor);
  const normalized = validate(input);
  const replay = async (): Promise<MovementView | null> => {
    const row = await db.prepare(MOVEMENT_SELECT +
      ' WHERE m.owner_user_id = ? AND m.creation_key = ?')
      .bind(owner, input.idempotencyKey).first<MovementRow>();
    if (!row) return null;
    if (row.account_id !== input.accountId || row.direction !== input.direction ||
        row.amount_cents !== input.amountCents || row.payment_method !== input.method ||
        row.description !== normalized.description || row.occurred_on !== input.occurredOn ||
        row.source_label !== normalized.sourceLabel || row.category !== normalized.category) {
      throw new Error('Idempotency conflict');
    }
    return toView(row);
  };
  const found = await replay();
  if (found) return found;
  const id = crypto.randomUUID();
  const now = clock().toISOString();
  try {
    // Composite FK rejects another user's account. A single INSERT commits
    // atomically, and the unique creation key prevents duplicate cash flows.
    await db.prepare(`INSERT INTO posted_cash_movements
      (owner_user_id, movement_id, creation_key, account_id, direction, amount_cents,
       payment_method, description, source_label, category, occurred_on, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(owner, id, input.idempotencyKey, input.accountId, input.direction,
        input.amountCents, input.method, normalized.description, normalized.sourceLabel,
        normalized.category, input.occurredOn, now).run();
  } catch (cause) {
    const committed = await replay();
    if (committed) return committed;
    throw cause;
  }
  const result = await getMovement(db, actor, id);
  if (!result) throw new Error('Inserted movement cannot be read');
  return result;
}
