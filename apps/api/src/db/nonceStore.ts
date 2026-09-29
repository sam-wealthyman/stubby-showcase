/**
 * The SIWE nonce store, backed by Postgres.
 *
 * The in-memory store in `@stubby/shared` says plainly what it is not fit for:
 * one process, and no restarts. This is the one that runs in production, and
 * the reason it exists is a single line of SQL.
 *
 * `consume` is one statement:
 *
 *     DELETE FROM siwe_nonce WHERE nonce = $1 AND expires_at > now() RETURNING 1
 *
 * That is atomic in a way a read-then-delete is not. Two sign-ins arriving at
 * the same instant with the same nonce both run the DELETE; exactly one gets a
 * row back and the other gets nothing. Written as SELECT then DELETE, both
 * could see the row and both could succeed — which is precisely the replay the
 * nonce exists to prevent, and it would show up only under concurrency, which
 * is to say in production and never in a test someone wrote by hand.
 */

import type pg from 'pg';

import type { NonceStore } from '@stubby/shared';

/** What `query` needs. A Pool, a Client and a PoolClient all satisfy it. */
type Queryable = Pick<pg.Pool, 'query'>;

export function createPostgresNonceStore(db: Queryable): NonceStore {
  return {
    async issue(nonce: string, expiresAt: Date): Promise<void> {
      await db.query(
        `INSERT INTO siwe_nonce (nonce, expires_at) VALUES ($1, $2)
         ON CONFLICT (nonce) DO NOTHING`,
        [nonce, expiresAt],
      );
    },

    /**
     * The `now` the interface allows is deliberately ignored: expiry is decided
     * by `now()`, the database's clock.
     *
     * With more than one API process there is no single application clock to
     * trust, and a nonce whose expiry depends on which box answered has not
     * really expired. A caller with a skewed clock — or one that simply passes
     * the wrong value — would otherwise be able to consume a dead nonce.
     *
     * Tests that need expiry issue a nonce with an `expiresAt` already in the
     * past, which exercises the same branch without a second clock.
     */
    async consume(nonce: string): Promise<boolean> {
      const { rowCount } = await db.query(
        `DELETE FROM siwe_nonce WHERE nonce = $1 AND expires_at > now() RETURNING 1`,
        [nonce],
      );
      return rowCount === 1;
    },
  };
}

/**
 * Delete nonces that have expired.
 *
 * Not needed for correctness — `consume` already refuses an expired nonce — but
 * without it the table grows forever with rows nobody will ever consume. Run it
 * on a timer.
 *
 * @returns how many rows were removed.
 */
export async function sweepExpiredNonces(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM siwe_nonce WHERE expires_at <= now()`);
  return rowCount ?? 0;
}
