import type { AccountKind, AuthenticatedActor, FinancialDatabase } from '../accounts/accounts.ts';

/**
 * Read-only dashboard of actual money. All returned numbers are integer BRL cents.
 *
 * IMPORTANT: account balances and pending obligations are CURRENT at request time;
 * period filters apply ONLY to confirmed cash movements and upcoming due dates.
 * Do not interpret a past period as a historical bank-balance snapshot.
 */
export interface DashboardPeriod {
  from: string;
  to: string;
}
export interface DashboardAccount {
  accountId: string;
  name: string;
  kind: AccountKind;
  currency: 'BRL';
  balanceCents: number;
}
export interface DashboardView {
  currency: 'BRL';
  period: DashboardPeriod;
  balances: {
    basis: 'current';
    totalCents: number;
    accounts: DashboardAccount[];
  };
  cashFlow: {
    basis: 'confirmed_occurrence_in_period';
    incomeCents: number;
    expensesCents: number;
    refundsCents: number;
    netCents: number;
  };
  obligations: {
    basis: 'current_outstanding';
    openCount: number;
    outstandingCents: number;
    dueInPeriodCount: number;
    dueInPeriodCents: number;
  };
  expectations: {
    status: 'not_implemented';
  };
}

interface DashboardRow {
  account_id: string | null;
  display_name: string | null;
  kind: AccountKind | null;
  currency: string | null;
  balance_cents: number | null;
  income_cents: number;
  expense_cents: number;
  refund_cents: number;
  outstanding_cents: number;
  open_count: number;
  due_in_period_cents: number;
  due_in_period_count: number;
}
function ownerOf(actor: AuthenticatedActor): string {
  if (!actor || typeof actor.userId !== 'string' || !actor.userId.trim() || actor.userId.length > 128) {
    throw new TypeError('Verified user required');
  }
  return actor.userId;
}
function businessDate(value: string): void {
  if (typeof value !== 'string' ||
      !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value)) {
    throw new TypeError('Invalid dashboard period');
  }
  const [y,m,d] = value.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined || y < 1000 || y > 9999) {
    throw new TypeError('Invalid dashboard period');
  }
  const check = new Date(Date.UTC(y,m-1,d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() + 1 !== m || check.getUTCDate() !== d) {
    throw new TypeError('Invalid dashboard period');
  }
}
function safeInteger(x: unknown, signed: boolean, name: string): number {
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || (!signed && x < 0)) {
    throw new RangeError('Invalid financial total: ' + name);
  }
  return x;
}
function safeSum(a: number, b: number): number {
  const result = a+b;
  if (!Number.isSafeInteger(result)) throw new RangeError('Financial total exceeds safe integer range');
  return result;
}

/**
 * A SINGLE SQLite SELECT, for a coherent database snapshot: balances, current
 * obligations and in-period cash all come from the same version of the ledger.
 *
 * Real refunds appear in the cash ledger as 'income' by direction, but carry
 * a corresponding cash_refunds record. Those are not earned income.
 * Transfers only affect financial_account_balances, not cashFlow totals.
 */
const DASHBOARD_QUERY = [
  'WITH',
  ' accounts AS (',
  '   SELECT account_id, display_name, kind, currency, balance_cents',
  '   FROM financial_account_balances WHERE owner_user_id = ?',
  ' ),',
  ' flow AS (',
  '   SELECT',
  "     COALESCE(SUM(CASE WHEN m.direction = 'income' AND r.refund_id IS NULL",
  '       THEN m.amount_cents ELSE 0 END), 0) AS income_cents,',
  "     COALESCE(SUM(CASE WHEN m.direction = 'expense'",
  '       THEN m.amount_cents ELSE 0 END), 0) AS expense_cents,',
  "     COALESCE(SUM(CASE WHEN m.direction = 'income' AND r.refund_id IS NOT NULL",
  '       THEN m.amount_cents ELSE 0 END), 0) AS refund_cents',
  '   FROM posted_cash_movements m',
  '   LEFT JOIN cash_refunds r ON r.owner_user_id = m.owner_user_id',
  '     AND r.refund_movement_id = m.movement_id',
  '   WHERE m.owner_user_id = ? AND m.occurred_on BETWEEN ? AND ?',
  ' ),',
  ' due AS (',
  '   SELECT',
  '     COALESCE(SUM(CASE WHEN outstanding_cents > 0',
  '       THEN outstanding_cents ELSE 0 END), 0) AS outstanding_cents,',
  '     COUNT(CASE WHEN outstanding_cents > 0 THEN 1 END) AS open_count,',
  '     COALESCE(SUM(CASE WHEN outstanding_cents > 0',
  '       AND due_on BETWEEN ? AND ? THEN outstanding_cents ELSE 0 END), 0)',
  '       AS due_in_period_cents,',
  '     COUNT(CASE WHEN outstanding_cents > 0',
  '       AND due_on BETWEEN ? AND ? THEN 1 END) AS due_in_period_count',
  '   FROM financial_obligation_balances WHERE owner_user_id = ?',
  ' )',
  ' SELECT accounts.account_id, accounts.display_name, accounts.kind,',
  '   accounts.currency, accounts.balance_cents,',
  '   flow.income_cents, flow.expense_cents, flow.refund_cents,',
  '   due.outstanding_cents, due.open_count,',
  '   due.due_in_period_cents, due.due_in_period_count',
  ' FROM flow CROSS JOIN due LEFT JOIN accounts ON 1=1',
  ' ORDER BY accounts.account_id',
].join('\n');

