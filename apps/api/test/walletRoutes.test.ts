/**
 * Linking a wallet to a session's account, against a real Postgres with real
 * signatures.
 *
 * The property under test is not "does it insert a row" but "whose wallet can
 * it insert" — so both a fresh wallet and one another account already holds are
 * exercised, with genuine secp256k1 signatures rather than a stubbed verifier.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { ARC_TESTNET, buildSiweMessage } from '@stubby/shared';

import { createPostgresAccountStore, type AccountStore } from '../src/auth/accountStore.js';
import { createPostgresEmailLoginStore } from '../src/auth/emailLoginStore.js';
import { createConsoleMailer } from '../src/auth/mailer.js';
import { createPostgresRateLimiter } from '../src/auth/rateLimit.js';
import { createPostgresXLoginStore } from '../src/auth/xLoginStore.js';
import { createPostgresSessionStore, type SessionStore } from '../src/auth/sessionStore.js';
import { migrate } from '../src/db/migrate.js';
import { createPostgresNonceStore } from '../src/db/nonceStore.js';
import { createPool } from '../src/db/pool.js';
import { createApi } from '../src/http/app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const ORIGIN = 'http://localhost:8081';
const DOMAIN = 'localhost:8081';
const CHAIN_ID = ARC_TESTNET.chainId;

/** Throwaway keys. Public Anvil accounts, in .secrets-allowlist. */
const MINE = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const THEIRS = privateKeyToAccount(
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
);

const MY_EMAIL = 'link-mine@example.com';
const THEIR_EMAIL = 'link-theirs@example.com';

