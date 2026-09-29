/**
 * Migrations, owned as SQL files.
 *
 * ADR 0007: the database must stay portable, so migrations are plain SQL this
 * project owns and can run against any Postgres, not a vendor's migration
 * product. The runner is deliberately small — it applies files in name order
 * and records what it applied.
 *
 * Each migration runs inside a transaction together with the row recording it,
 * so a migration that fails partway leaves nothing behind. A half-applied
 * migration with a row claiming success is the failure mode worth designing
 * out, because it is silent and the next deploy skips it.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

import { createPool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migration (
    name       TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * A fixed key for the advisory lock that serialises migrators.
 *
 * Any constant works as long as it never changes; this one is arbitrary and
 * project-specific so it cannot collide with another application sharing the
 * database.
 */
const MIGRATION_LOCK_KEY = 6_183_927_441_058_204n;

export async function migrate(client: pg.Client | pg.PoolClient): Promise<MigrateResult> {
  /*
   * One migrator at a time, across every process.
   *
   * `CREATE TABLE IF NOT EXISTS` is **not** race-safe: two connections can both
   * pass the existence check and the loser fails on a unique violation in
   * `pg_type`, not on anything that mentions the table. Two API instances
   * starting together is the production version of that race; two test files
   * migrating in parallel is how it was found.
   *
   * A session-level lock, not `pg_advisory_xact_lock`, because each migration
   * below runs in its own transaction and a transaction lock would be released
   * at the first COMMIT. It is held on this one connection, which is why
   * `migrate` takes a client rather than a pool.
   */
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
  try {
    return await applyMigrations(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
  }
}

async function applyMigrations(client: pg.Client | pg.PoolClient): Promise<MigrateResult> {
  await client.query(CREATE_TABLE);

  const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migration');
  const done = new Set(rows.map((row) => row.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of files) {
    if (done.has(file)) {
      alreadyApplied.push(file);
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${String(error)}`, { cause: error });
    }
  }

  return { applied, alreadyApplied };
}

// Run directly: node --experimental-strip-types src/db/migrate.ts
//
// Compared as resolved paths rather than by filename, so importing this module
// from a test runner cannot accidentally satisfy the check and run migrations
// against whatever DATABASE_URL happens to be set.
const runDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (runDirectly) {
  let pool: pg.Pool;
  try {
    pool = createPool({ max: 1 });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const client = await pool.connect();
  try {
    const result = await migrate(client);
    for (const name of result.applied) console.log(`applied  ${name}`);
    for (const name of result.alreadyApplied) console.log(`skipped  ${name} (already applied)`);
    if (result.applied.length === 0) console.log('nothing to apply');
  } finally {
    client.release();
    await pool.end();
  }
}