export async function getDashboard(
  db: FinancialDatabase,
  actor: AuthenticatedActor,
  period: DashboardPeriod,
): Promise<DashboardView> {
  const owner = ownerOf(actor);
  if (!period || typeof period !== 'object') throw new TypeError('Period is required');
  businessDate(period.from);
  businessDate(period.to);
  if (period.from > period.to) throw new TypeError('Dashboard period is reversed');

  const result = await db.prepare(DASHBOARD_QUERY).bind(
    owner,
    owner, period.from, period.to,
    period.from, period.to,
    period.from, period.to,
    owner,
  ).all<DashboardRow>();
  // The aggregate CTEs always yield one row, even for an owner with no data.
  const first = result.results[0];
  if (!first) throw new Error('Dashboard aggregate was unavailable');
  const income = safeInteger(first.income_cents, false, 'income');
  const expenses = safeInteger(first.expense_cents, false, 'expenses');
  const refunds = safeInteger(first.refund_cents, false, 'refunds');
  const obligationsTotal = safeInteger(first.outstanding_cents, false, 'outstanding');
  const openCount = safeInteger(first.open_count, false, 'obligation count');
  const dueCents = safeInteger(first.due_in_period_cents, false, 'due in period');
  const dueCount = safeInteger(first.due_in_period_count, false, 'due count');
  if (dueCents > obligationsTotal || dueCount > openCount) {
    throw new RangeError('Inconsistent obligation totals');
  }

  const accounts: DashboardAccount[] = [];
  let totalCents = 0;
  for (const row of result.results) {
    if (row.income_cents !== income || row.expense_cents !== expenses ||
        row.refund_cents !== refunds || row.outstanding_cents !== obligationsTotal ||
        row.open_count !== openCount || row.due_in_period_cents !== dueCents ||
        row.due_in_period_count !== dueCount) {
      throw new Error('Dashboard snapshot contains inconsistent aggregates');
    }
    if (row.account_id === null) continue;
    if (typeof row.account_id !== 'string' || typeof row.display_name !== 'string' ||
        (row.kind !== 'general' && row.kind !== 'bank' && row.kind !== 'cash') ||
        row.currency !== 'BRL') throw new TypeError('Invalid account read model');
    const balance = safeInteger(row.balance_cents, true, 'account balance');
    accounts.push({
      accountId: row.account_id, name: row.display_name, kind: row.kind,
      currency: 'BRL', balanceCents: balance,
    });
    totalCents = safeSum(totalCents, balance);
  }
  const netCents = safeSum(safeSum(income, refunds), -expenses);
  return {
    currency: 'BRL',
    period: { from: period.from, to: period.to },
    balances: { basis: 'current', totalCents, accounts },
    cashFlow: {
      basis: 'confirmed_occurrence_in_period',
      incomeCents: income, expensesCents: expenses,
      refundsCents: refunds, netCents,
    },
    obligations: {
      basis: 'current_outstanding',
      openCount, outstandingCents: obligationsTotal,
      dueInPeriodCount: dueCount, dueInPeriodCents: dueCents,
    },
    expectations: { status: 'not_implemented' },
  };
}
