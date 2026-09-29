/**
 * The rate limiter, against a real Postgres.
 *
 * The reason it is in the database at all is that an in-memory counter is per
 * process — two instances would double the allowance and a deploy would clear
 * it. So the interesting properties are the ones a single-process fake cannot
 * show: that concurrent hits are counted exactly once each, and that the count
 * survives a new limiter object.
 */

import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import {
  createPostgresRateLimiter,
  windowStart,
  type Limit,
  type RateLimiter,
} from '../src/auth/rateLimit.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe('windowStart', () => {
  it('floors to the window, so callers in one period share a row', () => {
    const w = 60_000;
    // An aligned base, so the expectations are not quietly asserting that
    // 1e12 is a multiple of 60,000 — it is not, which is how this test first
    // failed against correct code.
    const base = Math.floor(1_000_000_000_000 / w) * w;

    expect(windowStart(new Date(base), w).getTime()).toBe(base);
    expect(windowStart(new Date(base + 30_000), w).getTime()).toBe(base);
    expect(windowStart(new Date(base + w - 1), w).getTime()).toBe(base);
    // The next window starts exactly one period on, with no overlap or gap.
    expect(windowStart(new Date(base + w), w).getTime()).toBe(base + w);
  });
});

describe.skipIf(!DATABASE_URL)('createPostgresRateLimiter', () => {
  let pool: pg.Pool;
  let limiter: RateLimiter;
  const buckets: string[] = [];

  const fresh = () => {
    const bucket = `test:${randomBytes(8).toString('hex')}`;
    buckets.push(bucket);
    return bucket;
  };

  const limit: Limit = { max: 3, windowMs: 60 * 60 * 1000 };

  beforeAll(async () => {
    pool = createPool({ max: 6 });
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
    limiter = createPostgresRateLimiter(pool);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    if (buckets.length > 0) {
      await pool.query('DELETE FROM rate_limit WHERE bucket = ANY($1::text[])', [buckets]);
    }
    await pool.end();
  });

  it('allows up to the limit and refuses after it', async () => {
    const bucket = fresh();
    for (let i = 1; i <= 3; i += 1) {
      const result = await limiter.hit(bucket, limit);
      expect(result.allowed, `attempt ${i}`).toBe(true);
      expect(result.remaining).toBe(3 - i);
    }
    const over = await limiter.hit(bucket, limit);
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it('keeps counting past the limit, so alternating cannot stay under it', async () => {
    const bucket = fresh();
    for (let i = 0; i < 6; i += 1) await limiter.hit(bucket, limit);
    // Still refused, rather than having drifted back under by not counting.
    expect((await limiter.hit(bucket, limit)).allowed).toBe(false);
  });

  it('counts buckets separately', async () => {
    const a = fresh();
    const b = fresh();
    for (let i = 0; i < 3; i += 1) await limiter.hit(a, limit);
    expect((await limiter.hit(a, limit)).allowed).toBe(false);
    expect((await limiter.hit(b, limit)).allowed).toBe(true);
  });

  /**
   * The property that justifies putting this in the database.
   *
   * Written as SELECT-then-UPDATE, several concurrent callers all read the same
   * count and all decide they are under the limit. The upsert returns the
   * database's own incremented value, so ten concurrent hits produce exactly ten
   * counts and exactly `max` of them are allowed.
   */
  it('counts concurrent hits exactly once each', async () => {
    const bucket = fresh();
    const results = await Promise.all(Array.from({ length: 10 }, () => limiter.hit(bucket, limit)));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    // Every hit got a distinct position in the window.
    expect(new Set(results.map((r) => r.remaining)).size).toBeGreaterThan(1);
  });

  it('survives a new limiter object, because the count is not in this process', async () => {
    const bucket = fresh();
    for (let i = 0; i < 3; i += 1) await limiter.hit(bucket, limit);
    // Standing in for a second instance, or the same one after a deploy.
    const other = createPostgresRateLimiter(pool);
    expect((await other.hit(bucket, limit)).allowed).toBe(false);
  });

  it('starts fresh in the next window', async () => {
    const bucket = fresh();
    const now = new Date();
    for (let i = 0; i < 3; i += 1) await limiter.hit(bucket, limit, now);
    expect((await limiter.hit(bucket, limit, now)).allowed).toBe(false);

    const later = new Date(now.getTime() + limit.windowMs);
    expect((await limiter.hit(bucket, limit, later)).allowed).toBe(true);
  });

  it('reports when the window resets', async () => {
    const bucket = fresh();
    const now = new Date();
    const result = await limiter.hit(bucket, limit, now);
    expect(result.resetAt.getTime()).toBe(
      windowStart(now, limit.windowMs).getTime() + limit.windowMs,
    );
    expect(result.resetAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('sweeps closed windows and leaves the current one', async () => {
    const bucket = fresh();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await limiter.hit(bucket, limit, old);
    await limiter.hit(bucket, limit);

    expect(await limiter.sweep(24 * 60 * 60 * 1000)).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM rate_limit WHERE bucket = $1',
      [bucket],
    );
    expect(rows[0]?.count).toBe(1);
  });
});
