/**
 * Devices registered for push (migration 0012), and sending to an account.
 */

import type pg from 'pg';

import type { Scope } from '../watch/store.js';
import type { PushMessage, PushSender } from './fcm.js';

type Queryable = Pick<pg.Pool, 'query'>;

/** Register (or move) a device to this account, and mark it seen. */
export async function registerDevice(
  db: Queryable,
  accountId: string,
  token: string,
  platform: string,
): Promise<void> {
  await db.query(
    `INSERT INTO push_device (token, account_id, platform) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE
       SET account_id = EXCLUDED.account_id, platform = EXCLUDED.platform, seen_at = now()`,
    [token, accountId, platform],
  );
}

/** Forget a device, only if it is this account's. */
export async function removeDevice(db: Queryable, accountId: string, token: string): Promise<void> {
  await db.query(`DELETE FROM push_device WHERE token = $1 AND account_id = $2`, [
    token,
    accountId,
  ]);
}

export async function pushOptedOut(db: Queryable, accountId: string): Promise<boolean> {
  const { rows } = await db.query<{ out: boolean }>(
    `SELECT push_opt_out_at IS NOT NULL AS out FROM account WHERE id = $1`,
    [accountId],
  );
  return rows[0]?.out ?? false;
}

export async function setPushOptOut(db: Queryable, accountId: string, out: boolean): Promise<void> {
  await db.query(
    `UPDATE account SET push_opt_out_at = CASE WHEN $2 THEN coalesce(push_opt_out_at, now()) END
      WHERE id = $1`,
    [accountId, out],
  );
}

/**
 * Send to every device of an account, unless push is off for it. A token FCM
 * reports as gone is deleted. Returns how many devices it reached.
 */
export async function pushToAccount(
  db: Queryable,
  sender: PushSender,
  accountId: string,
  message: PushMessage,
): Promise<number> {
  if (await pushOptedOut(db, accountId)) return 0;
  const { rows } = await db.query<{ token: string }>(
    `SELECT token FROM push_device WHERE account_id = $1`,
    [accountId],
  );
  let reached = 0;
  for (const { token } of rows) {
    const outcome = await sender.send(token, message);
    if (outcome === 'sent') reached += 1;
    if (outcome === 'gone') await db.query(`DELETE FROM push_device WHERE token = $1`, [token]);
  }
  return reached;
}

export interface PendingPush {
  raffleId: bigint;
  accountId: string;
  won: boolean;
  prize: bigint;
}

/**
 * Accounts that entered a settled draw through a linked wallet, have a device
 * registered, and have not been pushed the result. Separate from the mail
 * query: plenty of accounts have a phone and no email.
 */
export async function pendingPushResults(pool: pg.Pool, scope: Scope): Promise<PendingPush[]> {
  const { rows } = await pool.query<{
    raffle_id: string;
    account_id: string;
    won: boolean;
    prize: string;
  }>(
    `SELECT r.raffle_id, wl.account_id, bool_or(ce.wallet = r.winner) AS won, r.prize
       FROM chain_raffle r
       JOIN chain_entry ce
         ON ce.chain_id = r.chain_id AND ce.contract = r.contract AND ce.raffle_id = r.raffle_id
       JOIN wallet_link wl ON wl.address = ce.wallet AND wl.chain_id = r.chain_id
      WHERE r.chain_id = $1 AND r.contract = $2
        AND r.status = 'Completed' AND r.winner IS NOT NULL
        AND EXISTS (SELECT 1 FROM push_device d WHERE d.account_id = wl.account_id)
        AND NOT EXISTS (
          SELECT 1 FROM notice_sent n
           WHERE n.kind = 'push-result' AND n.chain_id = r.chain_id AND n.contract = r.contract
             AND n.raffle_id = r.raffle_id AND n.account_id = wl.account_id)
      GROUP BY r.raffle_id, wl.account_id, r.prize
      ORDER BY r.raffle_id, wl.account_id`,
    [scope.chainId, scope.contract],
  );
  return rows.map((row) => ({
    raffleId: BigInt(row.raffle_id),
    accountId: row.account_id,
    won: row.won,
    prize: BigInt(row.prize),
  }));
}
