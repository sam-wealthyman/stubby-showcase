/**
 * Sessions, backed by Postgres.
 *
 * Section 4: the login is the app account, the wallet is where money moves. A
 * session proves who is signed in and never what they may spend — entries and
 * prizes belong to the wallet, and the chain is the source of truth (4.2). That
 * is what makes this table survivable: losing it costs logins, never funds.
 *
 * **Only the hash is stored.** A session token is a bearer credential, so a row
 * holding the token itself would make a database dump a dump of every live
 * login. SHA-256 is right here where bcrypt would not be: the token is 256 bits
 * of CSPRNG output, so there is no dictionary to attack and nothing for a work
 * factor to buy — while a per-request bcrypt would be a real cost on every
 * authenticated call.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type pg from 'pg';

/** What `query` needs. A Pool, a Client and a PoolClient all satisfy it. */
type Queryable = Pick<pg.Pool, 'query'>;

/** How long a session lasts. Section 4 sets no figure; two weeks is ours. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** 256 bits, so the token cannot be guessed and needs no stretching. */
const TOKEN_BYTES = 32;

export interface Session {
  /** The login this session belongs to. A string: BIGSERIAL outruns a JS number. */
  accountId: string;
  /**
   * The wallet this session signed in **with**, when it signed in with one.
   *
   * Null for an email login. This is not the session's identity — `accountId`
   * is. It is here so a wallet session can show which wallet it came from
   * without a second query, and so signing out of one device does not imply
   * anything about the others.
   */
  address: `0x${string}` | null;
  chainId: number | null;
  expiresAt: Date;
}

export interface IssuedSession extends Session {
  /**
   * The token itself, returned exactly once.
   *
   * Nothing can recover it afterwards, because nothing stores it. A user who
   * loses it signs in again, which costs a signature and no money.
   */
  token: string;
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssueInput {
  accountId: string;
  /** Omit for a login that had no wallet, such as an email link. */
  wallet?: { address: `0x${string}`; chainId: number };
  now?: Date;
}

export interface SessionStore {
  issue(input: IssueInput): Promise<IssuedSession>;
  /** Resolve a token, or null when it is unknown or expired. */
  resolve(token: string): Promise<Session | null>;
  revoke(token: string): Promise<boolean>;
  /** Sign every device out, e.g. after a login is reported compromised. */
  revokeAllFor(accountId: string): Promise<number>;
}

export function createPostgresSessionStore(db: Queryable): SessionStore {
  return {
    async issue({ accountId, wallet, now = new Date() }): Promise<IssuedSession> {
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      // Addresses are stored lower-case so a lookup cannot miss on checksum
      // casing, which is presentation and not identity.
      const stored = (wallet?.address.toLowerCase() ?? null) as `0x${string}` | null;

      await db.query(
        `INSERT INTO session (token_hash, account_id, address, chain_id, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [hash(token), accountId, stored, wallet?.chainId ?? null, expiresAt],
      );
      return { token, accountId, address: stored, chainId: wallet?.chainId ?? null, expiresAt };
    },

    async resolve(token): Promise<Session | null> {
      // Expiry is `now()`, the database's clock, for the same reason the nonce
      // store uses it: with more than one API process there is no single
      // application clock to trust.
      const { rows } = await db.query<{
        account_id: string;
        address: string | null;
        chain_id: string | null;
        expires_at: Date;
      }>(
        `UPDATE session SET last_seen = now()
          WHERE token_hash = $1 AND expires_at > now()
          RETURNING account_id, address, chain_id, expires_at`,
        [hash(token)],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        // Left as a string: BIGSERIAL exceeds what a JS number holds exactly,
        // which is why pg returns BIGINT as text in the first place.
        accountId: row.account_id,
        address: (row.address as `0x${string}` | null) ?? null,
        chainId: row.chain_id === null ? null : Number(row.chain_id),
        expiresAt: row.expires_at,
      };
    },

    async revoke(token): Promise<boolean> {
      const { rowCount } = await db.query(`DELETE FROM session WHERE token_hash = $1 RETURNING 1`, [
        hash(token),
      ]);
      return rowCount === 1;
    },

    async revokeAllFor(accountId): Promise<number> {
      // By account, not by address: an account may have several wallets and an
      // email, and "sign me out everywhere" has to mean all of them.
      const { rowCount } = await db.query(`DELETE FROM session WHERE account_id = $1`, [accountId]);
      return rowCount ?? 0;
    },
  };
}

/** Delete sessions that expired. Not needed for correctness; stops the table growing. */
export async function sweepExpiredSessions(db: Queryable): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM session WHERE expires_at <= now()`);
  return rowCount ?? 0;
}

/**
 * Compare two tokens without leaking where they differ.
 *
 * Not used by `resolve`, which looks up by hash and so compares nothing — this
 * is for callers that hold two tokens and must not compare them with `===`.
 */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so the lengths are equalised through the hash first.
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest(),
  );
}
