/**
 * Referrals (migration 0009): the referrer earns 5% of the referred account's
 * first purchase, once. Postgres only; the routes and the watcher call this.
 */

import type pg from 'pg';

import type { Scope } from '../watch/store.js';

/** 5%, in whole percent: the bonus is purchase * 5 / 100, rounded down. */
export const BONUS_PERCENT = 5n;

export type ClaimOutcome = 'ok' | 'unknown' | 'self' | 'already' | 'existing-player';

/**
 * Record who referred this account.
 *
 * Refused when the name belongs to nobody, is the account itself, the
 * account already has a referrer, or it has already bought stubs: a referral
 * is for bringing someone new, not for claiming an existing player.
 */
export async function claimReferral(
  pool: pg.Pool,
  scope: Scope,
  referredAccountId: string,
  referrerUsername: string,
): Promise<ClaimOutcome> {
  const { rows: found } = await pool.query<{ id: string }>(
    'SELECT id FROM account WHERE lower(username) = lower($1)',
    [referrerUsername],
  );
  const referrer = found[0]?.id;
  if (!referrer) return 'unknown';
  if (referrer === referredAccountId) return 'self';

  const { rowCount: bought } = await pool.query(
    `SELECT 1 FROM chain_entry ce
       JOIN wallet_link wl ON wl.address = ce.wallet AND wl.chain_id = ce.chain_id
      WHERE wl.account_id = $1 AND ce.chain_id = $2 AND ce.contract = $3
      LIMIT 1`,
    [referredAccountId, scope.chainId, scope.contract],
  );
  if (bought) return 'existing-player';

  const { rowCount } = await pool.query(
    `INSERT INTO referral (referred_account_id, referrer_account_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [referredAccountId, referrer],
  );
  return rowCount === 1 ? 'ok' : 'already';
}

export interface AwardedBonus {
  referredAccountId: string;
  referrerAccountId: string;
  bonus: bigint;
}

/**
 * Award the bonus for every referral whose account has now made its first
 * purchase: the earliest Entered event from any wallet linked to it. Keyed by
 * the referred account, so running this every watcher pass awards each once.
 */
export async function awardBonuses(pool: pg.Pool, scope: Scope): Promise<AwardedBonus[]> {
  const { rows } = await pool.query<{
    referred_account_id: string;
    referrer_account_id: string;
    bonus: string;
  }>(
    `INSERT INTO referral_bonus (referred_account_id, referrer_account_id, chain_id, contract,
                                 raffle_id, wallet, tx_hash, purchase, bonus)
     SELECT DISTINCT ON (r.referred_account_id)
            r.referred_account_id, r.referrer_account_id, ce.chain_id, ce.contract,
            ce.raffle_id, ce.wallet, ce.tx_hash, ce.paid, floor(ce.paid * $3 / 100)
       FROM referral r
       JOIN wallet_link wl ON wl.account_id = r.referred_account_id AND wl.chain_id = $1
       JOIN chain_entry ce ON ce.wallet = wl.address AND ce.chain_id = $1 AND ce.contract = $2
      WHERE NOT EXISTS (
        SELECT 1 FROM referral_bonus b
         WHERE b.referred_account_id = r.referred_account_id AND b.chain_id = $1)
      ORDER BY r.referred_account_id, ce.block_number, ce.log_index
     ON CONFLICT DO NOTHING
     RETURNING referred_account_id, referrer_account_id, bonus`,
    [scope.chainId, scope.contract, BONUS_PERCENT.toString()],
  );
  return rows.map((r) => ({
    referredAccountId: r.referred_account_id,
    referrerAccountId: r.referrer_account_id,
    bonus: BigInt(r.bonus),
  }));
}

export interface MyReferrals {
  joined: number;
  earned: string;
  paid: string;
  owed: string;
  bonuses: { name: string; bonus: string; paid: boolean }[];
}

/** What one referrer has brought in and earned on this chain, for the Account screen. */
export async function referralsOf(
  pool: pg.Pool,
  accountId: string,
  chainId: number,
): Promise<MyReferrals> {
  const { rows: joined } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM referral WHERE referrer_account_id = $1',
    [accountId],
  );
  const { rows } = await pool.query<{ username: string | null; bonus: string; paid: boolean }>(
    `SELECT a.username, b.bonus::text AS bonus, b.paid_at IS NOT NULL AS paid
       FROM referral_bonus b JOIN account a ON a.id = b.referred_account_id
      WHERE b.referrer_account_id = $1 AND b.chain_id = $2
      ORDER BY b.earned_at DESC`,
    [accountId, chainId],
  );
  let earned = 0n;
  let paid = 0n;
  for (const r of rows) {
    earned += BigInt(r.bonus);
    if (r.paid) paid += BigInt(r.bonus);
  }
  return {
    joined: Number(joined[0]?.n ?? 0),
    earned: earned.toString(),
    paid: paid.toString(),
    owed: (earned - paid).toString(),
    bonuses: rows.map((r) => ({
      name: r.username ?? 'A new player',
      bonus: r.bonus,
      paid: r.paid,
    })),
  };
}

export interface Payout {
  referrerAccountId: string;
  username: string | null;
  /** Where to send it: the referrer's first linked wallet on this chain. */
  wallet: string | null;
  owed: string;
  referredAccountIds: string[];
}

/** Everything owed and unpaid, one row per referrer, for the owner. */
export async function owedPayouts(pool: pg.Pool, chainId: number): Promise<Payout[]> {
  const { rows } = await pool.query<{
    referrer_account_id: string;
    username: string | null;
    wallet: string | null;
    owed: string;
    referred: string[];
  }>(
    `SELECT b.referrer_account_id, a.username,
            (SELECT address FROM wallet_link wl
              WHERE wl.account_id = b.referrer_account_id AND wl.chain_id = $1
              ORDER BY wl.created_at LIMIT 1) AS wallet,
            sum(b.bonus)::text AS owed,
            array_agg(b.referred_account_id::text) AS referred
       FROM referral_bonus b JOIN account a ON a.id = b.referrer_account_id
      WHERE b.paid_at IS NULL AND b.chain_id = $1
      GROUP BY b.referrer_account_id, a.username
      ORDER BY sum(b.bonus) DESC`,
    [chainId],
  );
  return rows.map((r) => ({
    referrerAccountId: r.referrer_account_id,
    username: r.username,
    wallet: r.wallet,
    owed: r.owed,
    referredAccountIds: r.referred,
  }));
}

/** Mark this chain's bonuses paid by the transfer that paid them. Only unpaid ones change. */
export async function markPaid(
  pool: pg.Pool,
  chainId: number,
  referredAccountIds: readonly string[],
  txHash: string,
): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE referral_bonus SET paid_at = now(), paid_tx = $2
      WHERE referred_account_id = ANY($1::bigint[]) AND chain_id = $3 AND paid_at IS NULL`,
    [referredAccountIds, txHash.toLowerCase(), chainId],
  );
  return rowCount ?? 0;
}
