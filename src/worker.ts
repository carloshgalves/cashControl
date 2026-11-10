import { Hono } from 'hono';
import type { FinancialDatabase } from './backend/accounts/accounts.ts';
import { handleFinancialHttp } from './backend/http/accounts-handler.ts';
import { configuredOrigin, createWorkerAuth, type WorkerBindings } from './backend/auth/worker-auth.ts';

const app = new Hono<{ Bindings: WorkerBindings }>();

// Same-origin only: avoids bypassing Better Auth trustedOrigins and our own
// strict Origin policy. We deliberately do not enable wildcard CORS.
app.use('/api/*', async (c, next) => {
  let origin: string;
  try { origin = configuredOrigin(c.env); }
  catch { return c.json({ error: 'UNAVAILABLE' }, 503, { 'cache-control': 'no-store' }); }
  if (new URL(c.req.url).origin !== origin) {
    return c.json({ error: 'FORBIDDEN_ORIGIN' }, 403, { 'cache-control': 'no-store' });
  }
  await next();
});

app.all('/api/auth/*', (c) => createWorkerAuth(c.env).handler(c.req.raw));

// These are the ONLY financial endpoints. There is no unprotected wildcard.
// Actual ownership comes from Better Auth's database-backed getSession, not
// from x-user-id, body.ownerId, or a resource ID supplied in the URL.
app.all('/api/accounts', async (c) => {
  const auth = createWorkerAuth(c.env);
  return handleFinancialHttp(
    c.req.raw,
    c.env.DB as unknown as FinancialDatabase,
    async (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
    configuredOrigin(c.env),
  );
});
app.all('/api/accounts/:accountId', async (c) => {
  const auth = createWorkerAuth(c.env);
  return handleFinancialHttp(
    c.req.raw,
    c.env.DB as unknown as FinancialDatabase,
    async (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
    configuredOrigin(c.env),
  );
});

// Use the same verified-session boundary as the account endpoints.
for (const path of ['/api/movements', '/api/movements/:movementId']) {
  app.all(path, (c) => {
    const auth = createWorkerAuth(c.env);
    return handleFinancialHttp(
      c.req.raw,
      c.env.DB as unknown as FinancialDatabase,
      async (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
      configuredOrigin(c.env),
    );
  });
}

// Upcoming bills and confirmed partial/full settlements reuse Better Auth sessions.
for (const path of ['/api/obligations', '/api/obligations/:obligationId', '/api/obligations/:obligationId/payments']) {
  app.all(path, (c) => {
    const auth = createWorkerAuth(c.env);
    return handleFinancialHttp(
      c.req.raw,
      c.env.DB as unknown as FinancialDatabase,
      async (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
      configuredOrigin(c.env),
    );
  });
}

// Internal transfers are one atomic event across two accounts of the same user.
// The session, CSRF and owner checks are shared with the existing financial API.
for (const path of ['/api/transfers', '/api/transfers/:transferId']) {
  app.all(path, (c) => {
    const auth = createWorkerAuth(c.env);
    return handleFinancialHttp(
      c.req.raw,
      c.env.DB as unknown as FinancialDatabase,
      async (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
      configuredOrigin(c.env),
    );
  });
}

app.notFound((c) => c.json({ error: 'NOT_FOUND' }, 404));
export default app;
