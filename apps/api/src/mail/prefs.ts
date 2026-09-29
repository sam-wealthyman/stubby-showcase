/**
 * Whether an account wants result and referral mail (migration 0010).
 *
 * Login links and owner alerts ignore this: one was just asked for, the other
 * is the owner's own. Everything else the watcher sends checks it, and carries
 * a one-click unsubscribe link (RFC 8058) built from the account's mail token.
 */

import { randomBytes } from 'node:crypto';

import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

export async function mailOptedOut(db: Queryable, accountId: string): Promise<boolean> {
  const { rows } = await db.query<{ out: boolean }>(
    `SELECT mail_opt_out_at IS NOT NULL AS out FROM account WHERE id = $1`,
    [accountId],
  );
  return rows[0]?.out ?? false;
}

export async function setMailOptOut(db: Queryable, accountId: string, out: boolean): Promise<void> {
  await db.query(
    `UPDATE account SET mail_opt_out_at = CASE WHEN $2 THEN coalesce(mail_opt_out_at, now()) END
      WHERE id = $1`,
    [accountId, out],
  );
}

/** The account's unsubscribe token, made on first use. */
export async function mailTokenFor(db: Queryable, accountId: string): Promise<string> {
  const { rows } = await db.query<{ mail_token: string }>(
    `UPDATE account SET mail_token = coalesce(mail_token, $2) WHERE id = $1 RETURNING mail_token`,
    [accountId, randomBytes(24).toString('base64url')],
  );
  const token = rows[0]?.mail_token;
  if (!token) throw new Error(`no account ${accountId}`);
  return token;
}

/** Turn mail off for whoever holds this token. False when the token is unknown. */
export async function unsubscribeByToken(db: Queryable, token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return false;
  const { rowCount } = await db.query(
    `UPDATE account SET mail_opt_out_at = coalesce(mail_opt_out_at, now()) WHERE mail_token = $1`,
    [token],
  );
  return rowCount === 1;
}

/** The link in a mail's footer and its List-Unsubscribe header. */
export function unsubscribeUrl(appOrigin: string, token: string): string {
  return `${appOrigin.replace(/\/$/, '')}/api/mail/unsubscribe?t=${encodeURIComponent(token)}`;
}
