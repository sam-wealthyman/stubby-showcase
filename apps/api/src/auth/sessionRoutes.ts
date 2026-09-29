/**
 * Reading a session back, and ending one.
 *
 * Without these, signing in sets a cookie that nothing ever looks at: the app
 * cannot tell on a later visit whether it is signed in, and there is no way out
 * short of waiting two weeks for the session to expire.
 *
 * Section 4 again decides the shape. A session proves **who is signed in**, and
 * never what they may spend — entries and prizes belong to the wallet and the
 * chain is the source of truth (4.2). So `GET /auth/session` reports an account,
 * its email and its linked wallets, and nothing here can move money.
 */

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';

import { checkUsername } from '@stubby/shared';

import type { AccountStore } from './accountStore.js';
import { sessionTokenFrom } from './bearer.js';
import type { SessionStore } from './sessionStore.js';
import { SESSION_COOKIE } from './siweRoutes.js';

export interface SessionRouteOptions {
  sessions: SessionStore;
  accounts: AccountStore;
  /**
   * The chain this server runs on. An account keeps its wallet links for every
   * chain (testnet's stayed when the site moved to mainnet), but only this
   * one's are shown: the same address twice, once per chain, reads as a bug.
   */
  chainId: number;
  /** Sends a test push to an account's own phones; unset when push is off. */
  pushTest?: (accountId: string) => Promise<number>;
  secureCookies?: boolean;
}

