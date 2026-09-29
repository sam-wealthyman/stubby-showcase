/**
 * Linking a wallet to an account you are already signed in to (Section 4.2).
 *
 * Without this, signing in by email and then connecting a wallet produces
 * **two accounts** — `/auth/siwe/verify` finds or creates the wallet's own
 * account, which is right when that is how you are signing in and wrong when
 * you are already someone.
 *
 * Two proofs are required and neither is sufficient alone:
 *
 *   - **a session**, saying which account is asking;
 *   - **a SIWE signature**, saying the caller controls the wallet.
 *
 * Without the signature, anyone could claim any address and see whose tickets
 * it holds. Without the session there is nothing to link to. So this is
 * deliberately the same signature flow as signing in, pointed at a different
 * outcome — a nonce is still issued by `/auth/siwe/nonce` and still spent once.
 */

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { PublicClient } from 'viem';

import {
  SiweParseError,
  parseSiweMessage,
  verifySiweSignature,
  type NonceStore,
} from '@stubby/shared';

import type { AccountStore } from './accountStore.js';
import { sessionTokenFrom } from './bearer.js';
import type { SessionStore } from './sessionStore.js';
import { SESSION_COOKIE } from './siweRoutes.js';
import { decideLink, linkMessage } from './walletLink.js';

export interface WalletRouteOptions {
  nonces: NonceStore;
  sessions: SessionStore;
  accounts: AccountStore;
  domain: string;
  chainId: number;
  client?: PublicClient;
}

interface LinkBody {
  message?: unknown;
  signature?: unknown;
}

interface UnlinkBody {
  address?: unknown;
}

export function walletRoutes(options: WalletRouteOptions) {
  const { nonces, sessions, accounts, domain, chainId, client } = options;

  return (
    new Hono()
      /**
       * Prove control of a wallet, and attach it to the current account.
       *
       * The nonce is spent **after** the signature is verified, as in
       * `/auth/siwe/verify` and for the same reason: a wallet returning a
       * slightly malformed signature should not burn the nonce and leave the user
       * retrying into a failure nobody can explain.
       */
      .post('/link', async (c) => {
        const token = sessionTokenFrom({
          authorization: c.req.header('authorization'),
          cookie: getCookie(c, SESSION_COOKIE),
        });
        const session = token === undefined ? null : await sessions.resolve(token);
        if (session === null) {
          // 401 rather than linking to a new account: "link" means "to the
          // account I am signed in to", and there is not one.
          return c.json({ error: 'sign in first' }, 401);
        }

        let body: LinkBody;
        try {
          body = (await c.req.json()) as LinkBody;
        } catch {
          return c.json({ error: 'expected a JSON body' }, 400);
        }
        const { message, signature } = body;
        if (typeof message !== 'string' || typeof signature !== 'string') {
          return c.json({ error: 'message and signature are required' }, 400);
        }

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
          expected: { domain, chainId, nonce: claimedNonce },
          ...(client ? { client } : {}),
        });
        if (!result.valid) {
          return c.json({ error: 'not verified', reason: result.reason }, 401);
        }

        /*
         * Decided before the nonce is spent, so a refusal costs nothing.
         *
         * A caller whose wallet turns out to belong to someone else should be
         * able to go and unlink it there and come straight back, rather than
         * having to start with a fresh nonce because the attempt consumed one.
         */
        const owner = await accounts.ownerOfWallet(result.address, chainId);
        const decision = decideLink({ accountId: session.accountId, currentOwner: owner });

        /*
         * Taken by an account that is nothing but wallets — almost always this
         * same person, who once signed in with the wallet alone. The signature
         * proves the wallet and the session proves this account, so the two
         * are folded together. An account with its own email or X login is
         * somebody's separate login and is refused.
         */
        const mergeable =
          decision.kind === 'taken' &&
          owner !== null &&
          (await accounts.emailFor(owner)) === null &&
          (await accounts.xUsernameFor(owner)) === null;
        if (decision.kind === 'taken' && !mergeable) {
          return c.json({ error: linkMessage(decision), reason: 'wallet-taken' }, 409);
        }

        const fresh = await nonces.consume(result.message.nonce);
        if (!fresh) {
          return c.json({ error: 'not verified', reason: 'nonce-spent' }, 401);
        }

        if (decision.kind === 'link') {
          await accounts.linkWallet(session.accountId, result.address, chainId);
        }
        if (mergeable && owner !== null) {
          // Re-checked under a lock: a login added in between still refuses.
          if ((await accounts.absorbWalletOnlyAccount(owner, session.accountId)) === 'has-login') {
            return c.json({ error: linkMessage(decision), reason: 'wallet-taken' }, 409);
          }
        }

        return c.json({
          linked: true as const,
          address: result.address.toLowerCase(),
          chainId,
          alreadyLinked: decision.kind === 'already-yours',
          message: mergeable
            ? 'Linked. This wallet and its history are now on your account.'
            : linkMessage(decision),
          wallets: await accounts.walletsFor(session.accountId),
        });
      })

      /**
       * Detach a wallet from the current account.
       *
       * Needs no signature: removing a wallet from your own login takes nothing
       * from anybody, and the entries it holds stay exactly where they are — on
       * the chain, reachable by whoever controls the key. Unlinking is a view
       * setting, not a transfer.
       */
      .post('/unlink', async (c) => {
        const token = sessionTokenFrom({
          authorization: c.req.header('authorization'),
          cookie: getCookie(c, SESSION_COOKIE),
        });
        const session = token === undefined ? null : await sessions.resolve(token);
        if (session === null) return c.json({ error: 'sign in first' }, 401);

        let body: UnlinkBody;
        try {
          body = (await c.req.json()) as UnlinkBody;
        } catch {
          return c.json({ error: 'expected a JSON body' }, 400);
        }
        const address = typeof body.address === 'string' ? body.address : '';
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
          return c.json({ error: 'address is required' }, 400);
        }

        const removed = await accounts.unlinkWallet(
          session.accountId,
          address as `0x${string}`,
          chainId,
        );
        // Scoped to this account in the store, so a wallet belonging to another
        // login simply is not found — the same answer as one that was never
        // linked, which is also all this caller is entitled to know.
        return c.json({
          unlinked: removed,
          wallets: await accounts.walletsFor(session.accountId),
        });
      })
  );
}
