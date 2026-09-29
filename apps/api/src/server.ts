/**
 * The Node entry point.
 *
 * Everything it does is read configuration, fail loudly on anything missing,
 * and start listening. The app itself is built in `http/app.ts` and knows
 * nothing about the environment, which is what lets the tests drive the real
 * routes without a port.
 */

import { serve } from '@hono/node-server';

import {
  arcNetworkByChainId,
  createArcClient,
  parseBlockedCountries,
  stubbyRaffleAbi,
} from '@stubby/shared';

import { createPostgresAccountStore } from './auth/accountStore.js';
import { createPostgresEmailLoginStore } from './auth/emailLoginStore.js';
import { createPostgresRateLimiter } from './auth/rateLimit.js';
import {
  createConsoleMailer,
  createSmtpMailer,
  createUnconfiguredMailer,
  type Mailer,
} from './auth/mailer.js';
import { createPostgresSessionStore } from './auth/sessionStore.js';
import { createPostgresXLoginStore } from './auth/xLoginStore.js';
import type { XClient } from './auth/xRoutes.js';
import { createPostgresNonceStore } from './db/nonceStore.js';
import { createPool } from './db/pool.js';
import { proxycheckLookup } from './geo/lookup.js';
import { createApi } from './http/app.js';
import { trustedProxyCount } from './http/clientIp.js';
import { fcmSender } from './push/fcm.js';
import { pushToAccount } from './push/store.js';
import { probeSmtp } from './mail/probe.js';
import { activityStats, raffleEvents, recentActivity } from './watch/store.js';
import { readCuration, writeCuration, type Curation } from './curation/store.js';
import { claimReferral, markPaid, owedPayouts, referralsOf } from './referral/store.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return value;
}

const siweDomain = required('SIWE_DOMAIN');
if (siweDomain.includes('://') || siweDomain.includes('/')) {
  // EIP-4361's `domain` is an authority, not a URL. A wallet rejects every
  // signature built from the wrong shape, and the failure names nothing.
  console.error('SIWE_DOMAIN must be host[:port] only — no scheme and no path');
  process.exit(1);
}

const chainId = Number(required('ARC_CHAIN_ID'));
const network = arcNetworkByChainId(chainId);
if (network === undefined) {
  console.error(`ARC_CHAIN_ID is ${chainId}, which is not an Arc network`);
  process.exit(1);
}

/**
 * Where the browser app is served from.
 *
 * Defaults to the Expo web dev server, so a fresh checkout works. In production
 * this must be set: a browser will not send the session cookie to an origin the
 * API has not named.
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:8081')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

/**
 * Which mailer is live.
 *
 * `SMTP_HOST` and `MAIL_FROM` together turn on real delivery. Half of that
 * pair is a mistake rather than a choice, so it stops the process instead of
 * quietly falling back — a deployment that believes it is sending mail and is
 * not is the failure this whole area is arranged to prevent.
 *
 * With neither set, development prints the link and production refuses to
 * pretend. A mailer that accepted every request and delivered nothing would
 * look identical to a working system from the outside, which is the worse of
 * the two failures.
 */
function chooseMailer(): Mailer {
  const host = process.env.SMTP_HOST ?? '';
  const from = process.env.MAIL_FROM ?? '';

  if (host && !from) {
    console.error('SMTP_HOST is set but MAIL_FROM is not — refusing to guess a sender');
    process.exit(1);
  }
  if (from && !host) {
    console.error('MAIL_FROM is set but SMTP_HOST is not — no relay to send through');
    process.exit(1);
  }

  if (host && from) {
    const port = Number(process.env.SMTP_PORT ?? 25);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      console.error(`SMTP_PORT is ${process.env.SMTP_PORT}, which is not a port`);
      process.exit(1);
    }
    // EHLO announces who is connecting. The API's own domain is a name this
    // machine genuinely answers to, which is what a relay may check.
    return createSmtpMailer({ from, host, port, clientName: siweDomain });
  }

  return process.env.NODE_ENV === 'production' ? createUnconfiguredMailer() : createConsoleMailer();
}

const mailer = chooseMailer();
const appOrigin = allowedOrigins[0] ?? 'http://localhost:8081';

/**
 * The X app, when its credentials are set.
 *
 * Both or neither, for the same reason as the mailer: half a configuration is
 * a mistake, not a choice. With neither, sign in with X answers 503 and the rest
 * of the API runs. The callback defaults to the app's origin behind /api, which
 * is how the VPS serves it; it must be registered in the X developer portal.
 */
function chooseX(): XClient | null {
  const clientId = process.env.X_OAUTH_CLIENT_ID ?? '';
  const clientSecret = process.env.X_OAUTH_CLIENT_SECRET ?? '';
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    console.error('X_OAUTH_CLIENT_ID and X_OAUTH_CLIENT_SECRET must be set together');
    process.exit(1);
  }
  const redirectUri =
    process.env.X_OAUTH_REDIRECT_URI ?? `${appOrigin.replace(/\/$/, '')}/api/auth/x/callback`;
  return { clientId, clientSecret, redirectUri };
}

const x = chooseX();
const pool = createPool();

/**
 * What `/health/all` checks besides the database, for monitoring. Each only
 * when it is set up here, so a development machine without a relay or a
 * watcher is not reported as broken.
 */
