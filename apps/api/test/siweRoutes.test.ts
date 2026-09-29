/**
 * The SIWE endpoints, end to end.
 *
 * Real Hono app, real Postgres, real secp256k1 signatures from a real (throwaway)
 * private key. Nothing here is mocked, because every part that could be mocked
 * is a part where a mock would agree with a bug: a fake nonce store cannot show
 * that a nonce is spent once, and a fake signer cannot show that a tampered
 * message stops verifying.
 *
 * Hono speaks standard `Request`/`Response`, so `app.request()` drives the real
 * routes with no server and no port.
 *
 * Skips itself without `DATABASE_URL`, so CI stays green without one.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { ARC_TESTNET, buildSiweMessage, type SiweMessage } from '@stubby/shared';

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

/** A throwaway key. Never funded, never used anywhere but here. */
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(PRIVATE_KEY);

const DOMAIN = 'localhost:8081';
const ORIGIN = 'http://localhost:8081';
const CHAIN_ID = ARC_TESTNET.chainId;

describe.skipIf(!DATABASE_URL)('SIWE endpoints', () => {
  let pool: pg.Pool;
  let sessions: SessionStore;
  let accounts: AccountStore;
  let api: ReturnType<typeof createApi>;
  const issuedNonces: string[] = [];

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
      // No chain client: these are key-pair signatures, and an RPC call per
      // test would make the suite depend on a testnet being up.
      secureCookies: false,
    });
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DELETE FROM rate_limit WHERE bucket LIKE 'nonce-ip:%'`);
    if (issuedNonces.length > 0) {
      await pool.query('DELETE FROM siwe_nonce WHERE nonce = ANY($1::text[])', [issuedNonces]);
    }
    // Deleting the account cascades to its wallet link and its sessions.
    await pool.query(
      `DELETE FROM account WHERE id IN (SELECT account_id FROM wallet_link WHERE address = $1)`,
      [account.address.toLowerCase()],
    );
    await pool.end();
  });

  /* ------------------------------------------------------------ helpers -- */

  async function getNonce(): Promise<string> {
    const response = await api.request('/auth/siwe/nonce', { method: 'POST' });
    expect(response.status).toBe(201);
    const { nonce } = (await response.json()) as { nonce: string };
    issuedNonces.push(nonce);
    return nonce;
  }

  function messageFor(nonce: string, overrides: Partial<SiweMessage> = {}): string {
    return buildSiweMessage({
      domain: DOMAIN,
      address: account.address,
      statement: 'Sign in to Stubby. This does not move any funds.',
      uri: ORIGIN,
      version: '1',
      chainId: CHAIN_ID,
      nonce,
      issuedAt: new Date().toISOString(),
      ...overrides,
    });
  }

  async function verify(message: string, signature: string, body: Record<string, unknown> = {}) {
    return api.request('/auth/siwe/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, signature, ...body }),
    });
  }

  async function signIn(overrides: Partial<SiweMessage> = {}) {
    const message = messageFor(await getNonce(), overrides);
    const signature = await account.signMessage({ message });
    return { message, signature, response: await verify(message, signature) };
  }

  /* -------------------------------------------------------------- nonce -- */

  it('issues a nonce', async () => {
    const response = await api.request('/auth/siwe/nonce', { method: 'POST' });
    const body = (await response.json()) as { nonce: string; expiresAt: string };
    issuedNonces.push(body.nonce);

    expect(response.status).toBe(201);
    expect(body.nonce).toMatch(/^[A-Za-z0-9]{8,}$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('issues a different nonce every time', async () => {
    const [a, b] = await Promise.all([getNonce(), getNonce()]);
    expect(a).not.toBe(b);
  });

  /* ------------------------------------------------------------- verify -- */

  it('signs in a wallet that signed the message it was given', async () => {
    const { response } = await signIn();
    expect(response.status).toBe(200);

    const body = (await response.json()) as { address: string; chainId: number };
    expect(body.address).toBe(account.address.toLowerCase());
    expect(body.chainId).toBe(CHAIN_ID);
  });

  it('puts the session in an httpOnly cookie by default', async () => {
    const { response } = await signIn();
    const cookie = response.headers.get('set-cookie') ?? '';

    expect(cookie).toContain('stubby_session=');
    // The whole point: an XSS cannot read it.
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('never returns the token to the browser build', async () => {
    const { response } = await signIn();
    const body = (await response.json()) as Record<string, unknown>;
    // Returning it here would hand a bearer credential to JavaScript, which is
    // exactly what the httpOnly cookie exists to avoid.
    expect(body).not.toHaveProperty('token');
  });

  it('returns a bearer token instead when the caller asks for one', async () => {
    // The Android build, where React Native's cookie handling is not something
    // to rely on and the token belongs in secure storage.
    const message = messageFor(await getNonce());
    const signature = await account.signMessage({ message });
    const response = await verify(message, signature, { session: 'token' });

    const body = (await response.json()) as { token?: string };
    expect(response.status).toBe(200);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('opens a session that resolves to the wallet that signed', async () => {
    const message = messageFor(await getNonce());
    const signature = await account.signMessage({ message });
    const response = await verify(message, signature, { session: 'token' });
    const { token } = (await response.json()) as { token: string };

    const session = await sessions.resolve(token);
    expect(session?.address).toBe(account.address.toLowerCase());
    expect(session?.chainId).toBe(CHAIN_ID);
    // Section 4: the session belongs to an account, and the wallet is what it
    // signed in with rather than what it is.
    expect(session?.accountId).toEqual(expect.any(String));
  });

  it('gives one wallet one account, however many times it signs in', async () => {
    const first = await accounts.forWallet(account.address, CHAIN_ID);
    const again = await accounts.forWallet(account.address, CHAIN_ID);
    expect(again.id).toBe(first.id);
  });

  it('finds the same account through differently cased addresses', async () => {
    // Checksum casing is presentation, not identity. A second account here
    // would split one person's logins in half.
    const lower = await accounts.forWallet(
      account.address.toLowerCase() as `0x${string}`,
      CHAIN_ID,
    );
    const mixed = await accounts.forWallet(account.address, CHAIN_ID);
    expect(mixed.id).toBe(lower.id);
  });

  /* ------------------------------------------------------------- replay -- */

  it('refuses the same signed message a second time', async () => {
    const { message, signature, response } = await signIn();
    expect(response.status).toBe(200);

    // The replay. Identical bytes, a perfectly valid signature, and it must
    // fail — the nonce is what makes a signature usable exactly once.
    const again = await verify(message, signature);
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ reason: 'nonce-spent' });
  });

  it('refuses a nonce that was never issued', async () => {
    const message = messageFor('neverIssued12345');
    const signature = await account.signMessage({ message });

    const response = await verify(message, signature);
    expect(response.status).toBe(401);
    // Unknown, expired and already-spent give one answer on purpose: telling a
    // caller which would confirm that a particular nonce once existed.
    expect(await response.json()).toMatchObject({ reason: 'nonce-spent' });
  });

  /**
   * The ordering decision, made testable.
   *
   * The nonce is spent only after the signature is shown good. If it were spent
   * first, this failed attempt would burn it and the honest retry below would
   * fail too — with nothing to tell the user why.
   */
  it('does not spend the nonce on a failed attempt', async () => {
    const nonce = await getNonce();
    const message = messageFor(nonce);

    const wrongSigner = privateKeyToAccount(
      '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
    );
    const badSignature = await wrongSigner.signMessage({ message });
    expect((await verify(message, badSignature)).status).toBe(401);

    // The same nonce still works for the wallet that should have used it.
    const goodSignature = await account.signMessage({ message });
    expect((await verify(message, goodSignature)).status).toBe(200);
  });

  /* ---------------------------------------------------------- rejection -- */

  it('refuses a message signed for another domain', async () => {
    const { response } = await signIn({ domain: 'stubby-phishing.example' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      reason: 'message-rejected',
      failures: ['domain-mismatch'],
    });
  });

  it('refuses a message signed for another chain', async () => {
    const { response } = await signIn({ chainId: 1 });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'message-rejected' });
  });

  it('refuses a message that expired', async () => {
    const { response } = await signIn({
      expirationTime: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'message-rejected' });
  });

  it('refuses a message whose address was swapped after signing', async () => {
    const nonce = await getNonce();
    const message = messageFor(nonce);
    const signature = await account.signMessage({ message });

    // One character of the address changed. The signature no longer recovers.
    const tampered = message.replace(account.address, `0x${'a'.repeat(40)}`);
    const response = await verify(tampered, signature);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'bad-signature' });
  });

  it('refuses something that is not a SIWE message at all', async () => {
    const response = await verify('hello', '0xdeadbeef');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'malformed' });
  });

  /* ------------------------------------------------------- bad requests -- */

  it('rejects a body that is not JSON', async () => {
    const response = await api.request('/auth/siwe/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('rejects a body missing the message or the signature', async () => {
    const response = await api.request('/auth/siwe/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x' }),
    });
    expect(response.status).toBe(400);
  });

  /* --------------------------------------------------------------- cors -- */

  it('lets the app origin through with credentials', async () => {
    const response = await api.request('/auth/siwe/nonce', {
      method: 'POST',
      headers: { origin: ORIGIN },
    });
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    // Without this the browser drops the session cookie.
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('does not echo an origin it was not configured with', async () => {
    const response = await api.request('/auth/siwe/nonce', {
      method: 'POST',
      headers: { origin: 'https://stubby-phishing.example' },
    });
    expect(response.headers.get('access-control-allow-origin')).not.toBe(
      'https://stubby-phishing.example',
    );
  });
});
