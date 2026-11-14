export type AccountKind = 'general' | 'bank' | 'cash';
export type PaymentMethod = 'pix' | 'cash' | 'debit' | 'bank_transfer';
export interface Account {
  accountId: string; name: string; kind: AccountKind; currency: 'BRL'; balanceCents: number;
}
export interface Movement {
  movementId: string; accountId: string; direction: 'income' | 'expense';
  amountCents: number; method: PaymentMethod; description: string; occurredOn: string;
  sourceLabel: string | null; category: string | null; createdAt: string;
  eventKind: 'ordinary' | 'refund'; refundOfMovementId: string | null; refundedCents: number;
}
export interface Transfer {
  transferId: string; sourceAccountId: string; targetAccountId: string;
  amountCents: number; transferredOn: string; note: string | null; createdAt: string;
}
export interface Obligation {
  obligationId: string; title: string; category: string | null; dueOn: string;
  totalCents: number; paidCents: number; outstandingCents: number;
  state: 'open' | 'partially_paid' | 'paid' | 'canceled';
}
export interface Dashboard {
  currency: 'BRL'; period: { from: string; to: string };
  balances: { basis: 'current'; totalCents: number; accounts: Account[] };
  cashFlow: {
    basis: 'confirmed_occurrence_in_period';
    incomeCents: number; expensesCents: number; refundsCents: number; netCents: number;
  };
  obligations: {
    basis: 'current_outstanding'; openCount: number; outstandingCents: number;
    dueInPeriodCount: number; dueInPeriodCents: number;
  };
  cardInvoices: {
    basis:'current_outstanding';openCount:number;outstandingCents:number;
    dueInPeriodCount:number;dueInPeriodCents:number;
  };
  expectations: { status: 'not_implemented' };
}
export interface Session { user: { id: string; email: string; name?: string }; session: { id: string } }
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(status === 401 ? 'Sessão expirada. Entre novamente.' :
      status === 403 ? 'Operação bloqueada por segurança.' :
      status === 409 ? 'Não foi possível concluir. Verifique os dados e o saldo.' :
      status >= 500 ? 'Serviço indisponível. Tente novamente.' : 'Confira os dados informados.');
    this.status = status;
    this.code = code;
  }
}
export async function request<T>(url: string, opts: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (!url.startsWith('/api/') || url.startsWith('//') || url.includes('\\')) {
    throw new Error('Invalid API path');
  }
  const response = await fetch(url, {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: opts.signal,
    headers: { 'accept': 'application/json', ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  let data: unknown;
  try { data = await response.json(); } catch { throw new ApiError(response.status, 'BAD_RESPONSE'); }
  if (!response.ok) {
    const code = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : 'REQUEST_FAILED';
    throw new ApiError(response.status, code);
  }
  return data as T;
}
export async function getSession(signal?: AbortSignal): Promise<Session | null> {
  return request<Session | null>('/api/auth/get-session', { signal });
}
export async function login(email: string, password: string): Promise<void> {
  await request('/api/auth/sign-in/email', { method: 'POST', body: { email, password } });
}
export async function logout(): Promise<void> {
  await request('/api/auth/sign-out', { method: 'POST', body: {} });
}
export async function allPages<T>(endpoint: string, field: string, signal?: AbortSignal): Promise<T[]> {
  const result: T[] = [];
  // Never display partial totals as full totals: a hard cap raises an explicit
  // failure instead of silently omitting the user's older records.
  for (let offset = 0; offset <= 100_000; offset += 100) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const page = await request<Record<string, T[]>>(
      endpoint + separator + 'limit=100&offset=' + offset, { signal },
    );
    if (!Array.isArray(page[field])) throw new Error('Resposta financeira incompleta.');
    result.push(...page[field]);
    if (page[field].length < 100) return result;
  }
  throw new Error('Há registros demais para esta consulta. Nenhum resumo parcial será exibido.');
}
export async function snapshot(month: string, signal?: AbortSignal) {
  const { from, to } = monthBounds(month);
  const [dashboard, movements, obligations, transfers] = await Promise.all([
    request<{ dashboard: Dashboard }>('/api/dashboard?from=' + from + '&to=' + to, { signal }),
    allPages<Movement>('/api/movements', 'movements', signal),
    allPages<Obligation>('/api/obligations', 'obligations', signal),
    allPages<Transfer>('/api/transfers', 'transfers', signal),
  ]);
  return { dashboard: dashboard.dashboard, movements, obligations, transfers };
}
import { monthBounds } from './finance.ts';