describe.skipIf(!DATABASE_URL)('linking a wallet', () => {
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
      siweDomain: DOMAIN,
      chainId: CHAIN_ID,
      allowedOrigins: [ORIGIN],
      secureCookies: false,
    });
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(
      `DELETE FROM account WHERE id IN (
         SELECT account_id FROM account_email WHERE email = ANY($1::text[])
         UNION SELECT account_id FROM wallet_link WHERE address = ANY($2::text[])
       )`,
      [
        [MY_EMAIL, THEIR_EMAIL],
        [MINE.address.toLowerCase(), THEIRS.address.toLowerCase()],
      ],
    );
    await pool.end();
  });

  beforeEach(async () => {
    if (pool === undefined) return;
    await pool.query(`DELETE FROM rate_limit WHERE bucket LIKE 'nonce-ip:%'`);
    await pool.query(`DELETE FROM wallet_link WHERE address = ANY($1::text[])`, [
      [MINE.address.toLowerCase(), THEIRS.address.toLowerCase()],
    ]);
  });

  async function nonce(): Promise<string> {
    const response = await api.request('/auth/siwe/nonce', { method: 'POST' });
    const { nonce: value } = (await response.json()) as { nonce: string };
    return value;
  }

  async function signedMessage(account: typeof MINE) {
    const message = buildSiweMessage({
      domain: DOMAIN,
      address: account.address,
      statement: 'Link this wallet to your Stubby account.',
      uri: ORIGIN,
      version: '1',
      chainId: CHAIN_ID,
      nonce: await nonce(),
      issuedAt: new Date().toISOString(),
    });
    return { message, signature: await account.signMessage({ message }) };
  }

  const link = (token: string | undefined, body: Record<string, unknown>) =>
    api.request('/auth/wallet/link', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const unlink = (token: string, address: string) =>
    api.request('/auth/wallet/unlink', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ address }),
    });

  async function sessionFor(email: string) {
    const account = await accounts.forEmail(email);
    const session = await sessions.issue({ accountId: account.id });
    return { account, token: session.token };
  }

  /* ----------------------------------------------------------------- link -- */

  /** The gap this exists to close: email-then-wallet used to make two accounts. */
  it('adds the wallet to the account already signed in', async () => {
    const { account, token } = await sessionFor(MY_EMAIL);
    const response = await link(token, await signedMessage(MINE));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { wallets: { address: string }[] };
    expect(body.wallets.map((w) => w.address)).toContain(MINE.address.toLowerCase());
    // One account, not two.
    expect(await accounts.ownerOfWallet(MINE.address, CHAIN_ID)).toBe(account.id);
    expect(await accounts.emailFor(account.id)).toBe(MY_EMAIL);
  });

  it('refuses without a session, rather than making a new account', async () => {
    const response = await link(undefined, await signedMessage(MINE));
    expect(response.status).toBe(401);
    expect(await accounts.ownerOfWallet(MINE.address, CHAIN_ID)).toBeNull();
  });

  /**
   * Without this, anyone could claim any address and see whose tickets it
   * holds. The session says who is asking; only the signature says it is theirs.
   */
  it('refuses a signature from a different wallet', async () => {
    const { token } = await sessionFor(MY_EMAIL);
    const { message } = await signedMessage(MINE);
    // Their signature over my message.
    const signature = await THEIRS.signMessage({ message });

    const response = await link(token, { message, signature });
    expect(response.status).toBe(401);
    expect(await accounts.ownerOfWallet(MINE.address, CHAIN_ID)).toBeNull();
  });

  it('refuses a message signed for another domain', async () => {
    const { token } = await sessionFor(MY_EMAIL);
    const message = buildSiweMessage({
      domain: 'stubby-phishing.example',
      address: MINE.address,
      uri: ORIGIN,
      version: '1',
      chainId: CHAIN_ID,
      nonce: await nonce(),
      issuedAt: new Date().toISOString(),
    });
    const response = await link(token, { message, signature: await MINE.signMessage({ message }) });
    expect(response.status).toBe(401);
  });

  it('is a success, and changes nothing, when the wallet is already yours', async () => {
    const { account, token } = await sessionFor(MY_EMAIL);
    await link(token, await signedMessage(MINE));

    const again = await link(token, await signedMessage(MINE));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ alreadyLinked: true });
    expect(await accounts.ownerOfWallet(MINE.address, CHAIN_ID)).toBe(account.id);
  });

  /**
   * The case that matters most.
   *
   * Entries and prizes belong to the wallet, so reassigning one moves who can
   * see them. A link that took over would be a way to claim somebody else's
   * history by signing a message they never see.
   */
  it('refuses a wallet another account already holds', async () => {
    const theirs = await sessionFor(THEIR_EMAIL);
    await link(theirs.token, await signedMessage(MINE));
    expect(await accounts.ownerOfWallet(MINE.address, CHAIN_ID)).toBe(theirs.account.id);

    const mine = await sessionFor(MY_EMAIL);
    const response = await link(mine.token, await signedMessage(MINE));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'wallet-taken' });
    // Still theirs.
    expect(await accounts.ownerOfWallet(MINE.address, CHAIN_ID)).toBe(theirs.account.id);
  });

  /**
   * Somebody who once signed in with the wallet alone, and now links it from
   * an email or X login. Proving both — the signature and the session — folds
   * the wallet-only account in, rather than leaving them with two.
   */
  it('folds in an account that is only this wallet', async () => {
    const old = await accounts.forWallet(MINE.address, CHAIN_ID);
    const name = `merge${Date.now() % 1_000_000}`;
    await accounts.setUsername(old.id, name);
    const oldSession = await sessions.issue({ accountId: old.id });
    const friend = await accounts.forEmail(`friend-${name}@example.com`);
    await pool.query(
      `INSERT INTO referral (referred_account_id, referrer_account_id) VALUES ($1, $2)`,
      [friend.id, old.id],
    );

    const mine = await sessionFor(MY_EMAIL);
    await accounts.setUsername(mine.account.id, null);
    const response = await link(mine.token, await signedMessage(MINE));

    expect(response.status).toBe(200);
    expect(await accounts.ownerOfWallet(MINE.address, CHAIN_ID)).toBe(mine.account.id);
    expect(await accounts.usernameFor(mine.account.id)).toBe(name);
    expect(await accounts.usernameFor(old.id)).toBeNull();
    expect(await sessions.resolve(oldSession.token)).toBeNull();
    const { rows } = await pool.query<{ referrer: string }>(
      `SELECT referrer_account_id AS referrer FROM referral WHERE referred_account_id = $1`,
      [friend.id],
    );
    expect(rows[0]?.referrer).toBe(mine.account.id);

    await accounts.setUsername(mine.account.id, null);
    await pool.query(`DELETE FROM account WHERE id = ANY($1)`, [[old.id, friend.id]]);
  });

  /**
   * A refusal must cost nothing: the caller should be able to unlink it
   * elsewhere and come straight back, not start again with a fresh nonce.
   */
  it('does not spend the nonce on a refused link', async () => {
    const theirs = await sessionFor(THEIR_EMAIL);
    await link(theirs.token, await signedMessage(MINE));

    const mine = await sessionFor(MY_EMAIL);
    const attempt = await signedMessage(MINE);
    expect((await link(mine.token, attempt)).status).toBe(409);

    // They unlink it; the same signed message now works.
    await unlink(theirs.token, MINE.address);
    expect((await link(mine.token, attempt)).status).toBe(200);
  });

  it('keeps several wallets on one account', async () => {
    const { account, token } = await sessionFor(MY_EMAIL);
    await link(token, await signedMessage(MINE));
    await link(token, await signedMessage(THEIRS));

    const wallets = await accounts.walletsFor(account.id);
    expect(wallets.map((w) => w.address).sort()).toEqual(
      [MINE.address.toLowerCase(), THEIRS.address.toLowerCase()].sort(),
    );
  });

  /* --------------------------------------------------------------- unlink -- */

  it('detaches a wallet from your own account', async () => {
    const { account, token } = await sessionFor(MY_EMAIL);
    await link(token, await signedMessage(MINE));

    const response = await unlink(token, MINE.address);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ unlinked: true });
    expect(await accounts.walletsFor(account.id)).toEqual([]);
  });

  it('cannot detach a wallet belonging to another account', async () => {
    const theirs = await sessionFor(THEIR_EMAIL);
    await link(theirs.token, await signedMessage(MINE));

    const mine = await sessionFor(MY_EMAIL);
    const response = await unlink(mine.token, MINE.address);

    // Answered as "not found", which is also all this caller is entitled to know.
    expect(await response.json()).toMatchObject({ unlinked: false });
    expect(await accounts.ownerOfWallet(MINE.address, CHAIN_ID)).toBe(theirs.account.id);
  });

  it('refuses to unlink without a session', async () => {
    const response = await api.request('/auth/wallet/unlink', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: MINE.address }),
    });
    expect(response.status).toBe(401);
  });
});
