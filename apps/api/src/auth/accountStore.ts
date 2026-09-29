/**
 * Accounts: the login, which is not the wallet.
 *
 * Section 4 keeps them apart and Section 4.3 says why it matters — losing a
 * login must never lose funds. Everything here is recoverable by signing a
 * message, because entries and prizes belong to the wallet and the chain is the
 * source of truth (4.2). Nothing in this file holds money or can move it.
 *
 * Both entry points are **find-or-create**. A sign-in is not a registration
 * step: Section 4.1 has no sign-up flow, so the first time an email or a wallet
 * appears it becomes an account, and every time after it finds the same one.
 */

import type pg from 'pg';

import { requireEmail } from '@stubby/shared';

import { mailOptedOut, setMailOptOut, unsubscribeByToken } from '../mail/prefs.js';
import { pushOptedOut, registerDevice, removeDevice, setPushOptOut } from '../push/store.js';

type Queryable = Pick<pg.Pool, 'query' | 'connect'>;

export interface Account {
  id: string;
  createdAt: Date;
}

export interface LinkedWallet {
  address: `0x${string}`;
  chainId: number;
}

export interface AccountStore {
  /** The account for this wallet, creating it and the link if new. */
  forWallet(address: `0x${string}`, chainId: number): Promise<Account>;
  /** The account for this email, creating it if new. */
  forEmail(email: string): Promise<Account>;
  /**
   * The account for this X user, creating it if new.
   *
   * Keyed by X's user id; the handle is refreshed on every sign-in, because X
   * lets it change and the stored one is only for display.
   */
  forX(xUserId: string, username: string): Promise<Account>;
  /**
   * Which account holds this wallet, or null when nobody does.
   *
   * `linkWallet` alone cannot answer the question a link route needs, because
   * it returns false both when the wallet is already yours and when it belongs
   * to somebody else — and only one of those is a refusal.
   */
  ownerOfWallet(address: `0x${string}`, chainId: number): Promise<string | null>;
  /** Attach another wallet to an existing account (Section 4.2). */
  linkWallet(accountId: string, address: `0x${string}`, chainId: number): Promise<boolean>;
  /**
   * Fold an account that is **only wallets** into another, when the person
   * has just proved they control both: a signature from the wallet, and a
   * session on the other account.
   *
   * Wallets move, and so does the username when `into` has none. Referrals
   * the old account made are credited to `into`; the referral it arrived by
   * moves too, unless `into` already has one or would be referring itself.
   * The old account keeps nothing that signs in, and its sessions end.
   *
   * `has-login` when `from` has an email or X login of its own: that is a
   * second person's account as far as anyone can tell, and it stays apart.
   */
  absorbWalletOnlyAccount(from: string, into: string): Promise<'merged' | 'has-login'>;
  /** Detach a wallet. Returns false when it was not this account's to detach. */
  unlinkWallet(accountId: string, address: `0x${string}`, chainId: number): Promise<boolean>;
  walletsFor(accountId: string): Promise<LinkedWallet[]>;
  emailFor(accountId: string): Promise<string | null>;
  /** The X handle this account signs in with, without the @, or null. */
  xUsernameFor(accountId: string): Promise<string | null>;
  /** When the account first appeared, or null if there is no such account. */
  createdAtFor(accountId: string): Promise<Date | null>;
  /** The public username this account chose, or null. */
  usernameFor(accountId: string): Promise<string | null>;
  /**
   * Set or clear the public username. `taken` when another account holds it
   * in any case; the name's shape is checked by the caller (checkUsername).
   */
  setUsername(accountId: string, username: string | null): Promise<'ok' | 'taken'>;
  /** Whether result and referral mail is on (it is unless turned off). */
  resultEmailsFor(accountId: string): Promise<boolean>;
  setResultEmails(accountId: string, on: boolean): Promise<void>;
  /** A mail's unsubscribe link. False when the token is unknown. */
  unsubscribeMail(token: string): Promise<boolean>;
  /** Push: a phone's FCM token, registered to (or moved to) this account. */
  registerPush(accountId: string, token: string, platform: string): Promise<void>;
  removePush(accountId: string, token: string): Promise<void>;
  pushOnFor(accountId: string): Promise<boolean>;
  setPushOn(accountId: string, on: boolean): Promise<void>;
}

/**
 * `id` is a string, not a number.
 *
 * `BIGSERIAL` exceeds what a JS number represents exactly, and pg returns
 * `BIGINT` as a string for that reason. Converting to `Number` would work for a
 * long time and then silently start colliding, so the string is carried through.
 */
function toAccount(row: { id: string; created_at: Date }): Account {
  return { id: row.id, createdAt: row.created_at };
}

