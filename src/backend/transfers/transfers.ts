import { assertCents, type Cents } from '../../domain/money.ts';
import type { AuthenticatedActor, FinancialDatabase } from '../accounts/accounts.ts';

export interface CreateInternalTransfer {
  idempotencyKey: string;
  sourceAccountId: string;
  targetAccountId: string;
  amountCents: Cents;
  transferredOn: string;
  note?: string | null;
}
export interface InternalTransferView {
  transferId: string;
  sourceAccountId: string;
  targetAccountId: string;
  amountCents: Cents;
  transferredOn: string;
  note: string | null;
  createdAt: string;
}
export interface TransferFilter {
  accountId?: string;
  limit?: number;
  offset?: number;
}
interface TransferRow {
  transfer_id: string;
  creation_key: string;
  source_account_id: string;
  target_account_id: string;
  amount_cents: number;
  transferred_on: string;
  note: string | null;
  created_at: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{12,128}$/;

function ownerOf(actor: AuthenticatedActor): string {
  if (!actor || typeof actor.userId !== 'string' ||
      !actor.userId.trim() || actor.userId.length > 128) {
    throw new TypeError('Verified session required');
  }
  return actor.userId;
}
function validateBusinessDate(date: string): void {
  if (typeof date !== 'string' ||
      !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(date)) {
    throw new TypeError('Invalid transfer date');
  }
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined ||
      year < 1000 || year > 9999) throw new TypeError('Invalid transfer date');
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (actual.getUTCFullYear() !== year || actual.getUTCMonth() + 1 !== month ||
      actual.getUTCDate() !== day) throw new TypeError('Invalid transfer date');
}
function normalizeNote(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  if (typeof note !== 'string' || !note.trim() || note.trim().length > 120 ||
      /[\x00-\x1f\x7f]/.test(note)) throw new TypeError('Invalid transfer note');
  return note.trim();
}
function validate(input: CreateInternalTransfer): string | null {
  if (!input || typeof input !== 'object' || typeof input.idempotencyKey !== 'string' ||
      !KEY.test(input.idempotencyKey)) throw new TypeError('Invalid idempotency key');
  if (typeof input.sourceAccountId !== 'string' || !UUID.test(input.sourceAccountId) ||
      typeof input.targetAccountId !== 'string' || !UUID.test(input.targetAccountId) ||
      input.sourceAccountId === input.targetAccountId) throw new TypeError('Invalid transfer endpoints');
  assertCents(input.amountCents);
  if (input.amountCents === 0) throw new RangeError('Transfer amount must be positive');
  validateBusinessDate(input.transferredOn);
  return normalizeNote(input.note);
}
function toView(row: TransferRow): InternalTransferView {
  assertCents(row.amount_cents);
  return {
    transferId: row.transfer_id,
    sourceAccountId: row.source_account_id,
    targetAccountId: row.target_account_id,
    amountCents: row.amount_cents,
    transferredOn: row.transferred_on,
    note: row.note,
    createdAt: row.created_at,
  };
}
export async function getInternalTransfer(
  db: FinancialDatabase, actor: AuthenticatedActor, transferId: string,
): Promise<InternalTransferView | null> {
  const owner = ownerOf(actor);
  const row = await db.prepare(
    'SELECT * FROM internal_transfers WHERE owner_user_id = ? AND transfer_id = ?',
  ).bind(owner, transferId).first<TransferRow>();
  return row === null ? null : toView(row);
}
export async function listInternalTransfers(
  db: FinancialDatabase, actor: AuthenticatedActor, filter: TransferFilter = {},
): Promise<InternalTransferView[]> {
  const owner = ownerOf(actor);
  const { accountId, limit = 50, offset = 0 } = filter;
  if (accountId !== undefined && (typeof accountId !== 'string' || !UUID.test(accountId))) {
    throw new TypeError('Invalid account filter');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new TypeError('Invalid pagination');
  }
  const result = await db.prepare(
    'SELECT * FROM internal_transfers WHERE owner_user_id = ? AND ' +
    '(? IS NULL OR source_account_id = ? OR target_account_id = ?) ' +
    'ORDER BY transferred_on DESC, created_at DESC, transfer_id DESC LIMIT ? OFFSET ?',
  ).bind(owner, accountId ?? null, accountId ?? null, accountId ?? null, limit, offset).all<TransferRow>();
  return result.results.map(toView);
}

export async function createInternalTransfer(
  db: FinancialDatabase, actor: AuthenticatedActor, input: CreateInternalTransfer,
  clock: () => Date = () => new Date(),
): Promise<InternalTransferView> {
  const owner = ownerOf(actor);
  const note = validate(input);
  const replay = async (): Promise<InternalTransferView | null> => {
    const row = await db.prepare(
      'SELECT * FROM internal_transfers WHERE owner_user_id = ? AND creation_key = ?',
    ).bind(owner, input.idempotencyKey).first<TransferRow>();
    if (!row) return null;
    if (row.source_account_id !== input.sourceAccountId ||
        row.target_account_id !== input.targetAccountId ||
        row.amount_cents !== input.amountCents ||
        row.transferred_on !== input.transferredOn || row.note !== note) {
      throw new Error('Idempotency conflict');
    }
    return toView(row);
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const transferId = crypto.randomUUID();
  try {
    // A single SQL INSERT creates one inseparable debit/credit event.
    // Composite owner FKs guard both ends; an atomic DB trigger verifies that
    // the recorded source balance can fund the transfer, including concurrent
    // transfers and previously posted expenses, bills and reallocations.
    await db.prepare(
      'INSERT INTO internal_transfers ' +
      '(owner_user_id, transfer_id, creation_key, source_account_id, target_account_id, ' +
      'amount_cents, transferred_on, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(owner, transferId, input.idempotencyKey, input.sourceAccountId,
      input.targetAccountId, input.amountCents, input.transferredOn,
      note, clock().toISOString()).run();
  } catch (cause) {
    // Concurrent identical requests may both miss the initial SELECT; after
    // one commits, the other recovers its result. An unrelated failure stays
    // a failure, and another payload with the same key is rejected.
    const committed = await replay();
    if (committed) return committed;
    throw cause;
  }
  const result = await getInternalTransfer(db, actor, transferId);
  if (!result) throw new Error('Transfer was not persisted');
  return result;
}
