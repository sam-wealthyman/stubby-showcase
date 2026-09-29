/**
 * Sign-In with Ethereum, as two endpoints (Section 4.1).
 *
 * The split is the protocol's, not ours. The server issues a nonce it will
 * accept exactly once, the wallet signs a message containing it, and the server
 * verifies the signature and spends the nonce. Without the first step a signed
 * message could be replayed forever; without the single-use guarantee on the
 * second, it could be replayed until it expired.
 *
 * Message rules and signature verification both live in `@stubby/shared`, so
 * the app can build and pre-check exactly what the API will accept. This file
 * is only the HTTP edge: parse, call, decide a status code.
 */

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { PublicClient } from 'viem';

import {
  SiweParseError,
  generateNonce,
  parseSiweMessage,
  verifySiweSignature,
  type NonceStore,
} from '@stubby/shared';

import { clientIp } from '../http/clientIp.js';
import type { AccountStore } from './accountStore.js';
import { NONCE_PER_IP, type RateLimiter } from './rateLimit.js';
import type { SessionStore } from './sessionStore.js';

/**
 * How long an unused nonce stays valid.
 *
 * Long enough to open a wallet, read a message and approve it; short enough
 * that an abandoned attempt is not a standing replay window. Section 4.1 sets
 * no figure, so this is ours.
 */
export const NONCE_TTL_MS = 10 * 60 * 1000;

export interface SiweRouteOptions {
  nonces: NonceStore;
  sessions: SessionStore;
  /**
   * Where the wallet's login lives.
   *
   * A signature proves control of an address; it is the account that a session
   * belongs to (Section 4). First sign-in from a wallet creates the account and
   * the link, and every one after finds the same account — there is no sign-up
   * step in Section 4.1 to put it behind.
   */
  accounts: AccountStore;
  /** Issuing a nonce is cheap, but unbounded it grows a table for free. */
  limiter: RateLimiter;
  /** The authority the wallet is asked to sign for. Host and port, never a URL. */
  domain: string;
  chainId: number;
  /**
   * A chain client, which enables smart-contract wallets.
   *
   * Without it only key-pair wallets can sign in; with it, viem also tries
   * ERC-1271, which is how Safe and other contract accounts sign. Section 4.2
   * says any EVM wallet, so production should always pass one.
   */
  client?: PublicClient;
  /** False in local development over http, where a Secure cookie is never sent. */
  secureCookies?: boolean;
}

/** The cookie the browser uses. Never readable from JavaScript. */
export const SESSION_COOKIE = 'stubby_session';

interface VerifyBody {
  message?: unknown;
  signature?: unknown;
  /**
   * Where to put the session.
   *
   * `cookie` for the web app, where an httpOnly cookie is the only thing an
   * XSS cannot read. `token` for the Android build, where React Native's cookie
   * handling is not something to rely on and the token belongs in secure
   * storage. Explicit rather than sniffed from a User-Agent, because guessing
   * this wrong means a session that silently never arrives.
   */
  session?: unknown;
}

