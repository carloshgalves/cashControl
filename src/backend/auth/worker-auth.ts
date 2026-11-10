import { betterAuth } from 'better-auth';
import { withCloudflare } from 'better-auth-cloudflare';
import type { D1Database } from '@cloudflare/workers-types';

/** D1 and secrets must be injected by the Cloudflare Worker, never by the client. */
export type WorkerBindings = {
  DB: D1Database;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  ALLOW_SIGN_UP?: string;
};

export function configuredOrigin(env: WorkerBindings): string {
  if (!env.BETTER_AUTH_URL || !env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error('Missing security configuration');
  }
  const base = new URL(env.BETTER_AUTH_URL);
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Invalid auth base URL');
  }
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) {
    throw new Error('Auth base URL must use HTTPS outside of localhost');
  }
  return base.origin;
}

/** Better Auth owns password hashing, token issuance, sessions and revocation. */
export function createWorkerAuth(env: WorkerBindings) {
  const origin = configuredOrigin(env);
  return betterAuth({
    ...withCloudflare({
      d1Native: env.DB,
      // Default Cloudflare plugin settings require request.cf and collect
      // geolocation. Neither is needed for this financial application.
      autoDetectIpAddress: false,
      geolocationTracking: false,
    }, {
      baseURL: origin,
      secret: env.BETTER_AUTH_SECRET,
      trustedOrigins: [origin],
      emailAndPassword: {
        enabled: true,
        disableSignUp: env.ALLOW_SIGN_UP !== 'true',
        minPasswordLength: 12,
        maxPasswordLength: 128,
        autoSignIn: false,
      },
      session: { cookieCache: { enabled: false } },
      rateLimit: {
        enabled: true,
        storage: 'database',
        window: 60,
        max: 60,
        customRules: {
          '/sign-in/email': { window: 60, max: 5 },
          '/sign-up/email': { window: 3600, max: 3 },
        },
      },
      advanced: { useSecureCookies: origin.startsWith('https:') },
    }),
  });
}
