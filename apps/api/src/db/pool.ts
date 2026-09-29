/**
 * The connection pool.
 *
 * One place that knows how to connect, so TLS is decided once rather than at
 * every call site that happens to need a database.
 */

import { readFileSync } from 'node:fs';

import pg from 'pg';

/**
 * TLS settings for the connection.
 *
 * Exported so the rules can be tested without opening a socket.
 *
 * Supabase's pooler requires TLS but presents a certificate signed by its own
 * CA, which the system trust store does not carry. There are two ways to live
 * with that and only one of them is good:
 *
 *   - `DATABASE_CA_CERT` set to the path of Supabase's CA certificate
 *     (Project Settings → Database → SSL Configuration → download). The
 *     certificate is verified, and a machine-in-the-middle fails to connect.
 *   - Unset, and verification is switched off. The connection is still
 *     encrypted, but nothing proves the far end is the database. Acceptable for
 *     local development against a throwaway project; not for production, where
 *     that connection carries every nonce and every address.
 *
 * `check-env.mjs` warns when the variable is missing so this does not quietly
 * become the permanent arrangement.
 */
export function tlsConfig(connectionString: string): pg.ClientConfig['ssl'] {
  /*
   * `sslmode=disable` means what it says.
   *
   * pg lets an explicit `ssl` option override whatever the connection string
   * asked for, so passing one unconditionally would force TLS onto a server
   * that does not speak it — a plain local Postgres, a container in CI, or the
   * VPS before certificates exist. The connection is refused, and the error
   * mentions neither TLS nor this function.
   */
  if (/[?&]sslmode=disable(&|$)/.test(connectionString)) return false;

  const caPath = process.env.DATABASE_CA_CERT;
  if (caPath) return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

export interface PoolOptions {
  connectionString?: string;
  /** Kept small: the API is IO-bound and the pooler counts connections. */
  max?: number;
}

/**
 * A pool for `DATABASE_URL`.
 *
 * Throws rather than defaulting to localhost. A default would turn "the
 * connection string is missing in production" into "connection refused", which
 * names the wrong problem.
 */
export function createPool({ connectionString, max = 5 }: PoolOptions = {}): pg.Pool {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString: url, max, ssl: tlsConfig(url) });
}
