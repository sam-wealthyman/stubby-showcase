/**
 * The watcher's tables (migration 0006). Postgres only; the logic is elsewhere.
 */

import type { RaffleState } from '@stubby/shared';
import type pg from 'pg';

import type { EntryLog, RaffleEventLog } from './chain.js';

export interface Scope {
  chainId: number;
  /** Lower-case hex. */
  contract: string;
}

export async function getCursor(pool: pg.Pool, name: string): Promise<bigint | null> {
  const { rows } = await pool.query<{ block: string }>(
    'SELECT block FROM chain_cursor WHERE name = $1',
    [name],
  );
  return rows[0] ? BigInt(rows[0].block) : null;
}

export async function setCursor(pool: pg.Pool, name: string, block: bigint): Promise<void> {
  await pool.query(
    `INSERT INTO chain_cursor (name, block) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET block = EXCLUDED.block, updated_at = now()`,
    [name, block.toString()],
  );
}

export async function upsertRaffles(
  pool: pg.Pool,
  scope: Scope,
  raffles: readonly RaffleState[],
): Promise<void> {
  for (const r of raffles) {
    await pool.query(
      `INSERT INTO chain_raffle (chain_id, contract, raffle_id, status, prize, entry_price,
         total_entries, entries_sold, window_ends, requested_at, winner, prize_owed,
         commission_owed, prize_paid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (chain_id, contract, raffle_id) DO UPDATE SET
         status = EXCLUDED.status, entries_sold = EXCLUDED.entries_sold,
         -- The terms change while a raffle is unstarted (updateRaffle).
         prize = EXCLUDED.prize, entry_price = EXCLUDED.entry_price,
         total_entries = EXCLUDED.total_entries,
         window_ends = EXCLUDED.window_ends, requested_at = EXCLUDED.requested_at,
         winner = EXCLUDED.winner, prize_owed = EXCLUDED.prize_owed,
         commission_owed = EXCLUDED.commission_owed, prize_paid = EXCLUDED.prize_paid,
         updated_at = now()`,
      [
        scope.chainId,
        scope.contract,
        r.id.toString(),
        r.status,
        r.prize.toString(),
        r.entryPrice.toString(),
        r.totalEntries,
        r.entriesSold,
        r.windowEnds,
        r.requestedAt ?? null,
        r.winner?.toLowerCase() ?? null,
        r.prizeOwed.toString(),
        r.commissionOwed.toString(),
        r.prizePaid,
      ],
    );
  }
}

export async function recordEntries(
  pool: pg.Pool,
  scope: Scope,
  entries: readonly EntryLog[],
): Promise<void> {
  for (const e of entries) {
    await pool.query(
      `INSERT INTO chain_entry (chain_id, contract, raffle_id, wallet, count, paid,
         block_number, tx_hash, log_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [
        scope.chainId,
        scope.contract,
        e.raffleId.toString(),
        e.wallet.toLowerCase(),
        e.count,
        e.paid.toString(),
        e.blockNumber.toString(),
        e.txHash.toLowerCase(),
        e.logIndex,
      ],
    );
  }
}

export interface PendingResult {
  raffleId: bigint;
  accountId: string;
  email: string;
  won: boolean;
  prize: bigint;
}

/**
 * Accounts that entered a settled draw, through a linked wallet on this chain,
 * have an email, and have not been told the result.
 */
export async function pendingResults(pool: pg.Pool, scope: Scope): Promise<PendingResult[]> {
  const { rows } = await pool.query<{
    raffle_id: string;
    account_id: string;
    email: string;
    won: boolean;
    prize: string;
  }>(
    `SELECT r.raffle_id, wl.account_id, min(ae.email) AS email,
            bool_or(ce.wallet = r.winner) AS won, r.prize
       FROM chain_raffle r
       JOIN chain_entry ce
         ON ce.chain_id = r.chain_id AND ce.contract = r.contract AND ce.raffle_id = r.raffle_id
       JOIN wallet_link wl ON wl.address = ce.wallet AND wl.chain_id = r.chain_id
       JOIN account_email ae ON ae.account_id = wl.account_id
      WHERE r.chain_id = $1 AND r.contract = $2
        AND r.status = 'Completed' AND r.winner IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM notice_sent n
           WHERE n.kind = 'result' AND n.chain_id = r.chain_id AND n.contract = r.contract
             AND n.raffle_id = r.raffle_id AND n.account_id = wl.account_id)
      GROUP BY r.raffle_id, wl.account_id, r.prize
      ORDER BY r.raffle_id, wl.account_id`,
    [scope.chainId, scope.contract],
  );
  return rows.map((row) => ({
    raffleId: BigInt(row.raffle_id),
    accountId: row.account_id,
    email: row.email,
    won: row.won,
    prize: BigInt(row.prize),
  }));
}

/** Claim a notice before sending it. False when someone already has. */
export async function claimNotice(
  pool: pg.Pool,
  scope: Scope,
  kind: string,
  raffleId: bigint,
  accountId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO notice_sent (kind, chain_id, contract, raffle_id, account_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [kind, scope.chainId, scope.contract, raffleId.toString(), accountId],
  );
  return rowCount === 1;
}

/** Give a claimed notice back when sending failed, so the next tick retries. */
export async function releaseNotice(
  pool: pg.Pool,
  scope: Scope,
  kind: string,
  raffleId: bigint,
  accountId: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM notice_sent
      WHERE kind = $1 AND chain_id = $2 AND contract = $3 AND raffle_id = $4 AND account_id = $5`,
    [kind, scope.chainId, scope.contract, raffleId.toString(), accountId],
  );
}

