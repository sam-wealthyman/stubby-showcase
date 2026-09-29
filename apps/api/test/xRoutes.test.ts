/**
 * Sign in with X, end to end against a real Postgres, with X itself faked.
 *
 * The fake records what the API sent to X, so the tests can check the PKCE
 * pair actually matches: a verifier that does not hash to the challenge would
 * pass every other assertion here and fail against the real X.
 *
 * Skips itself without `DATABASE_URL`, so CI stays green without one.
 */

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { createPostgresAccountStore } from '../src/auth/accountStore.js';
import { createPostgresEmailLoginStore } from '../src/auth/emailLoginStore.js';
import { createConsoleMailer } from '../src/auth/mailer.js';
import { createPostgresRateLimiter } from '../src/auth/rateLimit.js';
import { createPostgresSessionStore } from '../src/auth/sessionStore.js';
import { createPostgresXLoginStore } from '../src/auth/xLoginStore.js';
import { X_ME_URL, X_STATE_COOKIE, X_TOKEN_URL, type XClient } from '../src/auth/xRoutes.js';
import { migrate } from '../src/db/migrate.js';
import { createPostgresNonceStore } from '../src/db/nonceStore.js';
import { createPool } from '../src/db/pool.js';
import { createApi } from '../src/http/app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const ORIGIN = 'http://localhost:8081';
const X_USER = 'x-login-test-1';

const CLIENT: XClient = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUri: `${ORIGIN}/api/auth/x/callback`,
};

/** Stands in for X's token and profile endpoints. */
function fakeX() {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let username = 'stubby_tester';
  let tokenStatus = 200;
  const stand: typeof globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === X_TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: 'x-access', token_type: 'bearer' }), {
        status: tokenStatus,
      });
    }
    if (url === X_ME_URL) {
      return new Response(JSON.stringify({ data: { id: X_USER, username, name: 'Tester' } }));
    }
    return new Response('not found', { status: 404 });
  };
  return {
    fetch: stand,
    calls,
    rename: (to: string) => {
      username = to;
    },
    refuseToken: (status: number) => {
      tokenStatus = status;
    },
  };
}

