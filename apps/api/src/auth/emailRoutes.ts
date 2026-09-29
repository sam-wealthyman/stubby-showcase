/**
 * Passwordless email sign-in (Section 4.1).
 *
 * Two endpoints, and the same shape as SIWE: the server issues a single-use
 * credential, the user proves they received it, the server opens a session.
 *
 * Section 4.1 is explicit that email is **a handle, never verified against
 * identity**. That is worth holding onto while reading this file, because it
 * removes work that would otherwise seem necessary. There is no sign-up, no
 * password, no confirmation step and no account recovery: possession of the
 * inbox is the whole proof, and losing it loses the login and nothing else
 * (Section 4.3 — funds live with the wallet).
 */

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';

import { isUsableEmail, normaliseEmail } from '@stubby/shared';

import { clientIp } from '../http/clientIp.js';
import type { AccountStore } from './accountStore.js';
import type { EmailLoginStore } from './emailLoginStore.js';
import type { Mailer } from './mailer.js';
import { EMAIL_REQUEST_PER_ADDRESS, EMAIL_REQUEST_PER_IP, type RateLimiter } from './rateLimit.js';
import type { SessionStore } from './sessionStore.js';
import { SESSION_COOKIE } from './siweRoutes.js';

export interface EmailRouteOptions {
  logins: EmailLoginStore;
  accounts: AccountStore;
  sessions: SessionStore;
  mailer: Mailer;
  /**
   * Bounds on how often a link can be asked for.
   *
   * This endpoint makes the server send mail to an address the caller chose, so
   * unlimited it is a way to spend a provider's quota and to put unwanted mail
   * in a stranger's inbox under this product's name. The limit is mostly for
   * other people's benefit, not Stubby's.
   */
  limiter: RateLimiter;
  /**
   * Where the link points, e.g. `http://localhost:8081`.
   *
   * The app's origin, not the API's: the link lands on a page that posts the
   * token back here. Pointing it at the API would work and would put the token
   * in the API's access logs, which is a worse place for it than a browser's
   * history.
   */
  appOrigin: string;
  secureCookies?: boolean;
}

interface RequestBody {
  email?: unknown;
}

interface VerifyBody {
  token?: unknown;
  session?: unknown;
}

export function emailRoutes(options: EmailRouteOptions) {
  const { logins, accounts, sessions, mailer, limiter, appOrigin, secureCookies = true } = options;

  return (
    new Hono()
      /**
       * Ask for a link.
       *
       * **Always answers the same way**, whether or not the address has an
       * account, whether or not it is even deliverable. Section 4.1 makes email a
       * handle, and a handle that can be tested for existence is a list of this
       * product's users available to anyone with a script. There is no sign-up
       * step to distinguish either: a first sign-in creates the account.
       *
       * The consequence is that a typo is indistinguishable from success, which is
       * the accepted cost — the alternative leaks who is a user.
       */
      .post('/request', async (c) => {
        let body: RequestBody;
        try {
          body = (await c.req.json()) as RequestBody;
        } catch {
          return c.json({ error: 'expected a JSON body' }, 400);
        }

        const raw = typeof body.email === 'string' ? body.email : '';
        const email = normaliseEmail(raw);

        // The one thing worth a different answer: a string that could not be an
        // address at all is a client bug, not a sign-in attempt, and hiding it
        // would make the app impossible to debug.
        if (!isUsableEmail(email)) {
          return c.json({ error: 'that is not a usable email address' }, 400);
        }

        /*
         * Two buckets, because they answer different questions: per address stops
         * one inbox being flooded however many machines ask, and per IP stops one
         * machine flooding many inboxes. Either alone leaves the other open.
         *
         * Both are counted before anything is sent, and the address bucket is
         * counted even when the limit is already exceeded — otherwise a caller
         * could stay just under it forever by alternating.
         */
        const ip = clientIp(c);
        const [byAddress, byIp] = await Promise.all([
          limiter.hit(`email-request:${email}`, EMAIL_REQUEST_PER_ADDRESS),
          limiter.hit(`email-request-ip:${ip}`, EMAIL_REQUEST_PER_IP),
        ]);

        if (!byAddress.allowed || !byIp.allowed) {
          const resetAt = byAddress.allowed ? byIp.resetAt : byAddress.resetAt;
          const seconds = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
          // 429 with Retry-After, and no detail about which bucket tripped: saying
          // "this address has had five" would confirm the address is in use, which
          // is what the uniform answer above exists to avoid.
          return c.json({ error: 'too many requests — try again later' }, 429, {
            'Retry-After': String(seconds),
          });
        }

        const issued = await logins.issue(email);
        const link = `${appOrigin.replace(/\/$/, '')}/login?token=${encodeURIComponent(issued.token)}`;

        try {
          await mailer.sendLoginLink({ to: email, link, expiresAt: issued.expiresAt });
        } catch (error) {
          /*
           * A send failure is reported.
           *
           * This is the one place the uniform answer is dropped, and deliberately:
           * it says nothing about whether the address exists, only that this
           * server could not send anything to anybody. Swallowing it would leave
           * a user waiting for mail that was never going to arrive.
           */
          console.error(`login mail failed via ${mailer.name}: ${String(error)}`);
          return c.json({ error: 'could not send the link — try again shortly' }, 502);
        }

        // Same body for a new address and an existing one.
        return c.json({ sent: true, expiresAt: issued.expiresAt.toISOString() }, 202);
      })

      /**
       * Spend the link.
       *
       * The token is consumed **before** the account is touched, which is the
       * opposite of the SIWE ordering and right for the opposite reason. There,
       * verification is expensive and the nonce is spent last so a failure costs
       * nothing. Here the token *is* the proof, so spending it first makes a
       * replay impossible even if everything after it fails.
       */
      .post('/verify', async (c) => {
        let body: VerifyBody;
        try {
          body = (await c.req.json()) as VerifyBody;
        } catch {
          return c.json({ error: 'expected a JSON body' }, 400);
        }

        if (typeof body.token !== 'string' || body.token.length === 0) {
          return c.json({ error: 'token is required' }, 400);
        }

        const email = await logins.consume(body.token);
        if (email === null) {
          // Unknown, expired, or already used — one answer, because saying which
          // would confirm that a particular token once existed.
          return c.json({ error: 'that link is no longer valid', reason: 'link-spent' }, 401);
        }

        const account = await accounts.forEmail(email);
        const session = await sessions.issue({ accountId: account.id });

        const wantsToken = body.session === 'token';
        if (!wantsToken) {
          setCookie(c, SESSION_COOKIE, session.token, {
            httpOnly: true,
            secure: secureCookies,
            // Lax, not Strict: this request follows a click from an email client,
            // and Strict would drop the cookie on that navigation.
            sameSite: 'Lax',
            path: '/',
            expires: session.expiresAt,
          });
        }

        return c.json({
          accountId: session.accountId,
          email,
          expiresAt: session.expiresAt.toISOString(),
          ...(wantsToken ? { token: session.token } : {}),
        });
      })
  );
}