export function siweRoutes(options: SiweRouteOptions) {
  const {
    nonces,
    sessions,
    accounts,
    limiter,
    domain,
    chainId,
    client,
    secureCookies = true,
  } = options;

  return (
    new Hono()
      /**
       * Issue a nonce.
       *
       * POST, not GET, because it writes: every call puts a row in the nonce
       * table. That also keeps it off any cache, which for a single-use value
       * would be a correctness bug rather than a performance one.
       */
      .post('/nonce', async (c) => {
        /*
         * Bounded per IP.
         *
         * Each call is cheap, so this is about the table rather than about CPU:
         * unbounded, anyone can add rows for free faster than the sweep removes
         * them.
         */
        const bucket = await limiter.hit(`nonce-ip:${clientIp(c)}`, NONCE_PER_IP);
        if (!bucket.allowed) {
          const seconds = Math.max(1, Math.ceil((bucket.resetAt.getTime() - Date.now()) / 1000));
          return c.json({ error: 'too many requests — try again later' }, 429, {
            'Retry-After': String(seconds),
          });
        }

        const nonce = generateNonce();
        const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
        await nonces.issue(nonce, expiresAt);
        return c.json({ nonce, expiresAt: expiresAt.toISOString() }, 201);
      })

      /**
       * Verify a signed message and open a session.
       *
       * The order is deliberate: the signature is checked *before* the nonce is
       * spent. Spending first would let anyone burn another user's in-flight
       * nonce by posting rubbish against it, turning a sign-in into a failure
       * they cannot explain.
       */
      .post('/verify', async (c) => {
        let body: VerifyBody;
        try {
          body = (await c.req.json()) as VerifyBody;
        } catch {
          return c.json({ error: 'expected a JSON body' }, 400);
        }

        const { message, signature } = body;
        if (typeof message !== 'string' || typeof signature !== 'string') {
          return c.json({ error: 'message and signature are required' }, 400);
        }
        if (!signature.startsWith('0x')) {
          return c.json({ error: 'signature must be 0x-prefixed' }, 400);
        }

        // Parsed once here, before anything expensive, purely to learn which
        // nonce this attempt claims. `verifySiweSignature` parses again — the
        // cost is a string split, and the alternative is an expectation built
        // from a value nobody has read yet.
        let claimedNonce: string;
        try {
          claimedNonce = parseSiweMessage(message).nonce;
        } catch (error) {
          return c.json(
            {
              error: 'not verified',
              reason: 'malformed',
              detail: error instanceof SiweParseError ? error.message : String(error),
            },
            401,
          );
        }

        const result = await verifySiweSignature({
          message,
          signature: signature as `0x${string}`,
          // The nonce here comes from the message, so this particular check is
          // satisfied by construction and proves nothing. **The store is the
          // authority**: `consume` below is what makes a nonce single-use, and
          // no amount of message validation can substitute for it. The field is
          // supplied because the shared validator requires one, and the rest of
          // the expectation — domain, chain, expiry — does real work, all of it
          // before any signature recovery happens.
          expected: { domain, chainId, nonce: claimedNonce },
          ...(client ? { client } : {}),
        });

        if (!result.valid) {
          // 401 rather than 400: the request was well formed and the credential
          // was not good enough. The body says which check failed, because a
          // caller debugging a clock skew or a domain mismatch cannot guess.
          return c.json({ error: 'not verified', reason: result.reason, ...detail(result) }, 401);
        }

        /*
         * The nonce is spent only now, after the signature has been shown good.
         *
         * Spending first would be simpler and is wrong in a way that is easy to
         * talk yourself into: a failed verification would still have consumed
         * the nonce, so a user whose wallet returned a slightly malformed
         * signature would have to start over with no way to know why. Spending
         * last means a failed attempt costs nothing and can simply be retried.
         */
        const fresh = await nonces.consume(result.message.nonce);
        if (!fresh) {
          // Unknown, expired, or already used — which is a replay. The three are
          // deliberately one answer: telling a caller which would confirm that a
          // particular nonce once existed.
          return c.json({ error: 'not verified', reason: 'nonce-spent' }, 401);
        }

        const account = await accounts.forWallet(result.address, chainId);
        const session = await sessions.issue({
          accountId: account.id,
          wallet: { address: result.address, chainId },
        });

        const wantsToken = body.session === 'token';
        if (!wantsToken) {
          setCookie(c, SESSION_COOKIE, session.token, {
            httpOnly: true,
            secure: secureCookies,
            // Lax, not Strict: the sign-in flow can return through a wallet's
            // redirect, and Strict would drop the cookie on that navigation.
            sameSite: 'Lax',
            path: '/',
            expires: session.expiresAt,
          });
        }

        return c.json({
          // Section 4: the session belongs to an account. The wallet is what it
          // signed in with, not what it is.
          accountId: session.accountId,
          address: session.address,
          chainId: session.chainId,
          expiresAt: session.expiresAt.toISOString(),
          // Returned only when asked for, so the web build never hands a bearer
          // token to JavaScript that an XSS could read.
          ...(wantsToken ? { token: session.token } : {}),
        });
      })
  );
}

/** The part of a failure worth telling the caller, and no more. */
function detail(result: Awaited<ReturnType<typeof verifySiweSignature>>) {
  if (result.valid) return {};
  if (result.reason === 'malformed') return { detail: result.detail };
  if (result.reason === 'message-rejected') return { failures: result.failures };
  return {};
}
