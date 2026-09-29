/**
 * Sign in with X (Section 4.1): OAuth 2.0, authorization code with PKCE.
 *
 * Two browser navigations, not API calls:
 *
 *   GET /auth/x/start     sends the browser to X to approve Stubby
 *   GET /auth/x/callback  X sends it back with a code, which is exchanged
 *                         server-side for a token, the token names the X user,
 *                         and a session cookie is set
 *
 * The X token is used once, to ask who the user is, and then dropped. Stubby
 * asks for `users.read tweet.read`, the least X allows for reading a profile,
 * and never posts or reads anything else.
 *
 * Like every other login this proves who is signed in, never what they may
 * spend. Funds belong to the wallet (Section 4.3).
 */

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import { clientIp } from '../http/clientIp.js';
import type { AccountStore } from './accountStore.js';
import type { RateLimiter } from './rateLimit.js';
import type { SessionStore } from './sessionStore.js';
import { SESSION_COOKIE } from './siweRoutes.js';
import { X_LOGIN_TTL_MS, type XLoginStore } from './xLoginStore.js';

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const X_ME_URL = 'https://api.x.com/2/users/me';
export const X_SCOPES = 'users.read tweet.read';

/**
 * Binds the callback to the browser that started it.
 *
 * Without this, anyone could start a sign-in with their own X account, stop
 * before the callback, and send the link to someone else, who would land signed
 * in as the attacker. With it, the callback only works in the browser holding
 * the matching cookie.
 */
export const X_STATE_COOKIE = 'stubby_x_state';

/** Set by `/start?app=1`: this sign-in began in the Android app. */
export const X_APP_COOKIE = 'stubby_x_app';

/** Per IP, per hour: starting a sign-in writes a row, so it is bounded. */
export const X_START_PER_IP = { max: 30, windowMs: 60 * 60 * 1000 };

export interface XClient {
  clientId: string;
  clientSecret: string;
  /** Must match, byte for byte, a callback registered in the X developer portal. */
  redirectUri: string;
}

export interface XRouteOptions {
  /** Unset until the X app's credentials are configured; the routes then answer 503. */
  client: XClient | null;
  logins: XLoginStore;
  accounts: AccountStore;
  sessions: SessionStore;
  limiter: RateLimiter;
  /** Where the browser goes afterwards. */
  appOrigin: string;
  secureCookies?: boolean;
  /** Injected so the tests can stand in for X. */
  fetch?: typeof fetch;
}

/** Why a sign-in did not finish, passed to the app as `?x=` so it can say so. */
type Failure = 'denied' | 'expired' | 'failed';

