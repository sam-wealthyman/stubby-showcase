/**
 * Pending X sign-ins: the PKCE state and verifier between the two redirects.
 *
 * The same shape as the magic-link store. Only the hash of `state` is stored,
 * and spending it is one `DELETE .. RETURNING`, so a callback replayed from a
 * browser's history cannot open a second session.
 */

import { createHash, randomBytes } from 'node:crypto';

import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

/** Long enough to sign in to X on the way, short enough not to linger. */
export const X_LOGIN_TTL_MS = 10 * 60 * 1000;

/** The app's one-time code, from the browser back into the app. */
export const X_HANDOFF_TTL_MS = 5 * 60 * 1000;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface IssuedXLogin {
  /** Sent to X and echoed back, and set in a cookie to bind the browser. */
  state: string;
  /** The S256 challenge sent to X in place of the verifier. */
  challenge: string;
  expiresAt: Date;
}

export interface XLoginStore {
  issue(now?: Date): Promise<IssuedXLogin>;
  /** Spend a state, returning the verifier it was issued with, or null. */
  consume(state: string): Promise<string | null>;
  /** A one-time code the Android app spends for a session, for this account. */
  handoff(accountId: string, now?: Date): Promise<string>;
  /** Spend a handoff code, returning its account, or null. */
  redeem(code: string): Promise<string | null>;
  sweep(): Promise<number>;
}

export function createPostgresXLoginStore(db: Queryable): XLoginStore {
  return {
    async issue(now = new Date()) {
      const state = randomBytes(32).toString('base64url');
      // RFC 7636: 43 to 128 characters; 32 random bytes is 43 in base64url.
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const expiresAt = new Date(now.getTime() + X_LOGIN_TTL_MS);

      await db.query(`INSERT INTO x_login (state_hash, verifier, expires_at) VALUES ($1, $2, $3)`, [
        hash(state),
        verifier,
        expiresAt,
      ]);
      return { state, challenge, expiresAt };
    },

    async consume(state) {
      const { rows } = await db.query<{ verifier: string }>(
        `DELETE FROM x_login WHERE state_hash = $1 AND expires_at > now() RETURNING verifier`,
        [hash(state)],
      );
      return rows[0]?.verifier ?? null;
    },

    async handoff(accountId, now = new Date()) {
      const code = randomBytes(32).toString('base64url');
      await db.query(
        `INSERT INTO x_app_handoff (code_hash, account_id, expires_at) VALUES ($1, $2, $3)`,
        [hash(code), accountId, new Date(now.getTime() + X_HANDOFF_TTL_MS)],
      );
      return code;
    },

    async redeem(code) {
      const { rows } = await db.query<{ account_id: string }>(
        `DELETE FROM x_app_handoff WHERE code_hash = $1 AND expires_at > now() RETURNING account_id`,
        [hash(code)],
      );
      return rows[0]?.account_id ?? null;
    },

    async sweep() {
      const { rowCount } = await db.query(`DELETE FROM x_login WHERE expires_at <= now()`);
      await db.query(`DELETE FROM x_app_handoff WHERE expires_at <= now()`);
      return rowCount ?? 0;
    },
  };
}
