/**
 * Magic links.
 *
 * The same shape as the SIWE nonce store, for the same reasons, and the
 * similarity is deliberate rather than accidental: both hand out a single-use
 * credential and both are only worth having if "single-use" is actually true.
 *
 * **Only the hash is stored.** A token in a link is a bearer credential — it
 * *is* the sign-in — so a dump of this table would otherwise be a dump of every
 * pending login. Storing the hash means a reader of the table cannot use any of
 * them.
 *
 * **Single use is one statement**, `DELETE .. WHERE token_hash = $1 AND
 * expires_at > now() RETURNING email`, which is atomic in a way read-then-delete
 * is not. Two clicks on the same link — a mail client prefetching it, then the
 * user — must not both produce a session.
 *
 * A short life matters more here than for a nonce. The token travels in a URL,
 * so it lands in browser history, in any proxy's logs, and in a `Referer`
 * header if the landing page loads anything third-party. None of that is
 * fixable from this side; a ten-minute window and one use are the mitigations.
 */

import { createHash, randomBytes } from 'node:crypto';

import type pg from 'pg';

import { requireEmail } from '@stubby/shared';

type Queryable = Pick<pg.Pool, 'query'>;

/**
 * How long a link is good for.
 *
 * Long enough to switch to a mail app and back on a phone; short enough that a
 * link sitting in an inbox is not a standing key to the account.
 */
export const EMAIL_LOGIN_TTL_MS = 10 * 60 * 1000;

/** 256 bits, so the token cannot be guessed and needs no stretching. */
const TOKEN_BYTES = 32;

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedLink {
  /** Returned exactly once, to put in the email. Nothing stores it. */
  token: string;
  email: string;
  expiresAt: Date;
}

export interface EmailLoginStore {
  issue(email: string, now?: Date): Promise<IssuedLink>;
  /** Spend a token, returning the email it was issued for, or null. */
  consume(token: string): Promise<string | null>;
  /** Remove expired links. Not needed for correctness; stops the table growing. */
  sweep(): Promise<number>;
}

export function createPostgresEmailLoginStore(db: Queryable): EmailLoginStore {
  return {
    async issue(input, now = new Date()) {
      const email = requireEmail(input);
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const expiresAt = new Date(now.getTime() + EMAIL_LOGIN_TTL_MS);

      /*
       * Any older link for this address is invalidated.
       *
       * Without this, every link ever requested stays live until it expires, so
       * asking again because the first did not arrive leaves several working
       * keys in an inbox. One outstanding link per address means the most recent
       * request is the only one that counts, which is also what a user expects.
       */
      await db.query(`DELETE FROM email_login WHERE email = $1`, [email]);
      await db.query(
        `INSERT INTO email_login (token_hash, email, expires_at) VALUES ($1, $2, $3)`,
        [hash(token), email, expiresAt],
      );
      return { token, email, expiresAt };
    },

    async consume(token) {
      const { rows } = await db.query<{ email: string }>(
        `DELETE FROM email_login WHERE token_hash = $1 AND expires_at > now() RETURNING email`,
        [hash(token)],
      );
      return rows[0]?.email ?? null;
    },

    async sweep() {
      const { rowCount } = await db.query(`DELETE FROM email_login WHERE expires_at <= now()`);
      return rowCount ?? 0;
    },
  };
}