export function createPostgresAccountStore(db: Queryable): AccountStore {
  return {
    async forWallet(address, chainId) {
      // Lower-cased: checksum casing is presentation, not identity, and a
      // wallet presenting the same address cased differently must not get a
      // second account.
      const stored = address.toLowerCase();

      const existing = await db.query<{ id: string; created_at: Date }>(
        `SELECT a.id, a.created_at FROM account a
           JOIN wallet_link w ON w.account_id = a.id
          WHERE w.address = $1 AND w.chain_id = $2`,
        [stored, chainId],
      );
      const found = existing.rows[0];
      if (found) return toAccount(found);

      /*
       * One statement, so two simultaneous first sign-ins cannot both create an
       * account for the same wallet.
       *
       * The CTE inserts the account, the insert links the wallet, and
       * `ON CONFLICT DO NOTHING` on the link means the loser of a race inserts
       * nothing — which is why the SELECT below is not optional. It re-reads
       * rather than trusting `RETURNING`, because the winner's account is the
       * one that must be returned to both callers.
       */
      await db.query(
        `WITH fresh AS (INSERT INTO account DEFAULT VALUES RETURNING id)
         INSERT INTO wallet_link (address, chain_id, account_id)
         SELECT $1, $2, id FROM fresh
         ON CONFLICT (address, chain_id) DO NOTHING`,
        [stored, chainId],
      );

      const settled = await db.query<{ id: string; created_at: Date }>(
        `SELECT a.id, a.created_at FROM account a
           JOIN wallet_link w ON w.account_id = a.id
          WHERE w.address = $1 AND w.chain_id = $2`,
        [stored, chainId],
      );
      const row = settled.rows[0];
      if (!row) throw new Error('could not create or find an account for that wallet');
      return toAccount(row);
    },

    async forEmail(input) {
      // Normalised through the shared helper, so the app and the API cannot
      // disagree about which address is which account.
      const email = requireEmail(input);

      const existing = await db.query<{ id: string; created_at: Date }>(
        `SELECT a.id, a.created_at FROM account a
           JOIN account_email e ON e.account_id = a.id
          WHERE e.email = $1`,
        [email],
      );
      const found = existing.rows[0];
      if (found) return toAccount(found);

      await db.query(
        `WITH fresh AS (INSERT INTO account DEFAULT VALUES RETURNING id)
         INSERT INTO account_email (email, account_id)
         SELECT $1, id FROM fresh
         ON CONFLICT (email) DO NOTHING`,
        [email],
      );

      const settled = await db.query<{ id: string; created_at: Date }>(
        `SELECT a.id, a.created_at FROM account a
           JOIN account_email e ON e.account_id = a.id
          WHERE e.email = $1`,
        [email],
      );
      const row = settled.rows[0];
      if (!row) throw new Error('could not create or find an account for that email');
      return toAccount(row);
    },

    async forX(xUserId, username) {
      await db.query(
        `WITH fresh AS (
           INSERT INTO account
           SELECT WHERE NOT EXISTS (SELECT 1 FROM account_x WHERE x_user_id = $1)
           RETURNING id
         )
         INSERT INTO account_x (x_user_id, username, account_id)
         SELECT $1, $2, id FROM fresh
         ON CONFLICT (x_user_id) DO NOTHING`,
        [xUserId, username],
      );
      // The handle is refreshed after the fact, so a returning user who renamed
      // on X shows as who they are now.
      const { rows } = await db.query<{ id: string; created_at: Date }>(
        `WITH seen AS (
           UPDATE account_x SET username = $2 WHERE x_user_id = $1 RETURNING account_id
         )
         SELECT a.id, a.created_at FROM account a JOIN seen ON seen.account_id = a.id`,
        [xUserId, username],
      );
      const row = rows[0];
      if (!row) throw new Error('could not create or find an account for that X user');
      return toAccount(row);
    },

    async ownerOfWallet(address, chainId) {
      const { rows } = await db.query<{ account_id: string }>(
        `SELECT account_id FROM wallet_link WHERE address = $1 AND chain_id = $2`,
        [address.toLowerCase(), chainId],
      );
      return rows[0]?.account_id ?? null;
    },

    async linkWallet(accountId, address, chainId) {
      const { rowCount } = await db.query(
        `INSERT INTO wallet_link (address, chain_id, account_id) VALUES ($1, $2, $3)
         ON CONFLICT (address, chain_id) DO NOTHING`,
        [address.toLowerCase(), chainId, accountId],
      );
      // False when the wallet already belongs to an account — possibly this one.
      // The caller decides whether that is an error; the store will not steal a
      // wallet from another login.
      return rowCount === 1;
    },

    async absorbWalletOnlyAccount(from, into) {
      if (from === into) return 'merged';
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        // Both rows locked, in id order, so two merges cannot deadlock.
        await client.query(`SELECT id FROM account WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [
          [from, into],
        ]);
        const logins = await client.query(
          `SELECT 1 FROM account_email WHERE account_id = $1
           UNION ALL SELECT 1 FROM account_x WHERE account_id = $1`,
          [from],
        );
        if ((logins.rowCount ?? 0) > 0) {
          await client.query('ROLLBACK');
          return 'has-login';
        }

        await client.query(`UPDATE wallet_link SET account_id = $2 WHERE account_id = $1`, [
          from,
          into,
        ]);

        // The username, when `into` has none. Cleared first: it is unique.
        const names = await client.query<{ id: string; username: string | null }>(
          `SELECT id, username FROM account WHERE id = ANY($1)`,
          [[from, into]],
        );
        const oldName = names.rows.find((r) => r.id === from)?.username ?? null;
        const newName = names.rows.find((r) => r.id === into)?.username ?? null;
        if (oldName !== null && newName === null) {
          await client.query(`UPDATE account SET username = NULL WHERE id = $1`, [from]);
          await client.query(`UPDATE account SET username = $2 WHERE id = $1`, [into, oldName]);
        }

        // Referrals `from` made: credited to `into`, except one naming `into`
        // itself, which would be a self-referral and stays where it is.
        await client.query(
          `UPDATE referral_bonus SET referrer_account_id = $2
            WHERE referrer_account_id = $1 AND referred_account_id <> $2`,
          [from, into],
        );
        await client.query(
          `UPDATE referral SET referrer_account_id = $2
            WHERE referrer_account_id = $1 AND referred_account_id <> $2`,
          [from, into],
        );

        // The referral `from` arrived by, if `into` has none and it is not
        // `into`'s own. The bonus row points at the referral, so it is moved
        // by inserting the new referral, repointing the bonus, then deleting.
        const moved = await client.query(
          `INSERT INTO referral (referred_account_id, referrer_account_id, created_at)
           SELECT $2, referrer_account_id, created_at FROM referral
            WHERE referred_account_id = $1 AND referrer_account_id <> $2
              AND NOT EXISTS (SELECT 1 FROM referral WHERE referred_account_id = $2)`,
          [from, into],
        );
        if ((moved.rowCount ?? 0) > 0) {
          await client.query(
            `UPDATE referral_bonus SET referred_account_id = $2 WHERE referred_account_id = $1`,
            [from, into],
          );
          await client.query(`DELETE FROM referral WHERE referred_account_id = $1`, [from]);
        }

        await client.query(`DELETE FROM session WHERE account_id = $1`, [from]);
        await client.query('COMMIT');
        return 'merged';
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async unlinkWallet(accountId, address, chainId) {
      // Scoped to the account, so one login cannot detach another's wallet.
      const { rowCount } = await db.query(
        `DELETE FROM wallet_link WHERE address = $1 AND chain_id = $2 AND account_id = $3`,
        [address.toLowerCase(), chainId, accountId],
      );
      return rowCount === 1;
    },

    async walletsFor(accountId) {
      const { rows } = await db.query<{ address: string; chain_id: string }>(
        `SELECT address, chain_id FROM wallet_link WHERE account_id = $1 ORDER BY created_at`,
        [accountId],
      );
      return rows.map((row) => ({
        address: row.address as `0x${string}`,
        chainId: Number(row.chain_id),
      }));
    },

    async emailFor(accountId) {
      const { rows } = await db.query<{ email: string }>(
        `SELECT email FROM account_email WHERE account_id = $1`,
        [accountId],
      );
      return rows[0]?.email ?? null;
    },

    async createdAtFor(accountId) {
      const { rows } = await db.query<{ created_at: Date }>(
        `SELECT created_at FROM account WHERE id = $1`,
        [accountId],
      );
      return rows[0]?.created_at ?? null;
    },

    async usernameFor(accountId) {
      const { rows } = await db.query<{ username: string | null }>(
        `SELECT username FROM account WHERE id = $1`,
        [accountId],
      );
      return rows[0]?.username ?? null;
    },

    async setUsername(accountId, username) {
      try {
        await db.query(`UPDATE account SET username = $2 WHERE id = $1`, [accountId, username]);
        return 'ok';
      } catch (error) {
        // The unique index on lower(username) decides races, not a prior read.
        if ((error as { code?: string }).code === '23505') return 'taken';
        throw error;
      }
    },

    async resultEmailsFor(accountId) {
      return !(await mailOptedOut(db, accountId));
    },

    async setResultEmails(accountId, on) {
      await setMailOptOut(db, accountId, !on);
    },

    async unsubscribeMail(token) {
      return unsubscribeByToken(db, token);
    },

    async registerPush(accountId, token, platform) {
      await registerDevice(db, accountId, token, platform);
    },

    async removePush(accountId, token) {
      await removeDevice(db, accountId, token);
    },

    async pushOnFor(accountId) {
      return !(await pushOptedOut(db, accountId));
    },

    async setPushOn(accountId, on) {
      await setPushOptOut(db, accountId, !on);
    },

    async xUsernameFor(accountId) {
      const { rows } = await db.query<{ username: string }>(
        `SELECT username FROM account_x WHERE account_id = $1`,
        [accountId],
      );
      return rows[0]?.username ?? null;
    },
  };
}