export function sessionRoutes(options: SessionRouteOptions) {
  const { sessions, accounts, chainId, secureCookies = true, pushTest } = options;

  /** The token for this request, from the header or the cookie. */
  const tokenOf = (c: Context) =>
    sessionTokenFrom({
      authorization: c.req.header('authorization'),
      cookie: getCookie(c, SESSION_COOKIE),
    });

  return (
    new Hono()
      /**
       * Who is signed in.
       *
       * **200 with `signedIn: false` rather than 401 when there is no session.**
       * Not being signed in is an ordinary state, not an error: this is the first
       * call the app makes on load, and a 401 there would be an error in every
       * console and a rejected promise in every client for the common case of a
       * new visitor.
       */
      .get('/', async (c) => {
        const token = tokenOf(c);
        if (token === undefined) return c.json({ signedIn: false as const });

        const session = await sessions.resolve(token);
        if (session === null) {
          /*
           * The token was presented and is no longer good — expired, revoked, or
           * never ours. The cookie is cleared so the browser stops sending it;
           * otherwise every request carries a credential that will never work
           * again, and the app looks signed-out while behaving as though it might
           * not be.
           */
          deleteCookie(c, SESSION_COOKIE, { path: '/', secure: secureCookies, sameSite: 'Lax' });
          return c.json({ signedIn: false as const });
        }

        const [email, allWallets, xUsername, createdAt, username, resultEmails, pushOn] =
          await Promise.all([
            accounts.emailFor(session.accountId),
            accounts.walletsFor(session.accountId),
            accounts.xUsernameFor(session.accountId),
            accounts.createdAtFor(session.accountId),
            accounts.usernameFor(session.accountId),
            accounts.resultEmailsFor(session.accountId),
            accounts.pushOnFor(session.accountId),
          ]);

        const wallets = allWallets.filter((w) => w.chainId === chainId);

        return c.json({
          signedIn: true as const,
          accountId: session.accountId,
          email,
          xUsername,
          /** The public name shown in place of this account's wallets in live activity. */
          username,
          /** Whether draw results and referral news are emailed. */
          resultEmails,
          /** Whether this account's phones get push notifications. */
          pushOn,
          /** When the account first appeared, for "member since". */
          createdAt: createdAt?.toISOString() ?? null,
          wallets,
          /** The wallet this session signed in with, which an email login has none of. */
          signedInWith:
            session.address === null
              ? null
              : { address: session.address, chainId: session.chainId },
          expiresAt: session.expiresAt.toISOString(),
        });
      })

      /**
       * A test notification to this account's own phones, and nobody else's.
       * 503 while the server has no push key; `reached` is how many phones.
       */
      .post('/push/test', async (c) => {
        const token = tokenOf(c);
        const session = token === undefined ? null : await sessions.resolve(token);
        if (session === null) return c.json({ error: 'sign in first' }, 401);
        if (!pushTest) return c.json({ error: 'push is not set up on the server' }, 503);
        return c.json({ reached: await pushTest(session.accountId) });
      })

      /**
       * Push notifications. `{ token, platform }` registers this phone to the
       * account; `{ token, remove: true }` forgets it (sign out);
       * `{ on: boolean }` turns push on or off for every phone.
       */
      .post('/push', async (c) => {
        const token = tokenOf(c);
        const session = token === undefined ? null : await sessions.resolve(token);
        if (session === null) return c.json({ error: 'sign in first' }, 401);
        let body: { token?: unknown; platform?: unknown; remove?: unknown; on?: unknown };
        try {
          body = (await c.req.json()) as typeof body;
        } catch {
          return c.json({ reason: 'malformed' }, 400);
        }
        if (typeof body.on === 'boolean') {
          await accounts.setPushOn(session.accountId, body.on);
          return c.json({ pushOn: body.on });
        }
        if (typeof body.token !== 'string' || body.token.length < 20 || body.token.length > 4096) {
          return c.json({ reason: 'malformed' }, 400);
        }
        if (body.remove === true) {
          await accounts.removePush(session.accountId, body.token);
          return c.json({ removed: true });
        }
        const platform = body.platform === 'ios' ? 'ios' : 'android';
        await accounts.registerPush(session.accountId, body.token, platform);
        return c.json({ registered: true });
      })

      /**
       * Turn result and referral mail on or off: `{ resultEmails: boolean }`.
       * Login links are not affected; they are only ever sent when asked for.
       */
      .post('/mail', async (c) => {
        const token = tokenOf(c);
        const session = token === undefined ? null : await sessions.resolve(token);
        if (session === null) return c.json({ error: 'sign in first' }, 401);
        let body: { resultEmails?: unknown };
        try {
          body = (await c.req.json()) as typeof body;
        } catch {
          return c.json({ reason: 'malformed' }, 400);
        }
        if (typeof body.resultEmails !== 'boolean') return c.json({ reason: 'malformed' }, 400);
        await accounts.setResultEmails(session.accountId, body.resultEmails);
        return c.json({ resultEmails: body.resultEmails });
      })

      /**
       * Set or clear the public username. Needs a valid session: a name is
       * shown in place of this account's wallets, so only the account may
       * choose it. `{ username: null }` clears it.
       */
      .post('/username', async (c) => {
        const token = tokenOf(c);
        const session = token === undefined ? null : await sessions.resolve(token);
        if (session === null) return c.json({ reason: 'signed-out' }, 401);

        let body: { username?: unknown };
        try {
          body = await c.req.json();
        } catch {
          return c.json({ reason: 'malformed' }, 400);
        }
        if (body.username === null) {
          await accounts.setUsername(session.accountId, null);
          return c.json({ username: null });
        }
        if (typeof body.username !== 'string') return c.json({ reason: 'malformed' }, 400);

        const checked = checkUsername(body.username);
        if (!checked.ok) {
          return c.json({ reason: checked.reason, detail: checked.message }, 400);
        }
        const outcome = await accounts.setUsername(session.accountId, checked.username);
        if (outcome === 'taken') {
          return c.json({ reason: 'taken', detail: 'That name is taken.' }, 409);
        }
        return c.json({ username: checked.username });
      })

      /**
       * End this session.
       *
       * Idempotent, and deliberately says nothing about whether there was a
       * session to end: a signed-out user pressing sign out again should see the
       * same thing, and "there was no session" is information about somebody
       * else's token when the request carries one that is not yours.
       */
      .post('/signout', async (c) => {
        const token = tokenOf(c);
        if (token !== undefined) await sessions.revoke(token);
        deleteCookie(c, SESSION_COOKIE, { path: '/', secure: secureCookies, sameSite: 'Lax' });
        return c.json({ signedOut: true as const });
      })

      /**
       * End every session for this account.
       *
       * The one to reach for after a device is lost. It requires a **valid**
       * session rather than being idempotent, because "sign out everywhere"
       * without proof of who you are would be a way to sign other people out.
       */
      .post('/signout-all', async (c) => {
        const token = tokenOf(c);
        const session = token === undefined ? null : await sessions.resolve(token);
        if (session === null) return c.json({ error: 'not signed in' }, 401);

        const ended = await sessions.revokeAllFor(session.accountId);
        deleteCookie(c, SESSION_COOKIE, { path: '/', secure: secureCookies, sameSite: 'Lax' });
        return c.json({ signedOut: true as const, sessionsEnded: ended });
      })
  );
}
