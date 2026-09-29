/**
 * The API, as one Hono app.
 *
 * Hono rather than Express or a hand-rolled `node:http` router, for one reason
 * that matters more here than elsewhere: **it has no dependencies**, and
 * neither does its Node adapter. Section 13.1 pins every dependency exactly and
 * treats each addition as a decision, and this is the API's whole framework
 * surface for two packages and nothing transitive. It also speaks standard
 * `Request`/`Response`, so the tests below drive the real app through
 * `app.request()` with no server, no port and no supertest.
 *
 * Built by a function rather than exported as a module-level singleton, so a
 * test can hand it a different database without touching the environment.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { PublicClient } from 'viem';

import type { NonceStore } from '@stubby/shared';

import { emailRoutes } from '../auth/emailRoutes.js';
import { sessionRoutes } from '../auth/sessionRoutes.js';
import { siweRoutes } from '../auth/siweRoutes.js';
import { walletRoutes } from '../auth/walletRoutes.js';
import { xRoutes, type XClient } from '../auth/xRoutes.js';
import { healthRoutes } from './health.js';
import { raffleEventRoutes, type EventLookup } from './raffleEvents.js';
import { activityRoutes } from './activity.js';
import type { GeoLookup } from '../geo/lookup.js';
import { geoRoutes } from './geo.js';
import { mailRoutes } from './mail.js';
import { curationRoutes, type CurationRouteOptions } from './curation.js';
import { referralRoutes, type ReferralRouteOptions } from './referrals.js';
import type { ActivityItem, ActivityStats } from '../watch/store.js';
import type { AccountStore } from '../auth/accountStore.js';
import type { EmailLoginStore } from '../auth/emailLoginStore.js';
import type { Mailer } from '../auth/mailer.js';
import type { RateLimiter } from '../auth/rateLimit.js';
import type { SessionStore } from '../auth/sessionStore.js';
import type { XLoginStore } from '../auth/xLoginStore.js';

export interface ApiOptions {
  nonces: NonceStore;
  sessions: SessionStore;
  accounts: AccountStore;
  logins: EmailLoginStore;
  mailer: Mailer;
  xLogins: XLoginStore;
  /** The X app's credentials, or null while sign in with X is not set up. */
  x: XClient | null;
  /** Stands in for X in the tests. */
  xFetch?: typeof fetch;
  limiter: RateLimiter;
  /** Where a magic link points — the app's origin, not the API's. */
  appOrigin: string;
  /** The authority wallets sign for. Host and port, no scheme, no path. */
  siweDomain: string;
  chainId: number;
  /**
   * Origins the browser app is served from.
   *
   * An explicit list, never `*`. The session is a cookie, and `*` cannot be
   * combined with credentials — a wildcard here would not loosen the policy so
   * much as silently stop sign-in working.
   */
  allowedOrigins: string[];
  client?: PublicClient;
  secureCookies?: boolean;
  /** Readiness check behind `/health`; the database, in production. */
  health?: () => Promise<void>;
  /** The watcher's record of each draw's transactions, when a watcher is set up. */
  raffleEvents?: EventLookup;
  /** Referrals, when a watcher (which awards the bonuses) is set up. */
  referrals?: Omit<ReferralRouteOptions, 'sessions'>;
  /** The owner's featured draw and draw order, when a contract is watched. */
  curation?: Omit<CurationRouteOptions, 'sessions'>;
  /** The live strip's feed, when a watcher is set up. */
  activity?: () => Promise<ActivityItem[]>;
  /** Home's players row: how many have played, the latest few, the latest win. */
  activityStats?: () => Promise<ActivityStats>;
  /** Section 11.9: where a visitor is, for the buy check. Unset, all may buy. */
  geo?: { lookup: GeoLookup; blocked: ReadonlySet<string> };
  /** A test push to an account's own phones, when the server has a push key. */
  pushTest?: (accountId: string) => Promise<number>;
  /** Everything else `/health/all` checks for monitoring: mail, the watcher. */
  healthChecks?: Record<string, () => Promise<void>>;
}

export function createApi(options: ApiOptions) {
  /*
   * The console mailer prints the whole login link, token and all. That is a
   * secret in a terminal, which is fine on a laptop and is a live credential in
   * a production log aggregator — so it is refused rather than warned about.
   */
  if (process.env.NODE_ENV === 'production' && options.mailer.name.includes('console')) {
    throw new Error('the console mailer prints login tokens and must not run in production');
  }

  const app = new Hono();

  app.use(
    '*',
    cors({
      origin: options.allowedOrigins,
      // Required for the session cookie to be sent at all.
      credentials: true,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  /** Liveness. Says nothing about the database on purpose — see `/health`. */
  app.get('/', (c) => c.json({ service: 'stubby-api', ok: true }));
  if (options.raffleEvents) app.route('/raffles', raffleEventRoutes(options.raffleEvents));
  if (options.activity) {
    app.route('/activity', activityRoutes(options.activity, options.activityStats));
  }
  app.route('/mail', mailRoutes(options.accounts, options.appOrigin));
  if (options.geo) app.route('/geo', geoRoutes(options.geo.lookup, options.geo.blocked));
  if (options.referrals) {
    app.route('/', referralRoutes({ sessions: options.sessions, ...options.referrals }));
  }
  if (options.curation) {
    app.route('/', curationRoutes({ sessions: options.sessions, ...options.curation }));
  }
  if (options.health) {
    app.route('/health', healthRoutes(options.health, options.healthChecks));
  }

  app.route(
    '/auth/siwe',
    siweRoutes({
      nonces: options.nonces,
      sessions: options.sessions,
      accounts: options.accounts,
      limiter: options.limiter,
      domain: options.siweDomain,
      chainId: options.chainId,
      ...(options.client ? { client: options.client } : {}),
      ...(options.secureCookies === undefined ? {} : { secureCookies: options.secureCookies }),
    }),
  );

  app.route(
    '/auth/email',
    emailRoutes({
      logins: options.logins,
      accounts: options.accounts,
      sessions: options.sessions,
      mailer: options.mailer,
      limiter: options.limiter,
      appOrigin: options.appOrigin,
      ...(options.secureCookies === undefined ? {} : { secureCookies: options.secureCookies }),
    }),
  );

  app.route(
    '/auth/x',
    xRoutes({
      client: options.x,
      logins: options.xLogins,
      accounts: options.accounts,
      sessions: options.sessions,
      limiter: options.limiter,
      appOrigin: options.appOrigin,
      ...(options.xFetch ? { fetch: options.xFetch } : {}),
      ...(options.secureCookies === undefined ? {} : { secureCookies: options.secureCookies }),
    }),
  );

  app.route(
    '/auth/session',
    sessionRoutes({
      sessions: options.sessions,
      accounts: options.accounts,
      chainId: options.chainId,
      ...(options.pushTest ? { pushTest: options.pushTest } : {}),
      ...(options.secureCookies === undefined ? {} : { secureCookies: options.secureCookies }),
    }),
  );

  app.route(
    '/auth/wallet',
    walletRoutes({
      nonces: options.nonces,
      sessions: options.sessions,
      accounts: options.accounts,
      domain: options.siweDomain,
      chainId: options.chainId,
      ...(options.client ? { client: options.client } : {}),
    }),
  );

  return app;
}

export type Api = ReturnType<typeof createApi>;
