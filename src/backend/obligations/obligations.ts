import { assertCents, type Cents } from '../../domain/money.ts';
import type { AuthenticatedActor, FinancialDatabase } from '../accounts/accounts.ts';
import type { PaymentMethod } from '../movements/movements.ts';

export type ObligationState = 'open' | 'partially_paid' | 'paid';
export interface CreateObligationInput {
  idempotencyKey: string;
  title: string;
  category?: string | null;
  totalCents: Cents;
  dueOn: string;
}
export interface ObligationView {
  obligationId: string;
  title: string;
  category: string | null;
  totalCents: Cents;
  paidCents: Cents;
  outstandingCents: Cents;
  dueOn: string;
  state: ObligationState;
  createdAt: string;
}
export interface PayObligationInput {
  idempotencyKey: string;
  obligationId: string;
  accountId: string;
  amountCents: Cents;
  method: PaymentMethod;
  paidOn: string;
}
export interface ObligationPaymentView {
  paymentId: string;
  obligationId: string;
  movementId: string;
  accountId: string;
  amountCents: Cents;
  method: PaymentMethod;
  paidOn: string;
  createdAt: string;
}
export interface Pagination { limit?: number; offset?: number }
interface ObligationRow {
  obligation_id: string; title: string; category: string | null;
  creation_key: string; total_cents: number; paid_cents: number;
  outstanding_cents: number; due_on: string; created_at: string;
}
interface PaymentRow {
  payment_id: string; creation_key: string; obligation_id: string;
  movement_id: string; account_id: string; amount_cents: number;
  payment_method: PaymentMethod; occurred_on: string; created_at: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{12,128}$/;
const METHODS: readonly string[] = ['cash', 'pix', 'debit', 'bank_transfer'];

function ownerOf(actor: AuthenticatedActor): string {
  if (!actor || typeof actor.userId !== 'string' || !actor.userId.trim() || actor.userId.length > 128) {
    throw new TypeError('Verified session required');
  }
  return actor.userId;
}
function label(value: unknown, max: number, required = false): string | null {
  if ((value === null || value === undefined) && !required) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max ||
      /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('Invalid financial label');
  return value.trim();
}
function civilDate(value: string): void {
  if (typeof value !== 'string' ||
      !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value)) {
    throw new TypeError('Invalid business date');
  }
  const [y, m, d] = value.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined || y < 1000 || y > 9999) {
    throw new TypeError('Invalid business date');
  }
  const actual = new Date(Date.UTC(y, m - 1, d));
  if (actual.getUTCFullYear() !== y || actual.getUTCMonth() + 1 !== m || actual.getUTCDate() !== d) {
    throw new TypeError('Invalid business date');
  }
}
function key(value: unknown): void {
  if (typeof value !== 'string' || !KEY.test(value)) throw new TypeError('Invalid idempotency key');
}
function paginate(params: Pagination): { limit: number; offset: number } {
  const { limit = 50, offset = 0 } = params;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new TypeError('Invalid pagination');
  return { limit, offset };
}
function obligationView(row: ObligationRow): ObligationView {
  assertCents(row.total_cents);
  assertCents(row.paid_cents);
  assertCents(row.outstanding_cents);
  if (row.paid_cents + row.outstanding_cents !== row.total_cents || row.total_cents === 0) {
    throw new RangeError('Invalid obligation balance');
  }
  const state: ObligationState = row.outstanding_cents === 0
    ? 'paid' : row.paid_cents > 0 ? 'partially_paid' : 'open';
  return { obligationId: row.obligation_id, title: row.title, category: row.category,
    totalCents: row.total_cents, paidCents: row.paid_cents,
    outstandingCents: row.outstanding_cents, dueOn: row.due_on,
    state, createdAt: row.created_at };
}
function paymentView(row: PaymentRow): ObligationPaymentView {
  assertCents(row.amount_cents);
  return { paymentId: row.payment_id, obligationId: row.obligation_id,
    movementId: row.movement_id, accountId: row.account_id,
    amountCents: row.amount_cents, method: row.payment_method,
    paidOn: row.occurred_on, createdAt: row.created_at };
}
export async function getObligation(db: FinancialDatabase, actor: AuthenticatedActor,
  obligationId: string): Promise<ObligationView | null> {
  const owner = ownerOf(actor);
  const row = await db.prepare('SELECT * FROM financial_obligation_balances WHERE owner_user_id = ? AND obligation_id = ?')
    .bind(owner, obligationId).first<ObligationRow>();
  return row ? obligationView(row) : null;
}
export async function listObligations(db: FinancialDatabase, actor: AuthenticatedActor,
  params: Pagination = {}): Promise<ObligationView[]> {
  const owner = ownerOf(actor), { limit, offset } = paginate(params);
  const rows = await db.prepare('SELECT * FROM financial_obligation_balances WHERE owner_user_id = ? ORDER BY due_on ASC, created_at DESC, obligation_id DESC LIMIT ? OFFSET ?')
    .bind(owner, limit, offset).all<ObligationRow>();
  return rows.results.map(obligationView);
}
export async function createObligation(db: FinancialDatabase, actor: AuthenticatedActor,
  input: CreateObligationInput, clock: () => Date = () => new Date()): Promise<ObligationView> {
  const owner = ownerOf(actor);
  if (!input || typeof input !== 'object') throw new TypeError('Invalid obligation');
  key(input.idempotencyKey);
  const title = label(input.title, 120, true)!;
  const category = label(input.category, 80);
  assertCents(input.totalCents);
  if (input.totalCents === 0) throw new RangeError('Obligation must be positive');
  civilDate(input.dueOn);
  const replay = async (): Promise<ObligationView | null> => {
    const row = await db.prepare('SELECT * FROM financial_obligation_balances WHERE owner_user_id = ? AND creation_key = ?')
      .bind(owner, input.idempotencyKey).first<ObligationRow>();
    if (!row) return null;
    if (row.title !== title || row.category !== category ||
        row.total_cents !== input.totalCents || row.due_on !== input.dueOn) throw new Error('Idempotency conflict');
    return obligationView(row);
  };
  const previous = await replay();
  if (previous) return previous;
  const id = crypto.randomUUID();
  try {
    await db.prepare('INSERT INTO financial_obligations (owner_user_id, obligation_id, creation_key, title, category, total_cents, due_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(owner, id, input.idempotencyKey, title, category, input.totalCents, input.dueOn, clock().toISOString()).run();
  } catch (err) {
    const committed = await replay();
    if (committed) return committed;
    throw err;
  }
  const result = await getObligation(db, actor, id);
  if (!result) throw new Error('Obligation was not persisted');
  return result;
}
export async function getObligationPayment(db: FinancialDatabase, actor: AuthenticatedActor,
  paymentId: string): Promise<ObligationPaymentView | null> {
  const owner = ownerOf(actor);
  const row = await db.prepare('SELECT p.payment_id, p.creation_key, p.obligation_id, p.movement_id, p.amount_cents, p.created_at, m.account_id, m.payment_method, m.occurred_on FROM financial_obligation_payments p JOIN posted_cash_movements m ON m.owner_user_id = p.owner_user_id AND m.movement_id = p.movement_id WHERE p.owner_user_id = ? AND p.payment_id = ?')
    .bind(owner, paymentId).first<PaymentRow>();
  return row ? paymentView(row) : null;
}
export async function listObligationPayments(db: FinancialDatabase, actor: AuthenticatedActor,
  obligationId: string, pagination: Pagination = {}): Promise<ObligationPaymentView[]> {
  const owner = ownerOf(actor), { limit, offset } = paginate(pagination);
  if (!UUID.test(obligationId)) throw new TypeError('Invalid obligationId');
  const rows = await db.prepare('SELECT p.payment_id, p.creation_key, p.obligation_id, p.movement_id, p.amount_cents, p.created_at, m.account_id, m.payment_method, m.occurred_on FROM financial_obligation_payments p JOIN posted_cash_movements m ON m.owner_user_id = p.owner_user_id AND m.movement_id = p.movement_id WHERE p.owner_user_id = ? AND p.obligation_id = ? ORDER BY m.occurred_on DESC, p.created_at DESC, p.payment_id DESC LIMIT ? OFFSET ?')
    .bind(owner, obligationId, limit, offset).all<PaymentRow>();
  return rows.results.map(paymentView);
}
export async function payObligation(db: FinancialDatabase, actor: AuthenticatedActor,
  input: PayObligationInput, clock: () => Date = () => new Date()): Promise<ObligationPaymentView> {
  const owner = ownerOf(actor);
  if (!input || typeof input !== 'object') throw new TypeError('Invalid payment');
  key(input.idempotencyKey);
  if (typeof input.obligationId !== 'string' || !UUID.test(input.obligationId) ||
      typeof input.accountId !== 'string' || !UUID.test(input.accountId)) throw new TypeError('Invalid resource ID');
  assertCents(input.amountCents);
  if (input.amountCents === 0) throw new RangeError('Payment must be positive');
  if (!METHODS.includes(input.method)) throw new TypeError('Invalid payment method');
  civilDate(input.paidOn);
  const replay = async (): Promise<ObligationPaymentView | null> => {
    const row = await db.prepare('SELECT p.payment_id, p.creation_key, p.obligation_id, p.movement_id, p.amount_cents, p.created_at, m.account_id, m.payment_method, m.occurred_on FROM financial_obligation_payments p JOIN posted_cash_movements m ON m.owner_user_id = p.owner_user_id AND m.movement_id = p.movement_id WHERE p.owner_user_id = ? AND p.creation_key = ?')
      .bind(owner, input.idempotencyKey).first<PaymentRow>();
    if (!row) return null;
    if (row.obligation_id !== input.obligationId || row.account_id !== input.accountId ||
        row.amount_cents !== input.amountCents || row.payment_method !== input.method ||
        row.occurred_on !== input.paidOn) throw new Error('Idempotency conflict');
    return paymentView(row);
  };
  const prior = await replay();
  if (prior) return prior;
  const obligation = await getObligation(db, actor, input.obligationId);
  if (!obligation) throw new Error('Obligation unavailable');
  const paymentId = crypto.randomUUID(), movementId = crypto.randomUUID(), now = clock().toISOString();
  const movementKey = 'obligation-payment:' + input.idempotencyKey;
  const statements = [
    db.prepare("INSERT INTO posted_cash_movements (owner_user_id, movement_id, creation_key, account_id, direction, amount_cents, payment_method, description, source_label, category, occurred_on, created_at) VALUES (?, ?, ?, ?, 'expense', ?, ?, ?, NULL, ?, ?, ?)")
      .bind(owner, movementId, movementKey, input.accountId, input.amountCents, input.method,
        ('Pagamento: ' + obligation.title).slice(0, 120), obligation.category, input.paidOn, now),
    db.prepare('INSERT INTO financial_obligation_payments (owner_user_id, payment_id, creation_key, obligation_id, movement_id, amount_cents, created_at) VALUES (?, ?, ?, (SELECT CASE WHEN o.outstanding_cents >= ? THEN o.obligation_id ELSE NULL END FROM financial_obligation_balances o WHERE o.owner_user_id = ? AND o.obligation_id = ?), ?, ?, ?)')
      .bind(owner, paymentId, input.idempotencyKey, input.amountCents, owner,
        input.obligationId, movementId, input.amountCents, now),
  ];
  try {
    // D1.batch is atomic; guarded NOT NULL obligation_id forces rollback of
    // the cash expense if outstanding was already consumed by another payment.
    await db.batch(statements);
  } catch (err) {
    const committed = await replay();
    if (committed) return committed;
    throw err;
  }
  const result = await getObligationPayment(db, actor, paymentId);
  if (!result) throw new Error('Payment was not persisted');
  return result;
}
