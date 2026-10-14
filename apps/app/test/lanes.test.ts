import { describe, expect, it } from 'vitest';

import { parseUsdc, type RaffleState } from '@stubby/shared';

import {
  RANDOMNESS_TIMEOUT_MS,
  commissionOwed,
  intoLanes,
  laneFor,
  type Attention,
} from '../src/chain/lanes.js';

const NOW = new Date('2026-09-22T12:00:00Z');
const past = (ms: number) => new Date(NOW.getTime() - ms);
const future = (ms: number) => new Date(NOW.getTime() + ms);

function raffle(overrides: Partial<RaffleState> = {}): RaffleState {
  return {
    id: 1n,
    status: 'Open',
    prize: parseUsdc('50'),
    entryPrice: parseUsdc('1'),
    totalEntries: 70,
    entriesSold: 30,
    collected: parseUsdc('30'),
    prizeCovered: false,
    windowEnds: future(86_400_000),
    winner: null,
    winningEntry: null,
    prizeOwed: 0n,
    commissionOwed: 0n,
    prizePaid: false,
    ...overrides,
  };
}

const lane = (o: Partial<RaffleState>) => laneFor({ raffle: raffle(o), now: NOW }).lane;
const why = (o: Partial<RaffleState>): Attention | undefined =>
  laneFor({ raffle: raffle(o), now: NOW }).attention;

describe('laneFor', () => {
  it('puts a healthy open raffle in Open', () => {
    expect(lane({})).toBe('open');
  });

  it('moves it to Prize covered once the pot reaches the prize', () => {
    expect(lane({ prizeCovered: true })).toBe('prize-covered');
  });

  it('puts a fresh draw in Drawing', () => {
    expect(lane({ status: 'Drawing', windowEnds: past(60_000) })).toBe('drawing');
  });

  /**
   * The lane that earns the screen.
   *
   * A dashboard that only mirrored `status` would show four healthy columns
   * while a full raffle sat waiting for a draw nobody knew to start.
   */
  it('flags a full raffle nobody has drawn', () => {
    expect(lane({ status: 'ReadyToDraw' })).toBe('needs-a-look');
    expect(why({ status: 'ReadyToDraw' })).toBe('waiting-to-draw');
  });

  it('flags a draw that has not come back past the timeout', () => {
    const stuck = { status: 'Drawing' as const, windowEnds: past(RANDOMNESS_TIMEOUT_MS + 60_000) };
    expect(lane(stuck)).toBe('needs-a-look');
    expect(why(stuck)).toBe('draw-stuck');
  });

  it('does not call a draw stuck while it is merely in flight', () => {
    // A premature "stuck" has the owner re-requesting randomness that is on
    // its way, so this errs late on purpose.
    expect(lane({ status: 'Drawing', windowEnds: past(RANDOMNESS_TIMEOUT_MS - 60_000) })).toBe(
      'drawing',
    );
  });

  it('times a stuck draw from the randomness request when it is known', () => {
    // A raffle closed early can start drawing long after its window ended; the
    // request time is when the contract's own timeout starts.
    const longClosed = past(RANDOMNESS_TIMEOUT_MS * 24);
    expect(
      lane({
        status: 'Drawing',
        windowEnds: longClosed,
        requestedAt: past(RANDOMNESS_TIMEOUT_MS - 60_000),
      }),
    ).toBe('drawing');
    expect(
      why({
        status: 'Drawing',
        windowEnds: longClosed,
        requestedAt: past(RANDOMNESS_TIMEOUT_MS + 60_000),
      }),
    ).toBe('draw-stuck');
  });

  it('flags a window that closed before the raffle filled', () => {
    expect(why({ windowEnds: past(1000) })).toBe('window-closed');
  });

  it('flags an unclaimed prize', () => {
    const won = {
      status: 'Completed' as const,
      prizeOwed: parseUsdc('50'),
      prizePaid: false,
      winner: '0x55715594636e32E5da4Cb27236da7c811418a833' as const,
    };
    expect(why(won)).toBe('prize-unclaimed');
  });

  it('flags commission left in the contract', () => {
    expect(why({ status: 'Completed', prizePaid: true, commissionOwed: parseUsdc('5') })).toBe(
      'commission-owed',
    );
  });

  it('reports the prize before the commission when both are outstanding', () => {
    // Somebody else's money first. The owner's can wait.
    expect(
      why({
        status: 'Completed',
        prizeOwed: parseUsdc('50'),
        prizePaid: false,
        commissionOwed: parseUsdc('5'),
      }),
    ).toBe('prize-unclaimed');
  });

  /**
   * Caught by live data, not by this file.
   *
   * This branch used to fall through to `open`, on the reasoning that a
   * Completed raffle always has an attention reason. It does not — testnet
   * raffle #1 is settled in full, and it appeared under "Open" on the owner's
   * board within a minute of the screen existing.
   */
  it('files a fully settled raffle under settled, not open', () => {
    const done = { status: 'Completed' as const, prizePaid: true, commissionOwed: 0n };
    expect(why(done)).toBeUndefined();
    expect(lane(done)).toBe('settled');
  });

  it('flags an unknown status rather than filing it somewhere reassuring', () => {
    // 'None' should never reach a screen, but if it does it should be visible.
    expect(lane({ status: 'None' as RaffleState['status'] })).toBe('needs-a-look');
  });
});

describe('intoLanes', () => {
  it('groups and orders newest first within a lane', () => {
    const grouped = intoLanes(
      [raffle({ id: 1n }), raffle({ id: 3n }), raffle({ id: 2n, prizeCovered: true })],
      NOW,
    );
    expect(grouped.open.map((e) => e.raffle.id)).toEqual([3n, 1n]);
    expect(grouped['prize-covered'].map((e) => e.raffle.id)).toEqual([2n]);
  });

  it('gives every lane an array even when empty', () => {
    // A screen that maps over lanes must not have to guard each one.
    const grouped = intoLanes([], NOW);
    expect(Object.values(grouped).every(Array.isArray)).toBe(true);
    expect(grouped.settled).toEqual([]);
  });

  it('keeps settled draws out of the four action lanes', () => {
    const grouped = intoLanes(
      [raffle({ id: 1n, status: 'Completed', prizePaid: true }), raffle({ id: 2n })],
      NOW,
    );
    expect(grouped.settled.map((e) => e.raffle.id)).toEqual([1n]);
    expect(grouped.open.map((e) => e.raffle.id)).toEqual([2n]);
  });

  it('compares ids past the safe integer range', () => {
    const big = 9007199254740993n;
    const grouped = intoLanes([raffle({ id: big }), raffle({ id: big + 1n })], NOW);
    expect(grouped.open.map((e) => e.raffle.id)).toEqual([big + 1n, big]);
  });
});

describe('commissionOwed', () => {
  it('totals what is owed and names the raffles to withdraw from', () => {
    const { total, raffleIds } = commissionOwed([
      raffle({ id: 1n, commissionOwed: parseUsdc('5') }),
      raffle({ id: 2n, commissionOwed: 0n }),
      raffle({ id: 3n, commissionOwed: parseUsdc('2.5') }),
    ]);
    expect(total).toBe(parseUsdc('7.5'));
    // withdrawCommission takes ids; passing settled ones would waste gas.
    expect(raffleIds).toEqual([1n, 3n]);
  });

  it('is zero with nothing owed', () => {
    expect(commissionOwed([]).total).toBe(0n);
    expect(commissionOwed([raffle()]).raffleIds).toEqual([]);
  });
});
