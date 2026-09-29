/**
 * Email sign-in, end to end against a real Postgres.
 *
 * The mailer is a recording fake — not because sending is uninteresting, but
 * because the *link* is the thing under test and a fake is the only way to read
 * it. Everything else is real: real tables, real single-use enforcement, real
 * session issuance.
 *
 * Skips itself without `DATABASE_URL`, so CI stays green without one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { createPostgresAccountStore, type AccountStore } from '../src/auth/accountStore.js';
import {
  EMAIL_LOGIN_TTL_MS,
  createPostgresEmailLoginStore,
  type EmailLoginStore,
} from '../src/auth/emailLoginStore.js';
import type { LoginEmail, Mailer } from '../src/auth/mailer.js';
import { createPostgresRateLimiter, type RateLimiter } from '../src/auth/rateLimit.js';
import { createPostgresNonceStore } from '../src/db/nonceStore.js';
import { createPostgresXLoginStore } from '../src/auth/xLoginStore.js';
import { createPostgresSessionStore, type SessionStore } from '../src/auth/sessionStore.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { createApi } from '../src/http/app.js';

const DATABASE_URL = process.env.DATABASE_URL;

const ORIGIN = 'http://localhost:8081';
const EMAIL = 'email-login-test@example.com';
const OTHER = 'email-login-other@example.com';

/** Records what would have been sent, and can be made to fail. */
function recordingMailer() {
  const sent: LoginEmail[] = [];
  let fail = false;
  const mailer: Mailer = {
    name: 'recording (test)',
    async sendLoginLink(message) {
      if (fail) throw new Error('provider refused');
      sent.push(message);
    },
  };
  return {
    mailer,
    sent,
    breakIt: () => {
      fail = true;
    },
    fixIt: () => {
      fail = false;
    },
    last: () => sent[sent.length - 1],
  };
}

