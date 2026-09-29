/**
 * Referrals against a real Postgres: who may refer whom, the one bonus a
 * referral earns (5% of the first purchase, once), and the owner's ledger.
 */

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPostgresSessionStore, type SessionStore } from '../src/auth/sessionStore.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { referralRoutes } from '../src/http/referrals.js';
import {
  awardBonuses,
  claimReferral,
  markPaid,
  owedPayouts,
  referralsOf,
} from '../src/referral/store.js';
import { recordEntries } from '../src/watch/store.js';

const DATABASE_URL = process.env.DATABASE_URL;
const CHAIN_ID = 5042002;
const CONTRACT = '0x00000000000000000000000000000000000e2e02';
const JACK_WALLET = '0x00000000000000000000000000000000000000d4';
const ADA_WALLET = '0x00000000000000000000000000000000000000e5';
const scope = { chainId: CHAIN_ID, contract: CONTRACT };

describe.skipIf(!DATABASE_URL)('referrals', () => {
  let pool: pg.Pool;
  let sessions: SessionStore;
  let jack: string;
  let ada: string;
  let jackName: string;

  async function newAccount(wallet: string, username: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO account (username) VALUES ($1) RETURNING id',
      [username],
    );
    await pool.query('INSERT INTO wallet_link (address, chain_id, account_id) VALUES ($1,$2,$3)', [
      wallet,
      CHAIN_ID,
      rows[0]!.id,
    ]);
    return rows[0]!.id;
  }

  const buy = (wallet: string, block: bigint, paid: bigint) =>
    recordEntries(pool, scope, [
      {
        raffleId: 1n,
        wallet: wallet as `0x${string}`,
        count: 1,
        paid,
        blockNumber: block,
        txHash: `0x${block.toString(16).padStart(64, '0')}`,
        logIndex: 0,
      },
    ]);

  beforeAll(async () => {
    pool = createPool({ max: 3 });
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
    sessions = createPostgresSessionStore(pool);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM chain_entry WHERE contract = $1', [CONTRACT]);
    await pool.query(
      'DELETE FROM account WHERE id IN (SELECT account_id FROM wallet_link WHERE address = ANY($1))',
      [[JACK_WALLET, ADA_WALLET]],
    );
    jackName = `Jack${Date.now() % 1_000_000}`;
    jack = await newAccount(JACK_WALLET, jackName);
    ada = await newAccount(ADA_WALLET, null);
  });

  afterAll(async () => {
    await pool?.query(
      'DELETE FROM account WHERE id IN (SELECT account_id FROM wallet_link WHERE address = ANY($1))',
      [[JACK_WALLET, ADA_WALLET]],
    );
    await pool?.query('DELETE FROM chain_entry WHERE contract = $1', [CONTRACT]);
    await pool?.end();
  });

  it('records a referrer once, never yourself, never an unknown name', async () => {
    expect(await claimReferral(pool, scope, ada, 'NoSuchName')).toBe('unknown');
    expect(await claimReferral(pool, scope, jack, jackName)).toBe('self');
    expect(await claimReferral(pool, scope, ada, jackName.toLowerCase())).toBe('ok');
    expect(await claimReferral(pool, scope, ada, jackName)).toBe('already');
  });

  it('refuses to claim someone who has already bought stubs', async () => {
    await buy(ADA_WALLET, 5n, 1_000_000n);
    expect(await claimReferral(pool, scope, ada, jackName)).toBe('existing-player');
  });

  it('awards 5% of the first purchase only, once', async () => {
    await claimReferral(pool, scope, ada, jackName);
    expect(await awardBonuses(pool, scope)).toEqual([]); // nothing bought yet

    await buy(ADA_WALLET, 10n, 3_000_000n); // first: 3 USDC
    await buy(ADA_WALLET, 11n, 5_000_000n); // later purchases earn nothing
    const awarded = await awardBonuses(pool, scope);
    expect(awarded).toEqual([
      { referredAccountId: ada, referrerAccountId: jack, bonus: 150_000n }, // 0.15 USDC
    ]);
    expect(await awardBonuses(pool, scope)).toEqual([]); // never twice

    expect(await referralsOf(pool, jack, CHAIN_ID)).toMatchObject({
      joined: 1,
      earned: '150000',
      paid: '0',
      owed: '150000',
    });
  });

  it('lists what is owed with the wallet to pay, and marks it paid', async () => {
    await claimReferral(pool, scope, ada, jackName);
    await buy(ADA_WALLET, 10n, 2_000_000n);
    await awardBonuses(pool, scope);

    const owed = (await owedPayouts(pool, CHAIN_ID)).find((p) => p.referrerAccountId === jack);
    expect(owed).toMatchObject({ wallet: JACK_WALLET, owed: '100000', referredAccountIds: [ada] });

    expect(await markPaid(pool, CHAIN_ID, [ada], `0x${'ab'.repeat(32)}`)).toBe(1);
    expect(await markPaid(pool, CHAIN_ID, [ada], `0x${'cd'.repeat(32)}`)).toBe(0); // already paid
    expect(
      (await owedPayouts(pool, CHAIN_ID)).find((p) => p.referrerAccountId === jack),
    ).toBeUndefined();
    expect(await referralsOf(pool, jack, CHAIN_ID)).toMatchObject({ paid: '100000', owed: '0' });
  });

  it('earns one bonus per chain, and each chain lists only its own', async () => {
    const MAINNET = 5042;
    const mainnet = { chainId: MAINNET, contract: CONTRACT };
    await pool.query('INSERT INTO wallet_link (address, chain_id, account_id) VALUES ($1,$2,$3)', [
      ADA_WALLET,
      MAINNET,
      ada,
    ]);
    await pool.query('INSERT INTO wallet_link (address, chain_id, account_id) VALUES ($1,$2,$3)', [
      JACK_WALLET,
      MAINNET,
      jack,
    ]);
    await claimReferral(pool, scope, ada, jackName);

    await buy(ADA_WALLET, 10n, 2_000_000n); // testnet play money
    await awardBonuses(pool, scope);
    await recordEntries(pool, mainnet, [
      {
        raffleId: 1n,
        wallet: ADA_WALLET,
        count: 1,
        paid: 4_000_000n,
        blockNumber: 20n,
        txHash: `0x${'ee'.repeat(32)}`,
        logIndex: 0,
      },
    ]);
    // The testnet bonus does not use up the real one.
    expect(await awardBonuses(pool, mainnet)).toEqual([
      { referredAccountId: ada, referrerAccountId: jack, bonus: 200_000n },
    ]);

    const owedOn = async (chainId: number) =>
      (await owedPayouts(pool, chainId)).find((p) => p.referrerAccountId === jack)?.owed;
    expect(await owedOn(MAINNET)).toBe('200000');
    expect(await owedOn(CHAIN_ID)).toBe('100000');
    expect(await referralsOf(pool, jack, MAINNET)).toMatchObject({ earned: '200000' });

    // Paying on mainnet marks only the mainnet bonus.
    expect(await markPaid(pool, MAINNET, [ada], `0x${'ab'.repeat(32)}`)).toBe(1);
    expect(await owedOn(MAINNET)).toBeUndefined();
    expect(await owedOn(CHAIN_ID)).toBe('100000');
  });

  it('keeps the payout list to the contract owner', async () => {
    const app = referralRoutes({
      sessions,
      claim: async () => 'ok',
      mine: async () => referralsOf(pool, jack, CHAIN_ID),
      owed: async () => owedPayouts(pool, CHAIN_ID),
      markPaid: async () => 0,
      isOwner: async (address) => address === JACK_WALLET,
    });
    const asAda = await sessions.issue({
      accountId: ada,
      wallet: { address: ADA_WALLET, chainId: CHAIN_ID },
    });
    const asJack = await sessions.issue({
      accountId: jack,
      wallet: { address: JACK_WALLET, chainId: CHAIN_ID },
    });
    const get = (token?: string) =>
      app.request(
        '/admin/referrals',
        token ? { headers: { authorization: `Bearer ${token}` } } : {},
      );

    expect((await get()).status).toBe(403);
    expect((await get(asAda.token)).status).toBe(403);
    expect((await get(asJack.token)).status).toBe(200);
  });
});
