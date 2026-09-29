/**
 * One watcher pass against a real Postgres and a chain made up for the test.
 *
 * The chain is fake because the questions here are about the database: that
 * entrants are recorded once however often a range is read, that each account
 * hears about a draw exactly once, that a failed send is retried, and that an
 * alert waits out its grace period and is not repeated every thirty seconds.
 */

import type { RaffleState } from '@stubby/shared';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import type { ChainReader, EntryLog, RaffleEventLog } from '../src/watch/chain.js';
import type { Notice, Notifier } from '../src/watch/notices.js';
import { activityStats, raffleEvents, recentActivity } from '../src/watch/store.js';
import { tick } from '../src/watch/tick.js';
import { recordingSender } from '../src/push/fcm.js';
import { pushToAccount } from '../src/push/store.js';

const DATABASE_URL = process.env.DATABASE_URL;
const CHAIN_ID = 5042002;
// A contract address used by no other test, so the rows here are this file's.
const CONTRACT = '0x00000000000000000000000000000000000e2e01';
const WINNER = '0x00000000000000000000000000000000000000a1';
const LOSER = '0x00000000000000000000000000000000000000b2';
const STRANGER = '0x00000000000000000000000000000000000000c3';

function raffle(over: Partial<RaffleState>): RaffleState {
  return {
    id: 1n,
    status: 'Open',
    prize: 4_000_000n,
    entryPrice: 1_000_000n,
    totalEntries: 5,
    entriesSold: 0,
    collected: 0n,
    prizeCovered: false,
    windowEnds: new Date(Date.now() + 86_400_000),
    winner: null,
    winningEntry: null,
    prizeOwed: 0n,
    commissionOwed: 0n,
    prizePaid: false,
    requestedAt: null,
    ...over,
  };
}

function entry(wallet: string, block: bigint, logIndex: number): EntryLog {
  return {
    raffleId: 1n,
    wallet: wallet as `0x${string}`,
    count: 1,
    paid: 1_000_000n,
    blockNumber: block,
    txHash: `0x${block.toString(16).padStart(64, '0')}`,
    logIndex,
  };
}

function fakeChain(state: {
  raffles: RaffleState[];
  entries: EntryLog[];
  events?: RaffleEventLog[];
  head: bigint;
}): ChainReader {
  const inRange = (from: bigint, to: bigint) => (e: { blockNumber: bigint }) =>
    e.blockNumber >= from && e.blockNumber <= to;
  return {
    raffles: async () => state.raffles,
    head: async () => state.head,
    logs: async (from, to) => ({
      entries: state.entries.filter(inRange(from, to)),
      events: (state.events ?? []).filter(inRange(from, to)),
    }),
    randomnessTimeoutMs: async () => 3_600_000,
    pendingRandomness: async () => undefined,
    solvent: async () => true,
    requestsAffordable: async () => undefined,
  };
}

function recorder(fail = false): Notifier & { sent: Notice[] } {
  const sent: Notice[] = [];
  return {
    name: 'recorder',
    sent,
    async send(notice) {
      if (fail) throw new Error('relay down');
      sent.push(notice);
    },
  };
}

