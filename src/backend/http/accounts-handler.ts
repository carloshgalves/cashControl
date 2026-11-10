import { createAccount, getAccount, listAccounts, type AuthenticatedActor, type FinancialDatabase } from '../accounts/accounts.ts';
import { parseCents } from '../../domain/money.ts';
import { getMovement, listMovements, postMovement } from '../movements/movements.ts';
import { createObligation, getObligation, listObligations, listObligationPayments, payObligation } from '../obligations/obligations.ts';
import { createInternalTransfer, getInternalTransfer, listInternalTransfers } from '../transfers/transfers.ts';
import { cancelUnpaidObligation, getExpenseRefund, listExpenseRefunds, refundPaidExpense } from '../compensations/compensations.ts';

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
          (value.reason !== undefined && value.reason !== null && typeof value.reason !== 'string')) {
        return error(400, 'INVALID_BODY');
      }
      let amount;
      try { amount = parseCents(value.amount); }
      catch { return error(400, 'INVALID_AMOUNT'); }
      const refund = await refundPaidExpense(database, actor, {
        idempotencyKey: value.idempotencyKey,
        originalMovementId: value.originalMovementId,
        accountId: value.accountId, amountCents: amount,
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
