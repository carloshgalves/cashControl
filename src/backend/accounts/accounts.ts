import { assertCents, type Cents } from '../../domain/money.ts';

/** Intentionally small D1 contract; no authentication or HTTP endpoint is shipped yet. */
export interface BoundStatement {
  bind(...values: (string | number | null)[]): BoundStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface FinancialDatabase {
  prepare(sql: string): BoundStatement;
  /** D1 batches are atomic, per the current Cloudflare D1 contract. */
  batch(statements: BoundStatement[]): Promise<unknown[]>;
}

/** Constructed only by a future verified-session middleware, never from request JSON. */
export interface AuthenticatedActor { readonly userId: string }
export type AccountKind = 'general' | 'bank' | 'cash';
export type InitialFunding =
  | { mode: 'external'; cents: Cents }
  | { mode: 'reallocate'; cents: Cents; fromAccountId: string };

export interface CreateAccountRequest {
  /** Client-supplied retry key, scoped to the verified owner. */
  readonly idempotencyKey: string;
  readonly name: string;
  readonly kind: AccountKind;
  readonly funding: InitialFunding;
}
export interface AccountView {
  accountId: string;
  name: string;
  kind: AccountKind;
  balanceCents: Cents;
  currency: 'BRL';
}

interface AccountRow {
  account_id: string;
  display_name: string;
  kind: AccountKind;
  currency: 'BRL';
  balance_cents: number;
}
interface ExistingAccount extends AccountRow {
  creation_key: string;
  initial_mode: string;
  initial_amount_cents: number;
  funding_account_id: string | null;
}

const BALANCE_SQL = `
  SELECT a.account_id, a.display_name, a.kind, a.currency, a.balance_cents
  FROM financial_account_balances a`;

function requireActor(actor: AuthenticatedActor): string {
  if (!actor || typeof actor.userId !== 'string' || !actor.userId.trim() || actor.userId.length > 128) {
    throw new TypeError('Verified user required');
  }
  return actor.userId;
}

function isKind(x: string): x is AccountKind {
  return x === 'general' || x === 'bank' || x === 'cash';
}

function validate(input: CreateAccountRequest): { name: string; from: string | null } {
  if (!input || typeof input !== 'object' || typeof input.idempotencyKey !== 'string' ||
      !/^[a-zA-Z0-9_-]{12,128}$/.test(input.idempotencyKey)) {
    throw new TypeError('Invalid idempotency key');
  }
  if (typeof input.name !== 'string' || input.name.trim().length < 1 ||
      input.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(input.name)) {
    throw new TypeError('Invalid account name');
  }
  if (!isKind(input.kind) || !input.funding ||
      (input.funding.mode !== 'external' && input.funding.mode !== 'reallocate')) {
    throw new TypeError('Invalid account kind or funding');
  }
  assertCents(input.funding.cents);
  if (input.funding.mode === 'reallocate') {
    if (input.funding.cents === 0 || typeof input.funding.fromAccountId !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(input.funding.fromAccountId)) {
      throw new TypeError('Reallocation requires a positive amount and source');
    }
    return { name: input.name.trim(), from: input.funding.fromAccountId };
  }
  return { name: input.name.trim(), from: null };
}

function rowToView(r: AccountRow): AccountView {
  if (!Number.isSafeInteger(r.balance_cents)) throw new RangeError('Financial total exceeds safe integer range');
  return { accountId: r.account_id, name: r.display_name, kind: r.kind,
    balanceCents: r.balance_cents as Cents, currency: r.currency };
}

export async function listAccounts(db: FinancialDatabase, actor: AuthenticatedActor): Promise<AccountView[]> {
  const owner = requireActor(actor);
  const result = await db.prepare(`${BALANCE_SQL} WHERE a.owner_user_id = ? ORDER BY a.created_at, a.account_id`)
    .bind(owner).all<AccountRow>();
  return result.results.map(rowToView);
}

export async function getAccount(
  db: FinancialDatabase, actor: AuthenticatedActor, accountId: string
): Promise<AccountView | null> {
  const owner = requireActor(actor);
  const row = await db.prepare(`${BALANCE_SQL} WHERE a.owner_user_id = ? AND a.account_id = ?`)
    .bind(owner, accountId).first<AccountRow>();
  return row === null ? null : rowToView(row);
}

export async function createAccount(
  db: FinancialDatabase, actor: AuthenticatedActor, input: CreateAccountRequest,
  clock: () => Date = () => new Date()
): Promise<AccountView> {
  const owner = requireActor(actor);
  const { name, from } = validate(input);
  const checkReplay = async (): Promise<AccountView | null> => {
    const existing = await db.prepare(`
      SELECT b.*, a.creation_key, a.initial_mode, a.initial_amount_cents, a.funding_account_id
      FROM (${BALANCE_SQL}) b
      JOIN financial_accounts a ON a.account_id = b.account_id AND a.owner_user_id = ?
      WHERE a.owner_user_id = ? AND a.creation_key = ?
    `).bind(owner, owner, input.idempotencyKey).first<ExistingAccount>();
    if (!existing) return null;
    // One retry key cannot be used for two different financial operations.
    if (existing.display_name !== name || existing.kind !== input.kind ||
        existing.initial_amount_cents !== input.funding.cents ||
        existing.initial_mode !== input.funding.mode || existing.funding_account_id !== from) {
      throw new Error('Idempotency key reused with different account details');
    }
    return rowToView(existing);
  };
  const replay = await checkReplay();
  if (replay) return replay;

  const accountId = crypto.randomUUID();
  const now = clock().toISOString();
  const funding = input.funding;
  const statements = [db.prepare(`
    INSERT INTO financial_accounts
      (owner_user_id, account_id, creation_key, display_name, kind, currency,
       initial_mode, initial_amount_cents, opening_cents, funding_account_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'BRL', ?, ?, ?, ?, ?)
  `).bind(owner, accountId, input.idempotencyKey, name, input.kind,
    funding.mode, funding.cents, funding.mode === 'external' ? funding.cents : 0, from, now)];

  if (funding.mode === 'reallocate') {
    // The NOT NULL source FK + guarded scalar subquery cause the whole D1 batch
    // to roll back if the source is foreign, missing, or lacks adequate balance.
    // No read-then-write balance check is performed outside the atomic batch.
    statements.push(db.prepare(`
      INSERT INTO initial_allocations
        (owner_user_id, allocation_id, source_account_id, target_account_id, amount_cents, created_at)
      VALUES (?, ?, (
        SELECT CASE WHEN a.balance_cents >= ? THEN a.account_id ELSE NULL END
        FROM financial_account_balances a
        WHERE a.owner_user_id = ? AND a.account_id = ?
      ), ?, ?, ?)
    `).bind(owner, crypto.randomUUID(), funding.cents, owner, funding.fromAccountId,
      accountId, funding.cents, now));
  }

  try {
    await db.batch(statements);
  } catch (error) {
    // Concurrent retries can both miss the initial SELECT; one may then hit the
    // UNIQUE(owner, creation_key) constraint. Recover only if the same operation
    // actually committed. For all other failures preserve the original error.
    const committed = await checkReplay();
    if (committed) return committed;
    throw error;
  }
  const result = await getAccount(db, actor, accountId);
  if (!result) throw new Error('Created account not found');
  return result;
}
