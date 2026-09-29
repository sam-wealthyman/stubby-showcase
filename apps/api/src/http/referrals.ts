/**
 * Referral routes.
 *
 *   POST /referrals/claim        { username }  record who referred me
 *   GET  /referrals/mine                       what I have brought in and earned
 *   GET  /admin/referrals                      owner: everything owed, per referrer
 *   POST /admin/referrals/paid   { referredAccountIds, txHash }  owner: mark paid
 *
 * The owner routes need a session signed in with the wallet that owns the
 * raffle contract, read from the chain; they show wallet addresses and move
 * the ledger, so being signed in is not enough.
 */

import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';

import { sessionTokenFrom } from '../auth/bearer.js';
import type { Session, SessionStore } from '../auth/sessionStore.js';
import { SESSION_COOKIE } from '../auth/siweRoutes.js';
import type { ClaimOutcome, MyReferrals, Payout } from '../referral/store.js';

export interface ReferralRouteOptions {
  sessions: SessionStore;
  claim(referredAccountId: string, username: string): Promise<ClaimOutcome>;
  mine(accountId: string): Promise<MyReferrals>;
  owed(): Promise<Payout[]>;
  markPaid(referredAccountIds: readonly string[], txHash: string): Promise<number>;
  /** Whether this address owns the raffle contract. */
  isOwner(address: string): Promise<boolean>;
}

const CLAIM_MESSAGES: Record<Exclude<ClaimOutcome, 'ok'>, string> = {
  unknown: 'That referral link is not valid.',
  self: 'You cannot refer yourself.',
  already: 'You already have a referrer.',
  'existing-player': 'Referrals are for new players.',
};

export function referralRoutes(options: ReferralRouteOptions) {
  const session = async (c: Context): Promise<Session | null> => {
    const token = sessionTokenFrom({
      authorization: c.req.header('authorization'),
      cookie: getCookie(c, SESSION_COOKIE),
    });
    return token === undefined ? null : options.sessions.resolve(token);
  };

  const owner = async (c: Context): Promise<Session | null> => {
    const s = await session(c);
    if (!s?.address) return null;
    return (await options.isOwner(s.address)) ? s : null;
  };

  return new Hono()
    .post('/referrals/claim', async (c) => {
      const s = await session(c);
      if (!s) return c.json({ reason: 'signed-out' }, 401);
      const body = (await c.req.json().catch(() => ({}))) as { username?: unknown };
      if (typeof body.username !== 'string' || body.username.length > 40) {
        return c.json({ reason: 'malformed' }, 400);
      }
      const outcome = await options.claim(s.accountId, body.username);
      if (outcome === 'ok') return c.json({ referred: true });
      return c.json({ reason: outcome, detail: CLAIM_MESSAGES[outcome] }, 409);
    })
    .get('/referrals/mine', async (c) => {
      const s = await session(c);
      if (!s) return c.json({ reason: 'signed-out' }, 401);
      return c.json(await options.mine(s.accountId));
    })
    .get('/admin/referrals', async (c) => {
      if (!(await owner(c))) return c.json({ reason: 'not-owner' }, 403);
      return c.json({ payouts: await options.owed() });
    })
    .post('/admin/referrals/paid', async (c) => {
      if (!(await owner(c))) return c.json({ reason: 'not-owner' }, 403);
      const body = (await c.req.json().catch(() => ({}))) as {
        referredAccountIds?: unknown;
        txHash?: unknown;
      };
      const ids = body.referredAccountIds;
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        !ids.every((id) => typeof id === 'string' && /^[1-9][0-9]{0,18}$/.test(id)) ||
        typeof body.txHash !== 'string' ||
        !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)
      ) {
        return c.json({ reason: 'malformed' }, 400);
      }
      return c.json({ marked: await options.markPaid(ids as string[], body.txHash) });
    });
}