const healthChecks: Record<string, () => Promise<void>> = {};
if (process.env.SMTP_HOST && process.env.MAIL_FROM) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? 25);
  healthChecks.mail = () => probeSmtp(host, port);
}
if (process.env.RAFFLE_CONTRACT_ADDRESS) {
  // The watcher saves its place in the chain every pass (every 30 seconds);
  // five minutes without that means it has stopped, or cannot reach the chain.
  healthChecks.watcher = async () => {
    const { rows } = await pool.query<{ fresh: boolean | null }>(
      "SELECT max(updated_at) > now() - interval '5 minutes' AS fresh FROM chain_cursor",
    );
    if (rows[0]?.fresh !== true) throw new Error('the watcher has not read the chain recently');
  };
}

const watchedContract = process.env.RAFFLE_CONTRACT_ADDRESS?.toLowerCase();

/**
 * Whether an address owns the raffle contract, read from the chain and kept
 * for a minute: the referral payout routes ask on every request, and the
 * owner changes rarely (a two-step transfer the owner makes themselves).
 */
const chainClient = createArcClient({
  network,
  ...(process.env.ARC_RPC_URL ? { rpcUrl: process.env.ARC_RPC_URL } : {}),
});
let ownerCache: { address: string; at: number } | undefined;
async function isOwner(address: string): Promise<boolean> {
  if (!watchedContract) return false;
  if (!ownerCache || Date.now() - ownerCache.at > 60_000) {
    const owner = await chainClient.readContract({
      address: watchedContract as `0x${string}`,
      abi: stubbyRaffleAbi,
      functionName: 'owner',
    });
    ownerCache = { address: owner.toLowerCase(), at: Date.now() };
  }
  return ownerCache.address === address.toLowerCase();
}

// The same key the watcher uses, from the same env file: lets a person send a
// test notification to their own phones.
const pusher = process.env.FCM_SERVICE_ACCOUNT_FILE
  ? fcmSender(process.env.FCM_SERVICE_ACCOUNT_FILE)
  : undefined;

// Section 11.9: who may buy from here. BLOCKED_COUNTRY_CODES overrides the
// default list (sanctions only, by the owner's decision of 2026-09-27).
const blockedCountries = parseBlockedCountries(process.env.BLOCKED_COUNTRY_CODES);
if (process.env.NODE_ENV === 'production' && trustedProxyCount() === 0) {
  // Behind Apache every request comes from 127.0.0.1 unless the forwarded
  // address is trusted: the buy check would pass everyone, and the rate
  // limits would count everyone as one visitor.
  console.warn('TRUSTED_PROXIES is 0: behind Apache, set it to 1 in api.env');
}

const api = createApi({
  geo: {
    lookup: proxycheckLookup({ apiKey: process.env.PROXYCHECK_API_KEY }),
    blocked: blockedCountries,
  },
  ...(pusher
    ? {
        pushTest: (accountId: string) =>
          pushToAccount(pool, pusher, accountId, {
            title: 'Stubby notifications are on',
            body: 'This is how you will hear the moment you win.',
            href: '/notifications',
          }),
      }
    : {}),
  ...(watchedContract
    ? {
        raffleEvents: (raffleId: bigint) =>
          raffleEvents(pool, { chainId, contract: watchedContract }, raffleId),
        activity: () => recentActivity(pool, { chainId, contract: watchedContract }),
        activityStats: () => activityStats(pool, { chainId, contract: watchedContract }),
        referrals: {
          claim: (referred: string, username: string) =>
            claimReferral(pool, { chainId, contract: watchedContract }, referred, username),
          mine: (accountId: string) => referralsOf(pool, accountId, chainId),
          owed: () => owedPayouts(pool, chainId),
          markPaid: (ids: readonly string[], txHash: string) =>
            markPaid(pool, chainId, ids, txHash),
          isOwner: (address: string) => isOwner(address),
        },
        curation: {
          read: () => readCuration(pool, { chainId, contract: watchedContract }),
          write: (next: Curation) =>
            writeCuration(pool, { chainId, contract: watchedContract }, next),
          isOwner: (address: string) => isOwner(address),
        },
      }
    : {}),
  health: async () => {
    await pool.query('SELECT 1');
  },
  healthChecks,
  nonces: createPostgresNonceStore(pool),
  sessions: createPostgresSessionStore(pool),
  accounts: createPostgresAccountStore(pool),
  logins: createPostgresEmailLoginStore(pool),
  xLogins: createPostgresXLoginStore(pool),
  x,
  limiter: createPostgresRateLimiter(pool),
  mailer,
  appOrigin,
  siweDomain,
  chainId,
  allowedOrigins,
  // Passing a client is what lets Safe and other contract accounts sign in
  // (ERC-1271). Section 4.2 says any EVM wallet.
  client: createArcClient({
    network,
    ...(process.env.ARC_RPC_URL ? { rpcUrl: process.env.ARC_RPC_URL } : {}),
  }),
  // A Secure cookie is never sent over plain http, so local development would
  // sign in and then appear not to.
  secureCookies: process.env.NODE_ENV === 'production',
});

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: api.fetch, port }, (info) => {
  console.log(`stubby-api on :${info.port} · ${network.name} · domain ${siweDomain}`);
  console.log(`cors: ${allowedOrigins.join(', ')}`);
  console.log(`mail: ${mailer.name}`);
  console.log(`x: ${x ? `callback ${x.redirectUri}` : 'not configured'}`);
  console.log(`push: ${pusher ? pusher.name : 'off (FCM_SERVICE_ACCOUNT_FILE unset)'}`);
  console.log(`geo: buying blocked in ${[...blockedCountries].sort().join(' ') || 'nowhere'}`);
});
