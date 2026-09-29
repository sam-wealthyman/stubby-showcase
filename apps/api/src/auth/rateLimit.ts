/**
 * Rate limiting, backed by Postgres.
 *
 * In memory it would be per process: two API instances would give an attacker
 * twice the allowance, and a deploy would reset every counter to zero. A limit
 * that can be doubled by scaling out or cleared by a restart is not a limit —
 * the same argument that put the SIWE nonce store in the database.
 *
 * **What this protects and what it does not.** `/auth/email/request` makes the
 * server send mail to an address the caller chose. Unlimited, that is a way to
 * spend someone's provider quota and to put unwanted mail in a stranger's inbox
 * using this product's reputation. It is not primarily about protecting Stubby.
 *
 * It does not stop a distributed attacker: a per-IP bucket is per IP, and IPs
 * are cheap. It raises the cost of the easy version, which is the version that
 * actually happens.
 */

import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

export interface Limit {
  /** How many are allowed in a window. */
  max: number;
  windowMs: number;
}

export interface LimitResult {
  allowed: boolean;
  /** How many remain in this window, after counting this attempt. */
  remaining: number;
  /** When the window resets, for a `Retry-After`. */
  resetAt: Date;
}

export interface RateLimiter {
  /** Count one attempt against a bucket, and say whether it is allowed. */
  hit(bucket: string, limit: Limit, now?: Date): Promise<LimitResult>;
  /** Remove windows that have closed. Run on a timer. */
  sweep(olderThanMs?: number): Promise<number>;
}

/**
 * Where the current window starts.
 *
 * Floored to the window size, so every caller in the same period shares a row
 * and the key stays bounded. Exported because the arithmetic is the part worth
 * testing without a database.
 */
export function windowStart(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

export function createPostgresRateLimiter(db: Queryable): RateLimiter {
  return {
    async hit(bucket, limit, now = new Date()) {
      const start = windowStart(now, limit.windowMs);

      /*
       * One statement, so concurrent requests cannot both read "count = max - 1"
       * and both proceed.
       *
       * The upsert increments and returns the new value, so the count is the
       * database's own and never a value this process computed from a read. That
       * is the whole reason this is not `SELECT` then `UPDATE`.
       */
      const { rows } = await db.query<{ count: number }>(
        `INSERT INTO rate_limit (bucket, window_start, count) VALUES ($1, $2, 1)
         ON CONFLICT (bucket, window_start)
         DO UPDATE SET count = rate_limit.count + 1
         RETURNING count`,
        [bucket, start],
      );

      const count = rows[0]?.count ?? 1;
      return {
        allowed: count <= limit.max,
        remaining: Math.max(0, limit.max - count),
        resetAt: new Date(start.getTime() + limit.windowMs),
      };
    },

    async sweep(olderThanMs = 24 * 60 * 60 * 1000) {
      const { rowCount } = await db.query(
        `DELETE FROM rate_limit WHERE window_start < now() - ($1 || ' milliseconds')::interval`,
        [String(olderThanMs)],
      );
      return rowCount ?? 0;
    },
  };
}

/**
 * The limits for asking for a login link.
 *
 * Two buckets, because they answer different questions. Per address stops one
 * inbox being flooded however many machines ask; per IP stops one machine
 * flooding many inboxes. Either alone leaves the other attack open.
 *
 * The numbers are deliberately generous for a person and tight for a script: a
 * real user asks once, maybe three times if mail is slow.
 */
export const EMAIL_REQUEST_PER_ADDRESS: Limit = { max: 5, windowMs: 60 * 60 * 1000 };
export const EMAIL_REQUEST_PER_IP: Limit = { max: 20, windowMs: 60 * 60 * 1000 };

/** Issuing a SIWE nonce is cheap, but unbounded it grows a table. */
export const NONCE_PER_IP: Limit = { max: 60, windowMs: 10 * 60 * 1000 };
