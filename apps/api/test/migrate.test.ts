/**
 * The migration runner, against a real Postgres.
 *
 * Everything here runs in a throwaway schema, so it exercises the create path
 * without touching the real tables. The application's SQL uses unqualified
 * names, so a `search_path` on the connection is enough to redirect it.
 */

import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Read the migration list from disk rather than hardcoding it.
 *
 * This file used to name the two files that existed when it was written, so
 * adding a third broke three tests that were not about the third file. What is
 * worth asserting is that every migration on disk gets applied, in name order —
 * not which ones happen to exist today.
 */
const EXPECTED = readdirSync(join(dirname(fileURLToPath(import.meta.url)), '../migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort();

describe.skipIf(!DATABASE_URL)('migrate', () => {
  let pool: pg.Pool;
  const schema = `migrate_test_${randomBytes(6).toString('hex')}`;

  /** A connection whose unqualified names resolve inside the throwaway schema. */
  async function scopedClient(): Promise<pg.PoolClient> {
    const client = await pool.connect();
    await client.query(`SET search_path TO ${schema}`);
    return client;
  }

  beforeAll(async () => {
    pool = createPool({ max: 6 });
    await pool.query(`CREATE SCHEMA ${schema}`);
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it('applies every migration to an empty schema', async () => {
    const client = await scopedClient();
    try {
      const result = await migrate(client);
      expect(result.applied).toEqual(EXPECTED);
      expect(EXPECTED.length, 'there should be migrations to apply').toBeGreaterThan(0);
      expect(result.alreadyApplied).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('applies nothing the second time', async () => {
    const client = await scopedClient();
    try {
      const result = await migrate(client);
      expect(result.applied).toEqual([]);
      expect(result.alreadyApplied).toEqual(EXPECTED);
    } finally {
      client.release();
    }
  });

  /**
   * The race this runner was fixed for.
   *
   * `CREATE TABLE IF NOT EXISTS` is not race-safe: two connections can both
   * pass the existence check, and the loser fails with a unique violation on
   * `pg_type` — an error that names neither the table nor the race. Two API
   * instances starting together is the production version; two test files
   * migrating in parallel is how it was actually found.
   *
   * Without `pg_advisory_lock` in `migrate`, this test fails with
   * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`.
   */
  it('survives four migrators racing on an empty schema', async () => {
    const raceSchema = `${schema}_race`;
    await pool.query(`CREATE SCHEMA ${raceSchema}`);

    const clients = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const client = await pool.connect();
        await client.query(`SET search_path TO ${raceSchema}`);
        return client;
      }),
    );

    try {
      const results = await Promise.all(clients.map((client) => migrate(client)));

      // Exactly one migrator does the work; the rest find it already done.
      const didWork = results.filter((result) => result.applied.length > 0);
      expect(didWork).toHaveLength(1);
      expect(didWork[0]?.applied).toEqual(EXPECTED);
    } finally {
      for (const client of clients) client.release();
      await pool.query(`DROP SCHEMA IF EXISTS ${raceSchema} CASCADE`);
    }
  });
});