describe.skipIf(!DATABASE_URL)('sign in with X', () => {
  let pool: pg.Pool;
  const x = fakeX();
  const build = (client: XClient | null) =>
    createApi({
      nonces: createPostgresNonceStore(pool),
      sessions: createPostgresSessionStore(pool),
      accounts: createPostgresAccountStore(pool),
      logins: createPostgresEmailLoginStore(pool),
      xLogins: createPostgresXLoginStore(pool),
      x: client,
      xFetch: x.fetch,
      mailer: createConsoleMailer(),
      limiter: createPostgresRateLimiter(pool),
      appOrigin: ORIGIN,
      siweDomain: 'localhost:8081',
      chainId: 5042002,
      allowedOrigins: [ORIGIN],
      secureCookies: false,
    });
  let api: ReturnType<typeof createApi>;

  beforeAll(async () => {
    pool = createPool({ max: 5 });
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
    api = build(CLIENT);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(
      `DELETE FROM account WHERE id IN (SELECT account_id FROM account_x WHERE x_user_id = $1)`,
      [X_USER],
    );
    await pool.end();
  });

  beforeEach(async () => {
    x.calls.length = 0;
    x.refuseToken(200);
    await pool.query(`DELETE FROM rate_limit WHERE bucket LIKE 'x-start%'`);
  });

  /** Start a sign-in, returning the state X would echo and the browser's cookie. */
  async function start() {
    const response = await api.request('/auth/x/start');
    expect(response.status).toBe(302);
    const to = new URL(response.headers.get('location') as string);
    const cookie = /stubby_x_state=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
    return { to, state: to.searchParams.get('state') as string, cookie: cookie as string };
  }

  const callback = (query: string, cookie?: string) =>
    api.request(`/auth/x/callback?${query}`, {
      headers: cookie ? { cookie: `${X_STATE_COOKIE}=${cookie}` } : {},
    });

  const sessionFrom = (response: Response) =>
    /stubby_session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];

  it('sends the browser to X with PKCE and the least scope', async () => {
    const { to, state, cookie } = await start();
    expect(`${to.origin}${to.pathname}`).toBe('https://x.com/i/oauth2/authorize');
    expect(to.searchParams.get('client_id')).toBe('test-client');
    expect(to.searchParams.get('redirect_uri')).toBe(CLIENT.redirectUri);
    expect(to.searchParams.get('scope')).toBe('users.read tweet.read');
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(cookie).toBe(state);
  });

  it('signs in, and the verifier sent to X hashes to the challenge', async () => {
    const { to, state, cookie } = await start();
    const response = await callback(`code=abc&state=${state}`, cookie);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/home`);

    const exchange = x.calls.find((call) => call.url === X_TOKEN_URL);
    const body = new URLSearchParams(String(exchange?.init?.body));
    const verifier = body.get('code_verifier') as string;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      to.searchParams.get('code_challenge'),
    );
    expect(body.get('code')).toBe('abc');

    const token = sessionFrom(response);
    expect(token).toBeDefined();
    const session = await api.request('/auth/session', {
      headers: { cookie: `stubby_session=${token}` },
    });
    const json = (await session.json()) as {
      signedIn: boolean;
      xUsername: string | null;
      createdAt: string | null;
    };
    expect(json.signedIn).toBe(true);
    expect(json.xUsername).toBe('stubby_tester');
    // "Member since": the account's first appearance, as a date the app can read.
    expect(Number.isNaN(Date.parse(json.createdAt ?? ''))).toBe(false);
  });

  it('hands the Android app a one-time code instead of a cookie', async () => {
    const started = await api.request('/auth/x/start?app=1');
    const to = new URL(started.headers.get('location') as string);
    const setCookies = started.headers.get('set-cookie') ?? '';
    expect(setCookies).toContain('stubby_x_app=1');
    const state = to.searchParams.get('state') as string;

    const response = await api.request(`/auth/x/callback?code=abc&state=${state}`, {
      headers: { cookie: `${X_STATE_COOKIE}=${state}; stubby_x_app=1` },
    });
    expect(response.status).toBe(302);
    const back = new URL(response.headers.get('location') as string);
    expect(back.pathname).toBe('/login');
    expect(sessionFrom(response)).toBeUndefined(); // no browser session
    const code = back.searchParams.get('x') as string;

    const exchange = (value: string) =>
      api.request('/auth/x/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: value }),
      });
    const first = await exchange(code);
    expect(first.status).toBe(200);
    const { token } = (await first.json()) as { token: string };
    const me = await api.request('/auth/session', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await me.json()) as { xUsername: string }).xUsername).toBe('stubby_tester');

    // Single use.
    expect((await exchange(code)).status).toBe(401);
  });

  it('sends an app sign-in that failed back into the app, saying why', async () => {
    const started = await api.request('/auth/x/start?app=1');
    const state = new URL(started.headers.get('location') as string).searchParams.get('state');
    const response = await api.request(`/auth/x/callback?error=access_denied&state=${state}`, {
      headers: { cookie: `${X_STATE_COOKIE}=${state}; stubby_x_app=1` },
    });
    expect(response.headers.get('location')).toMatch(/\/login\?xerr=denied$/);
  });

  it('finds the same account next time, under a new handle', async () => {
    const first = await start();
    const a = sessionFrom(await callback(`code=1&state=${first.state}`, first.cookie));
    x.rename('renamed_tester');
    const second = await start();
    const b = sessionFrom(await callback(`code=2&state=${second.state}`, second.cookie));

    const idOf = async (token: string | undefined) => {
      const r = await api.request('/auth/session', {
        headers: { cookie: `stubby_session=${token}` },
      });
      return (await r.json()) as { accountId: string; xUsername: string };
    };
    const [one, two] = await Promise.all([idOf(a), idOf(b)]);
    expect(two.accountId).toBe(one.accountId);
    expect(two.xUsername).toBe('renamed_tester');
    x.rename('stubby_tester');
  });

  it('refuses a callback from a browser that did not start it', async () => {
    const { state } = await start();
    const response = await callback(`code=abc&state=${state}`, 'somebody-elses');
    expect(response.headers.get('location')).toBe(`${ORIGIN}/?x=failed`);
    expect(sessionFrom(response)).toBeUndefined();
    expect(x.calls).toHaveLength(0);
  });

  it('refuses a replayed callback', async () => {
    const { state, cookie } = await start();
    await callback(`code=abc&state=${state}`, cookie);
    const again = await callback(`code=abc&state=${state}`, cookie);
    expect(again.headers.get('location')).toBe(`${ORIGIN}/?x=expired`);
    expect(sessionFrom(again)).toBeUndefined();
  });

  it('sends a cancel on X back to the app', async () => {
    const { state, cookie } = await start();
    const response = await callback(`error=access_denied&state=${state}`, cookie);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/?x=denied`);
  });

  it('opens no session when X refuses the code', async () => {
    x.refuseToken(400);
    const { state, cookie } = await start();
    const response = await callback(`code=bad&state=${state}`, cookie);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/?x=failed`);
    expect(sessionFrom(response)).toBeUndefined();
  });

  it('answers 503 while X is not configured', async () => {
    const off = build(null);
    expect((await off.request('/auth/x/start')).status).toBe(503);
  });
});
