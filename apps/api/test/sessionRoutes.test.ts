/**
 * Reading a session back and ending one, against a real Postgres.
 *
 * Both login methods are exercised, because the shapes differ: a wallet session
 * knows which wallet it signed in with and an email session has none.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { createPostgresAccountStore, type AccountStore } from '../src/auth/accountStore.js';
import { createPostgresEmailLoginStore } from '../src/auth/emailLoginStore.js';
import { createConsoleMailer } from '../src/auth/mailer.js';
import { createPostgresRateLimiter } from '../src/auth/rateLimit.js';
import { createPostgresXLoginStore } from '../src/auth/xLoginStore.js';
import { createPostgresSessionStore, type SessionStore } from '../src/auth/sessionStore.js';
import { SESSION_COOKIE } from '../src/auth/siweRoutes.js';
import { migrate } from '../src/db/migrate.js';
import { createPostgresNonceStore } from '../src/db/nonceStore.js';
import { createPool } from '../src/db/pool.js';
import { createApi } from '../src/http/app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const ORIGIN = 'http://localhost:8081';
const EMAIL = 'session-test@example.com';
const WALLET = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const CHAIN_ID = 5042002;

describe.skipIf(!DATABASE_URL)('session routes', () => {
  let pool: pg.Pool;
  let api: ReturnType<typeof createApi>;
  let sessions: SessionStore;
  let accounts: AccountStore;

  beforeAll(async () => {
    pool = createPool({ max: 5 });
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
    sessions = createPostgresSessionStore(pool);
    accounts = createPostgresAccountStore(pool);
    api = createApi({
      nonces: createPostgresNonceStore(pool),
      sessions,
      accounts,
      logins: createPostgresEmailLoginStore(pool),
      xLogins: createPostgresXLoginStore(pool),
      x: null,
      mailer: createConsoleMailer(),
      limiter: createPostgresRateLimiter(pool),
      appOrigin: ORIGIN,
      siweDomain: 'localhost:8081',
      chainId: CHAIN_ID,
      allowedOrigins: [ORIGIN],
      secureCookies: false,
    });
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(
      `DELETE FROM account WHERE id IN (
         SELECT account_id FROM account_email WHERE email = $1
         UNION SELECT account_id FROM wallet_link WHERE address = $2
       )`,
      [EMAIL, WALLET.address.toLowerCase()],
    );
    await pool.end();
  });

  beforeEach(async () => {
    if (pool !== undefined) {
      await pool.query(`DELETE FROM rate_limit WHERE bucket LIKE 'nonce-ip:%'`);
    }
  });

  const get = (headers: Record<string, string> = {}) => api.request('/auth/session', { headers });
  const post = (path: string, headers: Record<string, string> = {}) =>
    api.request(path, { method: 'POST', headers });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });

  /* ---------------------------------------------------------------- read -- */

  /**
   * Not being signed in is an ordinary state, not an error.
   *
   * This is the first call the app makes on load, and a 401 would be an error in
   * every console and a rejected promise in every client for the common case of
   * a new visitor.
   */
  it('answers 200 and signedIn:false with no session', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedIn: false });
  });

  it('reads a session from a bearer token', async () => {
    const account = await accounts.forEmail(EMAIL);
    const session = await sessions.issue({ accountId: account.id });

    const body = (await (await get(bearer(session.token))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ signedIn: true, accountId: account.id, email: EMAIL });
  });

  it('reads a session from the cookie', async () => {
    const account = await accounts.forEmail(EMAIL);
    const session = await sessions.issue({ accountId: account.id });

    const body = (await (await get(cookie(session.token))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ signedIn: true, accountId: account.id });
  });

  /** An email login has no wallet, and the answer has to be able to say so. */
  it('reports no wallet for an email session', async () => {
    const account = await accounts.forEmail(EMAIL);
    const session = await sessions.issue({ accountId: account.id });

    const body = (await (await get(bearer(session.token))).json()) as {
      signedInWith: unknown;
      wallets: unknown[];
    };
    expect(body.signedInWith).toBeNull();
    expect(body.wallets).toEqual([]);
  });

  it('turns result mail off and on, and a mail link turns it off', async () => {
    const account = await accounts.forEmail(EMAIL);
    const session = await sessions.issue({ accountId: account.id });
    const resultEmails = async () =>
      ((await (await get(bearer(session.token))).json()) as { resultEmails: boolean }).resultEmails;
    const set = (on: boolean) =>
      api.request('/auth/session/mail', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bearer(session.token) },
        body: JSON.stringify({ resultEmails: on }),
      });

    expect(await resultEmails()).toBe(true);
    expect((await set(false)).status).toBe(200);
    expect(await resultEmails()).toBe(false);
    expect((await set(true)).status).toBe(200);
    expect(await resultEmails()).toBe(true);

    // The link in a mail: one click, from a mail client, turns it off.
    const { rows } = await pool.query<{ t: string }>(
      `UPDATE account SET mail_token = 'test-token-0123456789abcdef' WHERE id = $1 RETURNING mail_token AS t`,
      [account.id],
    );
    const url = `/mail/unsubscribe?t=${rows[0]!.t}`;
    expect((await api.request(url, { method: 'POST' })).status).toBe(200);
    expect(await resultEmails()).toBe(false);
    expect((await api.request(url)).status).toBe(200);
    expect((await api.request('/mail/unsubscribe?t=nope-nope-nope-nope')).status).toBe(404);
  });

  it('registers a phone for push, turns push off and on, and forgets the phone', async () => {
    const account = await accounts.forEmail(EMAIL);
    const session = await sessions.issue({ accountId: account.id });
    const push = (body: object) =>
      api.request('/auth/session/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bearer(session.token) },
        body: JSON.stringify(body),
      });
    const token = 'session-test-phone-token-000000001';
    expect((await push({ token, platform: 'android' })).status).toBe(200);
    const devices = async () =>
      (
        await pool.query('SELECT 1 FROM push_device WHERE token = $1 AND account_id = $2', [
          token,
          account.id,
        ])
      ).rowCount;
    expect(await devices()).toBe(1);

    const pushOn = async () =>
      ((await (await get(bearer(session.token))).json()) as { pushOn: boolean }).pushOn;
    expect(await pushOn()).toBe(true);
    await push({ on: false });
    expect(await pushOn()).toBe(false);
    await push({ on: true });
    expect(await pushOn()).toBe(true);

    // No push key in this test server: the test route says so plainly.
    const test = await api.request('/auth/session/push/test', {
      method: 'POST',
      headers: bearer(session.token),
    });
    expect(test.status).toBe(503);

    await push({ token, remove: true });
    expect(await devices()).toBe(0);
    expect((await push({ token: 'short' })).status).toBe(400);
  });

  it('reports the wallet a wallet session signed in with', async () => {
    const account = await accounts.forWallet(WALLET.address, CHAIN_ID);
    const session = await sessions.issue({
      accountId: account.id,
      wallet: { address: WALLET.address, chainId: CHAIN_ID },
    });

    const body = (await (await get(bearer(session.token))).json()) as {
      signedInWith: { address: string; chainId: number };
      wallets: { address: string }[];
      email: string | null;
    };
    expect(body.signedInWith.address).toBe(WALLET.address.toLowerCase());
    expect(body.signedInWith.chainId).toBe(CHAIN_ID);
    expect(body.wallets.map((w) => w.address)).toContain(WALLET.address.toLowerCase());
    expect(body.email).toBeNull();
  });

  it('lists only the wallets on this chain', async () => {
    // A wallet used on testnet and carried over to mainnet: one link per chain.
    const account = await accounts.forWallet(WALLET.address, CHAIN_ID);
    await accounts.linkWallet(account.id, WALLET.address, 5042);
    const session = await sessions.issue({
      accountId: account.id,
      wallet: { address: WALLET.address, chainId: CHAIN_ID },
    });

    const body = (await (await get(bearer(session.token))).json()) as {
      wallets: { address: string; chainId: number }[];
    };
    expect(body.wallets).toEqual([
      expect.objectContaining({ address: WALLET.address.toLowerCase(), chainId: CHAIN_ID }),
    ]);
  });

  it('treats an unknown token as not signed in, and clears the cookie', async () => {
    const response = await get(cookie('nonsense'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedIn: false });
    // Otherwise every later request carries a credential that will never work.
    expect(response.headers.get('set-cookie') ?? '').toMatch(
      /stubby_session=;|Max-Age=0|Expires=/i,
    );
  });

  it('treats an expired session as not signed in', async () => {
    const account = await accounts.forEmail(EMAIL);
    const past = new Date(Date.now() - 60 * 60 * 1000 * 24 * 365);
    const session = await sessions.issue({ accountId: account.id, now: past });
    expect(await (await get(bearer(session.token))).json()).toEqual({ signedIn: false });
  });

  /* ------------------------------------------------------------- signout -- */

  it('ends the session it was given', async () => {
    const account = await accounts.forEmail(EMAIL);
    const session = await sessions.issue({ accountId: account.id });

    expect((await post('/auth/session/signout', bearer(session.token))).status).toBe(200);
    expect(await sessions.resolve(session.token)).toBeNull();
    expect(await (await get(bearer(session.token))).json()).toEqual({ signedIn: false });
  });

  /**
   * Idempotent, and deliberately silent about whether there was one to end:
   * "there was no session" is information about somebody else's token when the
   * request carries one that is not yours.
   */
  it('answers the same whether or not there was a session', async () => {
    const withNone = await post('/auth/session/signout');
    const withJunk = await post('/auth/session/signout', bearer('nonsense'));
    expect(withNone.status).toBe(200);
    expect(await withNone.json()).toEqual({ signedOut: true });
    expect(await withJunk.json()).toEqual({ signedOut: true });
  });

  it('leaves other sessions of the same account alone', async () => {
    const account = await accounts.forEmail(EMAIL);
    const phone = await sessions.issue({ accountId: account.id });
    const laptop = await sessions.issue({ accountId: account.id });

    await post('/auth/session/signout', bearer(phone.token));
    expect(await sessions.resolve(phone.token)).toBeNull();
    expect(await sessions.resolve(laptop.token)).not.toBeNull();
  });

  /* --------------------------------------------------------- signout-all -- */

  it('ends every session of the account', async () => {
    const account = await accounts.forEmail(EMAIL);
    const phone = await sessions.issue({ accountId: account.id });
    const laptop = await sessions.issue({ accountId: account.id });

    const response = await post('/auth/session/signout-all', bearer(phone.token));
    expect(response.status).toBe(200);
    expect(await sessions.resolve(phone.token)).toBeNull();
    expect(await sessions.resolve(laptop.token)).toBeNull();
  });

  /**
   * Not idempotent, unlike signout: "sign out everywhere" without proof of who
   * you are would be a way to sign other people out.
   */
  it('refuses to sign everyone out without a valid session', async () => {
    expect((await post('/auth/session/signout-all')).status).toBe(401);
    expect((await post('/auth/session/signout-all', bearer('nonsense'))).status).toBe(401);
  });

  it('does not touch another account', async () => {
    const mine = await accounts.forEmail(EMAIL);
    const theirs = await accounts.forWallet(WALLET.address, CHAIN_ID);
    const ours = await sessions.issue({ accountId: mine.id });
    const other = await sessions.issue({ accountId: theirs.id });

    await post('/auth/session/signout-all', bearer(ours.token));
    expect(await sessions.resolve(other.token)).not.toBeNull();
  });

  /* ------------------------------------------------------------ username -- */

  describe('username', () => {
    const setName = (token: string, username: unknown) =>
      api.request('/auth/session/username', {
        method: 'POST',
        headers: { ...bearer(token), 'content-type': 'application/json' },
        body: JSON.stringify({ username }),
      });

    it('sets, reads back and clears a username', async () => {
      const account = await accounts.forEmail(EMAIL);
      const session = await sessions.issue({ accountId: account.id });
      const name = `Jack${Date.now() % 100000}`;

      const set = await setName(session.token, name);
      expect(set.status).toBe(200);
      expect(await (await get(bearer(session.token))).json()).toMatchObject({ username: name });

      expect((await setName(session.token, null)).status).toBe(200);
      expect(await (await get(bearer(session.token))).json()).toMatchObject({ username: null });
    });

    it('refuses a name another account holds, in any case', async () => {
      const mine = await accounts.forEmail(EMAIL);
      const theirs = await accounts.forWallet(WALLET.address, CHAIN_ID);
      const name = `Ada${Date.now() % 100000}`;
      await accounts.setUsername(theirs.id, name);

      const session = await sessions.issue({ accountId: mine.id });
      const res = await setName(session.token, name.toUpperCase());
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: 'taken' });
      await accounts.setUsername(theirs.id, null);
    });

    it('refuses a malformed or reserved name, saying why', async () => {
      const account = await accounts.forEmail(EMAIL);
      const session = await sessions.issue({ accountId: account.id });
      for (const [bad, reason] of [
        ['ab', 'length'],
        ['jack smith', 'characters'],
        ['Stubby', 'reserved'],
      ] as const) {
        const res = await setName(session.token, bad);
        expect(res.status, bad).toBe(400);
        expect(await res.json(), bad).toMatchObject({ reason });
      }
    });

    it('needs a session', async () => {
      const res = await api.request('/auth/session/username', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'Nobody' }),
      });
      expect(res.status).toBe(401);
    });
  });
});
