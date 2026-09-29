/**
 * The Postgres nonce store, against a real Postgres.
 *
 * These are integration tests on purpose. The whole reason this store exists
 * rather than the in-memory one is that the database enforces single use across
 * processes, and a mocked `query` would only test that the right string was
 * passed to a fake. The interesting question — does the single-use guarantee
 * hold when two requests race — can only be answered by a database.
 *
 * They skip themselves when `DATABASE_URL` is absent, so CI stays green without
 * one and anyone with a `.env` gets the real thing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { generateNonce } from '@stubby/shared';

import { migrate } from '../src/db/migrate.js';
import { createPostgresNonceStore, sweepExpiredNonces } from '../src/db/nonceStore.js';
import { createPool } from '../src/db/pool.js';

const DATABASE_URL = process.env.DATABASE_URL;

const inFuture = (ms: number) => new Date(Date.now() + ms);
const inPast = (ms: number) => new Date(Date.now() - ms);

describe.skipIf(!DATABASE_URL)('createPostgresNonceStore', () => {
  let pool: pg.Pool;
  let store: ReturnType<typeof createPostgresNonceStore>;
  /** Every nonce this file issues, so the table is left as it was found. */
  const issued: string[] = [];

  const freshNonce = () => {
    const nonce = generateNonce();
    issued.push(nonce);
    return nonce;
  };

  beforeAll(async () => {
    // Enough connections that the concurrency test actually races rather than
    // queueing behind a single one.
    pool = createPool({ max: 6 });
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
    store = createPostgresNonceStore(pool);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    if (issued.length > 0) {
      await pool.query('DELETE FROM siwe_nonce WHERE nonce = ANY($1::text[])', [issued]);
    }
    await pool.end();
  });

  it('consumes a nonce it issued', async () => {
    const nonce = freshNonce();
    await store.issue(nonce, inFuture(60_000));
    await expect(store.consume(nonce)).resolves.toBe(true);
  });

  it('refuses a nonce it never issued', async () => {
    await expect(store.consume(generateNonce())).resolves.toBe(false);
  });

  it('refuses the second use of a nonce', async () => {
    const nonce = freshNonce();
    await store.issue(nonce, inFuture(60_000));

    await expect(store.consume(nonce)).resolves.toBe(true);
    // This is the replay: the same signed message, presented twice.
    await expect(store.consume(nonce)).resolves.toBe(false);
  });

  it('refuses an expired nonce', async () => {
    const nonce = freshNonce();
    await store.issue(nonce, inPast(1_000));
    await expect(store.consume(nonce)).resolves.toBe(false);
  });

  it('decides expiry by the database clock, not a clock the caller supplies', async () => {
    const nonce = freshNonce();
    await store.issue(nonce, inPast(1_000));

    // A caller whose clock is behind — or who simply passes the wrong value —
    // must not be able to talk the store into accepting a dead nonce.
    await expect(store.consume(nonce, inPast(10_000))).resolves.toBe(false);
  });

  it('makes a second consumer wait for the first, then refuses it', async () => {
    const nonce = freshNonce();
    await store.issue(nonce, inFuture(60_000));

    // The test that justifies the whole module, and it has to drive two
    // connections by hand. Firing N concurrent `consume` calls at a pool does
    // not work: pg opens connections lazily, so the first call's round trip
    // finishes before the others have a connection to race on, and a
    // SELECT-then-DELETE store passes that test just as cleanly. This was
    // checked, not assumed.
    //
    // Two explicit transactions make the ordering the point rather than an
    // accident. Under READ COMMITTED, a bare SELECT does not see A's uncommitted
    // DELETE, so a SELECT-then-DELETE store hands B the nonce as well — two
    // sign-ins from one nonce. `DELETE .. RETURNING` takes a row lock instead:
    // B blocks, and when A commits, B re-reads and finds nothing.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      await expect(createPostgresNonceStore(a).consume(nonce)).resolves.toBe(true);

      let settled = false;
      const second = createPostgresNonceStore(b)
        .consume(nonce)
        .then((result) => {
          settled = true;
          return result;
        });

      // B must still be waiting on A's lock. If this ever goes flaky it is
      // reporting something real — that the second consumer was not blocked.
      await Promise.race([second, new Promise((r) => setTimeout(r, 500))]);
      expect(settled).toBe(false);

      await a.query('COMMIT');
      await expect(second).resolves.toBe(false);
      await b.query('COMMIT');
    } finally {
      // ROLLBACK is a no-op after COMMIT and unwedges the connection if an
      // assertion threw mid-transaction.
      await a.query('ROLLBACK').catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }
  });

  it('is unmoved by the same nonce being issued twice', async () => {
    const nonce = freshNonce();
    await store.issue(nonce, inFuture(60_000));
    // An insert that threw here would turn a once-in-a-lifetime collision into
    // a 500. It is still one nonce, and still good for one use.
    await store.issue(nonce, inFuture(60_000));

    await expect(store.consume(nonce)).resolves.toBe(true);
    await expect(store.consume(nonce)).resolves.toBe(false);
  });

  it('sweeps expired nonces and leaves live ones alone', async () => {
    const dead = freshNonce();
    const alive = freshNonce();
    await store.issue(dead, inPast(1_000));
    await store.issue(alive, inFuture(60_000));

    const removed = await sweepExpiredNonces(pool);
    expect(removed).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query<{ nonce: string }>(
      'SELECT nonce FROM siwe_nonce WHERE nonce = ANY($1::text[])',
      [[dead, alive]],
    );
    expect(rows.map((row) => row.nonce)).toEqual([alive]);
  });
});

describe.skipIf(DATABASE_URL !== undefined)('without DATABASE_URL', () => {
  it('refuses to guess a connection string', () => {
    expect(() => createPool()).toThrow('DATABASE_URL is not set');
  });
});