describe.skipIf(!DATABASE_URL)('watcher tick', () => {
  let pool: pg.Pool;

  async function account(email: string | null, wallet: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO account DEFAULT VALUES RETURNING id',
    );
    const id = rows[0]!.id;
    await pool.query('INSERT INTO wallet_link (address, chain_id, account_id) VALUES ($1,$2,$3)', [
      wallet,
      CHAIN_ID,
      id,
    ]);
    if (email) {
      await pool.query('INSERT INTO account_email (email, account_id) VALUES ($1,$2)', [email, id]);
    }
    return id;
  }

  beforeAll(async () => {
    pool = createPool({ max: 3 });
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM chain_entry WHERE contract = $1', [CONTRACT]);
    await pool.query('DELETE FROM chain_raffle WHERE contract = $1', [CONTRACT]);
    await pool.query('DELETE FROM chain_event WHERE contract = $1', [CONTRACT]);
    await pool.query('DELETE FROM notice_sent WHERE contract = $1', [CONTRACT]);
    await pool.query("DELETE FROM chain_cursor WHERE name LIKE '%' || $1 || '%'", [CONTRACT]);
    await pool.query('DELETE FROM owner_alert');
    await pool.query('DELETE FROM wallet_link WHERE address = ANY($1)', [
      [WINNER, LOSER, STRANGER],
    ]);
    await pool.query("DELETE FROM account_email WHERE email LIKE 'watch-%@example.com'");
  });

  afterAll(async () => {
    await pool?.end();
  });

  const scope = { chainId: CHAIN_ID, contract: CONTRACT };

  it('tells each entrant with an email the result, once', async () => {
    await account('watch-winner@example.com', WINNER);
    await account('watch-loser@example.com', LOSER);
    await account(null, STRANGER); // entered, but no email: nothing to send to

    const state = {
      raffles: [raffle({ status: 'Open' })],
      entries: [entry(WINNER, 10n, 0), entry(LOSER, 11n, 0), entry(STRANGER, 12n, 0)],
      head: 12n,
    };
    const chain = fakeChain(state);
    const notifier = recorder();
    const options = {
      pool,
      chain,
      scope,
      notifier,
      appOrigin: 'https://s.example',
      startBlock: 0n,
      chunk: 5n,
    };

    expect((await tick(options)).entries).toBe(3);
    expect(notifier.sent).toEqual([]); // not drawn yet

    state.raffles = [
      raffle({ status: 'Completed', winner: WINNER as `0x${string}`, prizeOwed: 4_000_000n }),
    ];
    await tick(options);
    const subjects = notifier.sent.map((n) => [n.to, n.subject]).sort();
    expect(subjects).toEqual([
      ['watch-loser@example.com', 'Stubby draw #1 has been drawn'],
      ['watch-winner@example.com', 'You won 4 USDC in Stubby draw #1'],
    ]);

    await tick(options);
    expect(notifier.sent).toHaveLength(2); // never twice
    // Each carries a way to stop them.
    for (const sent of notifier.sent) {
      expect(sent.unsubscribeUrl).toMatch(/^https:\/\/s\.example\/api\/mail\/unsubscribe\?t=/);
      expect(sent.text).toContain(`Stop these emails: ${sent.unsubscribeUrl}`);
    }
  });

  it('sends no result to an account that turned mail off, and none later either', async () => {
    const id = await account('watch-winner@example.com', WINNER);
    await pool.query('UPDATE account SET mail_opt_out_at = now() WHERE id = $1', [id]);
    const state = {
      raffles: [
        raffle({ status: 'Completed', winner: WINNER as `0x${string}`, prizeOwed: 4_000_000n }),
      ],
      entries: [entry(WINNER, 10n, 0)],
      head: 10n,
    };
    const notifier = recorder();
    const options = {
      pool,
      chain: fakeChain(state),
      scope,
      notifier,
      appOrigin: 'https://s.example',
      startBlock: 0n,
      chunk: 5n,
    };
    await tick(options);
    expect(notifier.sent).toEqual([]);

    // Turned back on: no backlog of old results arrives.
    await pool.query('UPDATE account SET mail_opt_out_at = NULL WHERE id = $1', [id]);
    await tick(options);
    expect(notifier.sent).toEqual([]);
  });

  it('pushes a win to the phones of an account with no email', async () => {
    const id = await account(null, WINNER);
    await pool.query(
      `INSERT INTO push_device (token, account_id, platform) VALUES ($1, $2, 'android')`,
      ['watch-phone-token-0000000001', id],
    );
    const state = {
      raffles: [
        raffle({ status: 'Completed', winner: WINNER as `0x${string}`, prizeOwed: 4_000_000n }),
      ],
      entries: [entry(WINNER, 10n, 0)],
      head: 10n,
    };
    const pusher = recordingSender();
    const options = {
      pool,
      chain: fakeChain(state),
      scope,
      notifier: recorder(),
      pusher,
      appOrigin: 'https://s.example',
      startBlock: 0n,
      chunk: 5n,
    };
    await tick(options);
    expect(pusher.sent.map((p) => [p.token, p.message.title, p.message.href])).toEqual([
      ['watch-phone-token-0000000001', 'You won 4 USDC!', '/won/1'],
    ]);
    await tick(options);
    expect(pusher.sent).toHaveLength(1); // once
    await pool.query(`DELETE FROM push_device WHERE token = 'watch-phone-token-0000000001'`);
  });

  it('forgets a phone the push service says is gone', async () => {
    const id = await account(null, WINNER);
    await pool.query(
      `INSERT INTO push_device (token, account_id, platform) VALUES ($1, $2, 'android')`,
      ['watch-phone-token-0000000002', id],
    );
    const gone = { name: 'gone', send: async () => 'gone' as const };
    const reached = await pushToAccount(pool, gone, id, { title: 't', body: 'b', href: '/' });
    expect(reached).toBe(0);
    const { rowCount } = await pool.query(
      `SELECT 1 FROM push_device WHERE token = 'watch-phone-token-0000000002'`,
    );
    expect(rowCount).toBe(0);
  });

  it('retries a notice whose send failed', async () => {
    await account('watch-winner@example.com', WINNER);
    const state = {
      raffles: [
        raffle({ status: 'Completed', winner: WINNER as `0x${string}`, prizeOwed: 4_000_000n }),
      ],
      entries: [entry(WINNER, 10n, 0)],
      head: 10n,
    };
    const base = {
      pool,
      chain: fakeChain(state),
      scope,
      appOrigin: 'https://s.example',
      startBlock: 0n,
    };

    const down = recorder(true);
    const report = await tick({ ...base, notifier: down });
    expect(report.errors.join()).toContain('relay down');

    const up = recorder();
    await tick({ ...base, notifier: up });
    expect(up.sent.map((n) => n.to)).toEqual(['watch-winner@example.com']);
  });

  it('keeps the draw milestones, once each, for the proof to link', async () => {
    const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
    const state = {
      raffles: [
        raffle({ status: 'Completed', winner: WINNER as `0x${string}`, prizeOwed: 4_000_000n }),
      ],
      entries: [],
      events: [
        {
          raffleId: 1n,
          kind: 'DrawStarted' as const,
          blockNumber: 20n,
          txHash: tx(20),
          logIndex: 0,
        },
        { raffleId: 1n, kind: 'Drawn' as const, blockNumber: 21n, txHash: tx(21), logIndex: 1 },
      ],
      head: 21n,
    };
    const options = {
      pool,
      chain: fakeChain(state),
      scope,
      notifier: recorder(),
      appOrigin: 'https://s.example',
      startBlock: 0n,
      chunk: 7n,
    };
    await tick(options);
    await tick(options); // a second pass over nothing new adds nothing

    const found = await raffleEvents(pool, scope, 1n);
    expect(found).toEqual({
      DrawStarted: { txHash: tx(20), blockNumber: '20' },
      Drawn: { txHash: tx(21), blockNumber: '21' },
    });
    expect(await raffleEvents(pool, scope, 2n)).toEqual({});
  });

  it('names a wallet in the feed by its username, and shortens the rest', async () => {
    const winnerAccount = await account(null, WINNER);
    await pool.query('UPDATE account SET username = $2 WHERE id = $1', [
      winnerAccount,
      `Winner${Date.now() % 100000}`,
    ]);
    const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
    const state = {
      raffles: [
        raffle({ status: 'Completed', winner: WINNER as `0x${string}`, prizeOwed: 4_000_000n }),
      ],
      entries: [entry(WINNER, 10n, 0), entry(LOSER, 11n, 0)],
      events: [
        { raffleId: 1n, kind: 'Drawn' as const, blockNumber: 12n, txHash: tx(12), logIndex: 0 },
      ],
      head: 12n,
    };
    await tick({
      pool,
      chain: fakeChain(state),
      scope,
      notifier: recorder(),
      appOrigin: 'https://s.example',
      startBlock: 0n,
    });

    const feed = await recentActivity(pool, scope);
    const { rows } = await pool.query<{ username: string }>(
      'SELECT username FROM account WHERE id = $1',
      [winnerAccount],
    );
    expect(feed[0]).toMatchObject({ kind: 'won', name: rows[0]!.username, amount: '4000000' });
    expect(feed.find((i) => i.kind === 'entered' && i.name.startsWith('0x0000'))?.name).toBe(
      '0x0000…00b2',
    );
    expect(JSON.stringify(feed)).not.toContain(LOSER); // never the full address

    // The players row: both wallets counted once each, the newest purchase
    // first (the loser's, later in the same block), and the win named as the
    // feed names it.
    const stats = await activityStats(pool, scope);
    expect(stats.players).toBe(2);
    expect(stats.recent).toEqual(['0x0000…00b2', rows[0]!.username]);
    expect(stats.latestWin).toEqual({ name: rows[0]!.username, amount: '4000000', raffleId: '1' });
    expect(JSON.stringify(stats)).not.toContain(LOSER);
    await pool.query('UPDATE account SET username = NULL WHERE id = $1', [winnerAccount]);
  });

  it('holds a full raffle alert for its grace period, then sends it once', async () => {
    const state = { raffles: [raffle({ status: 'ReadyToDraw' })], entries: [], head: 1n };
    const notifier = recorder();
    let clock = new Date();
    const options = {
      pool,
      chain: fakeChain(state),
      scope,
      notifier,
      appOrigin: 'https://s.example',
      ownerEmail: 'owner@example.com',
      now: () => clock,
    };

    // The row's first_seen is the database's now(); run the clock from there.
    await tick(options);
    const { rows } = await pool.query<{ first_seen: Date }>('SELECT first_seen FROM owner_alert');
    clock = new Date(rows[0]!.first_seen.getTime() + 60_000);
    await tick(options);
    expect(notifier.sent).toEqual([]);

    clock = new Date(rows[0]!.first_seen.getTime() + 11 * 60_000);
    await tick(options);
    expect(notifier.sent.map((n) => n.subject)).toEqual([
      'Stubby: Draw #1: Full, and no draw has started',
    ]);

    clock = new Date(clock.getTime() + 60_000);
    await tick(options);
    expect(notifier.sent).toHaveLength(1);

    // Cleared, it is forgotten.
    state.raffles = [raffle({ status: 'Drawing', requestedAt: clock })];
    await tick(options);
    expect((await pool.query('SELECT 1 FROM owner_alert')).rowCount).toBe(0);
  });
});
