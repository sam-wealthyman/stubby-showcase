/**
 * Put the repository's `.env` into `process.env` for tests.
 *
 * Vitest inherits the shell's environment and nothing else; Vite's own `.env`
 * handling only exposes `VITE_`-prefixed values to client code. The database
 * tests need `DATABASE_URL`, and requiring every contributor to export it by
 * hand is how a test suite ends up permanently skipped.
 *
 * Existing values win, so `DATABASE_URL=... pnpm test` still points the tests
 * wherever the caller says.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../.env');

try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2];
  }
} catch {
  // No .env. The database tests skip themselves, which is what CI wants.
}