export function xRoutes(options: XRouteOptions) {
  const {
    client,
    logins,
    accounts,
    sessions,
    limiter,
    appOrigin,
    secureCookies = true,
    fetch: request = fetch,
  } = options;
  const app = appOrigin.replace(/\/$/, '');

  const backToApp = (c: Context, failure: Failure) => {
    deleteCookie(c, X_STATE_COOKIE, { path: '/', secure: secureCookies, sameSite: 'Lax' });
    if (getCookie(c, X_APP_COOKIE) === '1') {
      // /login is an App Link, so this opens the app, which says what failed.
      deleteCookie(c, X_APP_COOKIE, { path: '/', secure: secureCookies, sameSite: 'Lax' });
      return c.redirect(`${app}/login?xerr=${failure}`, 302);
    }
    return c.redirect(`${app}/?x=${failure}`, 302);
  };

  return (
    new Hono()
      .get('/start', async (c) => {
        if (client === null) return c.json({ error: 'sign in with X is not configured' }, 503);

        const hit = await limiter.hit(`x-start-ip:${clientIp(c)}`, X_START_PER_IP);
        if (!hit.allowed) return c.json({ error: 'too many requests, try again later' }, 429);

        const issued = await logins.issue();
        setCookie(c, X_STATE_COOKIE, issued.state, {
          httpOnly: true,
          secure: secureCookies,
          // Lax: the callback is a top-level navigation from x.com, and Strict
          // would leave the cookie behind on exactly that request.
          sameSite: 'Lax',
          path: '/',
          maxAge: Math.floor(X_LOGIN_TTL_MS / 1000),
        });
        if (c.req.query('app') === '1') {
          setCookie(c, X_APP_COOKIE, '1', {
            httpOnly: true,
            secure: secureCookies,
            sameSite: 'Lax',
            path: '/',
            maxAge: Math.floor(X_LOGIN_TTL_MS / 1000),
          });
        }

        const url = new URL(X_AUTHORIZE_URL);
        url.search = new URLSearchParams({
          response_type: 'code',
          client_id: client.clientId,
          redirect_uri: client.redirectUri,
          scope: X_SCOPES,
          state: issued.state,
          code_challenge: issued.challenge,
          code_challenge_method: 'S256',
        }).toString();
        return c.redirect(url.toString(), 302);
      })

      .get('/callback', async (c) => {
        if (client === null) return c.json({ error: 'sign in with X is not configured' }, 503);

        const state = c.req.query('state') ?? '';
        const code = c.req.query('code') ?? '';
        const cookie = getCookie(c, X_STATE_COOKIE) ?? '';

        // The user pressed Cancel on X. Still spend the state, so it cannot be
        // used later.
        if (c.req.query('error')) {
          if (state) await logins.consume(state);
          return backToApp(c, 'denied');
        }

        if (!state || !code || state !== cookie) return backToApp(c, 'failed');

        // Spent before anything else, so a replayed callback finds nothing.
        const verifier = await logins.consume(state);
        if (verifier === null) return backToApp(c, 'expired');

        try {
          const token = await request(X_TOKEN_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              // A confidential client authenticates with Basic, per X's docs.
              Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
            },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              redirect_uri: client.redirectUri,
              code_verifier: verifier,
              client_id: client.clientId,
            }).toString(),
          });
          if (!token.ok) {
            // The status only: X's error body can echo the request.
            console.error(`x token exchange failed: ${token.status}`);
            return backToApp(c, 'failed');
          }
          const { access_token: accessToken } = (await token.json()) as { access_token?: string };
          if (!accessToken) return backToApp(c, 'failed');

          const me = await request(X_ME_URL, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!me.ok) {
            console.error(`x users/me failed: ${me.status}`);
            return backToApp(c, 'failed');
          }
          const { data } = (await me.json()) as { data?: { id?: string; username?: string } };
          if (!data?.id || !data.username) return backToApp(c, 'failed');

          const account = await accounts.forX(data.id, data.username);
          deleteCookie(c, X_STATE_COOKIE, { path: '/', secure: secureCookies, sameSite: 'Lax' });

          // Begun in the Android app: no cookie (the app cannot read one), but a
          // one-time code through the /login App Link, spent at /exchange.
          if (getCookie(c, X_APP_COOKIE) === '1') {
            deleteCookie(c, X_APP_COOKIE, { path: '/', secure: secureCookies, sameSite: 'Lax' });
            const code = await logins.handoff(account.id);
            return c.redirect(`${app}/login?x=${encodeURIComponent(code)}`, 302);
          }

          const session = await sessions.issue({ accountId: account.id });
          setCookie(c, SESSION_COOKIE, session.token, {
            httpOnly: true,
            secure: secureCookies,
            sameSite: 'Lax',
            path: '/',
            expires: session.expiresAt,
          });
          return c.redirect(`${app}/home`, 302);
        } catch (error) {
          console.error(`x sign-in failed: ${String(error)}`);
          return backToApp(c, 'failed');
        }
      })

      /**
       * The Android app spends its one-time code for a session token, kept in
       * the app's secure storage like any native session. Single use, five
       * minutes, and it opens nothing on its own: the account was proved by X.
       */
      .post('/exchange', async (c) => {
        let body: { code?: unknown };
        try {
          body = (await c.req.json()) as typeof body;
        } catch {
          return c.json({ reason: 'malformed' }, 400);
        }
        if (typeof body.code !== 'string' || body.code.length === 0) {
          return c.json({ reason: 'malformed' }, 400);
        }
        const accountId = await logins.redeem(body.code);
        if (accountId === null) return c.json({ reason: 'expired' }, 401);
        const session = await sessions.issue({ accountId });
        return c.json({
          signedIn: true as const,
          accountId,
          token: session.token,
          expiresAt: session.expiresAt.toISOString(),
        });
      })
  );
}