describe.skipIf(!DATABASE_URL)('email sign-in', () => {
  let pool: pg.Pool;
  let api: ReturnType<typeof createApi>;
  let logins: EmailLoginStore;
  let accounts: AccountStore;
  let sessions: SessionStore;
  let limiter: RateLimiter;
  const mail = recordingMailer();

  beforeAll(async () => {
    pool = createPool({ max: 5 });
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
    logins = createPostgresEmailLoginStore(pool);
    accounts = createPostgresAccountStore(pool);
    sessions = createPostgresSessionStore(pool);
    limiter = createPostgresRateLimiter(pool);
    api = createApi({
      nonces: createPostgresNonceStore(pool),
      sessions,
      accounts,
      logins,
      xLogins: createPostgresXLoginStore(pool),
      x: null,
      mailer: mail.mailer,
      limiter,
      appOrigin: ORIGIN,
      siweDomain: 'localhost:8081',
      chainId: 5042002,
      allowedOrigins: [ORIGIN],
      secureCookies: false,
    });
  });

  afterAll(async () => {
    if (pool === undefined) return;
    // Cascades to account_email and to every session the accounts own.
    await pool.query(
      `DELETE FROM account WHERE id IN (SELECT account_id FROM account_email WHERE email = ANY($1::text[]))`,
      [[EMAIL, OTHER]],
    );
    await pool.query(`DELETE FROM email_login WHERE email = ANY($1::text[])`, [[EMAIL, OTHER]]);
    await pool.end();
  });

  beforeEach(async () => {
    mail.fixIt();
    mail.sent.length = 0;
    // Every test starts with its allowance intact, or the order of the file
    // would decide which ones pass.
    if (pool !== undefined) {
      await pool.query(`DELETE FROM rate_limit WHERE bucket LIKE 'email-request%'`);
    }
  });

  const request = (email: unknown) =>
    api.request('/auth/email/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });

  const verify = (token: unknown, extra: Record<string, unknown> = {}) =>
    api.request('/auth/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, ...extra }),
    });

  /** The token out of the link, as the landing page would read it. */
  const tokenFromLink = (link: string) => new URL(link).searchParams.get('token') as string;

  /* ------------------------------------------------------------- request -- */

  it('sends a link and says nothing about the account', async () => {
    const response = await request(EMAIL);
    expect(response.status).toBe(202);
    expect(mail.sent).toHaveLength(1);
    expect(mail.last()?.to).toBe(EMAIL);
    expect(mail.last()?.link).toContain(`${ORIGIN}/login?token=`);
  });

  /**
   * Section 4.1 makes email a handle, and a handle that can be tested for
   * existence is a list of this product's users available to anyone with a
   * script. There is no sign-up step to distinguish either.
   */
  it('answers identically for a brand new address and an existing one', async () => {
    const fresh = await request('never-seen-before@example.com');
    const existing = await request(EMAIL); // has an account by now
    expect(fresh.status).toBe(existing.status);
    expect(await fresh.json()).toEqual(expect.objectContaining({ sent: true }));
    const body = (await existing.json()) as Record<string, unknown>;
    // The shape must be identical too, not just the status: an extra field on
    // one branch would be the enumeration oracle in a different disguise.
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'sent']);
  });

  it('normalises the address, so casing cannot split an account', async () => {
    await request(`  ${EMAIL.toUpperCase()} `);
    expect(mail.last()?.to).toBe(EMAIL);
  });

  it('rejects something that could not be an address at all', async () => {
    // A client bug, not a sign-in attempt. Hiding it would make the app
    // impossible to debug.
    for (const bad of ['nope', '', '@example.com', 'a b@example.com']) {
      expect((await request(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(mail.sent).toHaveLength(0);
  });

  it('reports a provider failure rather than pretending to have sent', async () => {
    mail.breakIt();
    const response = await request(EMAIL);
    // The one place the uniform answer is dropped, and it says nothing about
    // whether the address exists — only that nothing could be sent to anybody.
    expect(response.status).toBe(502);
  });

  it('invalidates the previous link when another is asked for', async () => {
    await request(EMAIL);
    const first = tokenFromLink(mail.last()!.link);
    await request(EMAIL);
    const second = tokenFromLink(mail.last()!.link);
    expect(second).not.toBe(first);

    // Otherwise an inbox accumulates working keys every time someone taps
    // "resend" because the first did not arrive.
    expect((await verify(first)).status).toBe(401);
    expect((await verify(second)).status).toBe(200);
  });

  /* ---------------------------------------------------------- rate limit -- */

  /**
   * This endpoint makes the server send mail to an address the caller chose.
   * Unlimited, it is a way to spend a provider's quota and to put unwanted mail
   * in a stranger's inbox under this product's name — so the limit is mostly for
   * other people's benefit rather than Stubby's.
   */
  it('stops one address being asked for over and over', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await request(EMAIL)).status);
    }
    expect(statuses.filter((s) => s === 202)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    // And nothing was sent past the limit, which is the point.
    expect(mail.sent).toHaveLength(5);
  });

  it('answers a refusal with Retry-After, so a client can wait rather than hammer', async () => {
    for (let i = 0; i < 5; i += 1) await request(EMAIL);
    const refused = await request(EMAIL);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  /**
   * A refusal must not become the enumeration oracle the uniform 202 exists to
   * prevent: "this address has had five already" would confirm the address is
   * in use.
   */
  it('says nothing about which limit tripped, or about the address', async () => {
    for (let i = 0; i < 5; i += 1) await request(EMAIL);
    const body = (await (await request(EMAIL)).json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error']);
    expect(JSON.stringify(body)).not.toContain(EMAIL);
    expect(JSON.stringify(body)).not.toMatch(/address|email|exists/i);
  });

  it('limits an address independently of another', async () => {
    for (let i = 0; i < 5; i += 1) await request(EMAIL);
    expect((await request(EMAIL)).status).toBe(429);
    // A different address still has its own allowance.
    expect((await request(OTHER)).status).toBe(202);
  });

  /* -------------------------------------------------------------- verify -- */

  it('opens a session for the address that was emailed', async () => {
    await request(EMAIL);
    const response = await verify(tokenFromLink(mail.last()!.link));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { email: string; accountId: string };
    expect(body.email).toBe(EMAIL);
    expect(body.accountId).toEqual(expect.any(String));
  });

  it('puts the session in an httpOnly cookie by default', async () => {
    await request(EMAIL);
    const response = await verify(tokenFromLink(mail.last()!.link));
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('stubby_session=');
    expect(cookie).toContain('HttpOnly');
    // Lax, not Strict: this request follows a click from a mail client, and
    // Strict would drop the cookie on that navigation.
    expect(cookie).toContain('SameSite=Lax');
  });

  it('returns a bearer token instead when asked, for the native build', async () => {
    await request(EMAIL);
    const response = await verify(tokenFromLink(mail.last()!.link), { session: 'token' });
    const body = (await response.json()) as { token?: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  /**
   * A mail client prefetching the link, then the user clicking it, is the
   * ordinary case — not an attack. Exactly one of them may produce a session.
   */
  it('refuses the same link twice', async () => {
    await request(EMAIL);
    const token = tokenFromLink(mail.last()!.link);
    expect((await verify(token)).status).toBe(200);

    const again = await verify(token);
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ reason: 'link-spent' });
  });

  it('refuses a token that was never issued', async () => {
    const response = await verify('a'.repeat(43));
    expect(response.status).toBe(401);
    // Unknown, expired and already-used give one answer: saying which would
    // confirm that a particular token once existed.
    expect(await response.json()).toMatchObject({ reason: 'link-spent' });
  });

  it('refuses an expired link', async () => {
    const past = new Date(Date.now() - EMAIL_LOGIN_TTL_MS - 60_000);
    const issued = await logins.issue(EMAIL, past);
    expect((await verify(issued.token)).status).toBe(401);
  });

  it('rejects a request with no token', async () => {
    expect((await verify(undefined)).status).toBe(400);
    expect((await verify('')).status).toBe(400);
  });

  /* ------------------------------------------------------------ accounts -- */

  it('gives one address one account however many times it signs in', async () => {
    const first = await accounts.forEmail(EMAIL);
    const again = await accounts.forEmail(EMAIL.toUpperCase());
    expect(again.id).toBe(first.id);
  });

  it('keeps different addresses on different accounts', async () => {
    const a = await accounts.forEmail(EMAIL);
    const b = await accounts.forEmail(OTHER);
    expect(b.id).not.toBe(a.id);
  });

  /** An email login has no wallet, and the session has to be able to say so. */
  it('opens a session with no wallet attached', async () => {
    await request(EMAIL);
    const response = await verify(tokenFromLink(mail.last()!.link), { session: 'token' });
    const { token } = (await response.json()) as { token: string };

    const session = await sessions.resolve(token);
    expect(session?.address).toBeNull();
    expect(session?.chainId).toBeNull();
    expect(session?.accountId).toEqual(expect.any(String));
  });

  it('signs every device out of one account without touching another', async () => {
    const mine = await accounts.forEmail(EMAIL);
    const theirs = await accounts.forEmail(OTHER);
    const a = await sessions.issue({ accountId: mine.id });
    const b = await sessions.issue({ accountId: mine.id });
    const other = await sessions.issue({ accountId: theirs.id });

    expect(await sessions.revokeAllFor(mine.id)).toBeGreaterThanOrEqual(2);
    expect(await sessions.resolve(a.token)).toBeNull();
    expect(await sessions.resolve(b.token)).toBeNull();
    expect(await sessions.resolve(other.token)).not.toBeNull();
  });
});