export interface AlertState {
  firstSeen: Date;
  lastSent: Date | null;
}

/**
 * Record which alerts are true now: new ones start their grace period, and
 * ones that have cleared are forgotten so a recurrence alerts afresh.
 */
export async function syncAlerts(
  pool: pg.Pool,
  keys: readonly string[],
): Promise<Map<string, AlertState>> {
  await pool.query('DELETE FROM owner_alert WHERE NOT (key = ANY($1::text[]))', [keys]);
  for (const key of keys) {
    await pool.query('INSERT INTO owner_alert (key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
  }
  const { rows } = await pool.query<{ key: string; first_seen: Date; last_sent: Date | null }>(
    'SELECT key, first_seen, last_sent FROM owner_alert',
  );
  return new Map(rows.map((r) => [r.key, { firstSeen: r.first_seen, lastSent: r.last_sent }]));
}

export async function markAlertsSent(pool: pg.Pool, keys: readonly string[], at: Date) {
  await pool.query('UPDATE owner_alert SET last_sent = $2 WHERE key = ANY($1::text[])', [keys, at]);
}

export async function recordEvents(
  pool: pg.Pool,
  scope: Scope,
  events: readonly RaffleEventLog[],
): Promise<void> {
  for (const e of events) {
    await pool.query(
      `INSERT INTO chain_event (chain_id, contract, raffle_id, kind, tx_hash, block_number, log_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [
        scope.chainId,
        scope.contract,
        e.raffleId.toString(),
        e.kind,
        e.txHash.toLowerCase(),
        e.blockNumber.toString(),
        e.logIndex,
      ],
    );
  }
}

export interface RaffleEventTx {
  txHash: string;
  blockNumber: string;
}

/**
 * The milestones of one raffle, newest of each kind. A draw re-requested
 * after a timeout keeps one DrawStarted; the contract emits it once.
 */
export async function raffleEvents(
  pool: pg.Pool,
  scope: Scope,
  raffleId: bigint,
): Promise<Partial<Record<string, RaffleEventTx>>> {
  const { rows } = await pool.query<{ kind: string; tx_hash: string; block_number: string }>(
    `SELECT DISTINCT ON (kind) kind, tx_hash, block_number
       FROM chain_event
      WHERE chain_id = $1 AND contract = $2 AND raffle_id = $3
      ORDER BY kind, block_number DESC, log_index DESC`,
    [scope.chainId, scope.contract, raffleId.toString()],
  );
  return Object.fromEntries(
    rows.map((r) => [r.kind, { txHash: r.tx_hash, blockNumber: r.block_number }]),
  );
}

export interface ActivityItem {
  kind: 'won' | 'entered';
  raffleId: string;
  /** The account's username when it chose one, else the wallet shortened. */
  name: string;
  /** USDC base units won, for a win. */
  amount: string | null;
  /** Stubs bought, for an entry. */
  count: number | null;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * The newest wins and purchases, for the live strip. Only ever the name to
 * show: a username the account chose, or a shortened address, never the two
 * together, so the feed publishes nothing more than it displays.
 */
export async function recentActivity(
  pool: pg.Pool,
  scope: Scope,
  limit = 12,
): Promise<ActivityItem[]> {
  const { rows } = await pool.query<{
    kind: 'won' | 'entered';
    raffle_id: string;
    wallet: string;
    amount: string | null;
    count: number | null;
    username: string | null;
  }>(
    `SELECT a.kind, a.raffle_id, a.wallet, a.amount, a.count, acc.username
       FROM (
         SELECT 'won' AS kind, r.raffle_id, r.winner AS wallet, r.prize::text AS amount,
                NULL::int AS count, e.block_number, e.log_index
           FROM chain_raffle r
           JOIN chain_event e
             ON e.chain_id = r.chain_id AND e.contract = r.contract
            AND e.raffle_id = r.raffle_id AND e.kind = 'Drawn'
          WHERE r.chain_id = $1 AND r.contract = $2 AND r.winner IS NOT NULL
         UNION ALL
         SELECT 'entered', raffle_id, wallet, NULL, count, block_number, log_index
           FROM chain_entry
          WHERE chain_id = $1 AND contract = $2
       ) a
       LEFT JOIN wallet_link wl ON wl.address = a.wallet AND wl.chain_id = $1
       LEFT JOIN account acc ON acc.id = wl.account_id
      ORDER BY a.block_number DESC, a.log_index DESC
      LIMIT $3`,
    [scope.chainId, scope.contract, limit],
  );
  return rows.map((r) => ({
    kind: r.kind,
    raffleId: r.raffle_id,
    name: r.username ?? short(r.wallet),
    amount: r.amount,
    count: r.count,
  }));
}

export interface ActivityStats {
  /** Distinct wallets that have bought at least one stub, ever. */
  players: number;
  /** The latest few of them, newest first, named as the feed names them. */
  recent: string[];
  /** The newest draw with a winner, or null before the first. */
  latestWin: { name: string; amount: string; raffleId: string } | null;
}

/**
 * The numbers behind Home's players row: how many people have played, the
 * last few of them, and the latest win. Read from the watcher's record of the
 * chain, so the row never shows a figure the contract would not back.
 */
export async function activityStats(
  pool: pg.Pool,
  scope: Scope,
  recent = 4,
): Promise<ActivityStats> {
  const [count, latest, win] = await Promise.all([
    pool.query<{ players: string }>(
      `SELECT count(DISTINCT wallet)::text AS players
         FROM chain_entry
        WHERE chain_id = $1 AND contract = $2`,
      [scope.chainId, scope.contract],
    ),
    pool.query<{ wallet: string; username: string | null }>(
      `SELECT p.wallet, acc.username
         FROM (
           SELECT DISTINCT ON (wallet) wallet, block_number, log_index
             FROM chain_entry
            WHERE chain_id = $1 AND contract = $2
            ORDER BY wallet, block_number DESC, log_index DESC
         ) p
         LEFT JOIN wallet_link wl ON wl.address = p.wallet AND wl.chain_id = $1
         LEFT JOIN account acc ON acc.id = wl.account_id
        ORDER BY p.block_number DESC, p.log_index DESC
        LIMIT $3`,
      [scope.chainId, scope.contract, recent],
    ),
    pool.query<{ raffle_id: string; winner: string; prize: string; username: string | null }>(
      `SELECT r.raffle_id::text, r.winner, r.prize::text, acc.username
         FROM chain_raffle r
         LEFT JOIN wallet_link wl ON wl.address = r.winner AND wl.chain_id = $1
         LEFT JOIN account acc ON acc.id = wl.account_id
        WHERE r.chain_id = $1 AND r.contract = $2 AND r.winner IS NOT NULL
        ORDER BY r.raffle_id DESC
        LIMIT 1`,
      [scope.chainId, scope.contract],
    ),
  ]);
  const w = win.rows[0];
  return {
    players: Number(count.rows[0]?.players ?? 0),
    recent: latest.rows.map((r) => r.username ?? short(r.wallet)),
    latestWin: w
      ? { name: w.username ?? short(w.winner), amount: w.prize, raffleId: w.raffle_id }
      : null,
  };
}
