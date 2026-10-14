import { describe, expect, it } from 'vitest';

import { parseUsdc, type RaffleState } from '@stubby/shared';

import { classify, sortHoldings, totalOwed, type Holding } from '../src/chain/holdings.js';

const WALLET = '0x55715594636e32E5da4Cb27236da7c811418a833' as const;
const SOMEONE_ELSE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

function raffle(overrides: Partial<RaffleState> = {}): RaffleState {
  return {
    id: 1n,
    status: 'Open',
    prize: parseUsdc('50'),
    entryPrice: parseUsdc('1'),
    totalEntries: 70,
    entriesSold: 52,
    collected: parseUsdc('52'),
    prizeCovered: true,
    windowEnds: new Date('2026-10-01T00:00:00Z'),
    winner: null,
    winningEntry: null,
    prizeOwed: 0n,
    commissionOwed: 0n,
    prizePaid: false,
    ...overrides,
  };
}

const kind = (overrides: Partial<RaffleState>, entries = 2) =>
  classify({ raffle: raffle(overrides), entries, wallet: WALLET }).kind;

describe('classify', () => {
  it('calls an open draw live', () => {
    expect(kind({ status: 'Open' })).toBe('live');
  });

  it('calls a full or drawing raffle awaiting its draw', () => {
    expect(kind({ status: 'ReadyToDraw' })).toBe('awaiting-draw');
    expect(kind({ status: 'Drawing' })).toBe('awaiting-draw');
  });

  it('separates a win still owed from one already paid', () => {
    const base = { status: 'Completed', winner: WALLET, prizeOwed: parseUsdc('50') } as const;
    expect(kind({ ...base, prizePaid: false })).toBe('won-unclaimed');
    expect(kind({ ...base, prizePaid: true })).toBe('won-claimed');
  });

  it('does not call someone else"s win a win', () => {
    expect(kind({ status: 'Completed', winner: SOMEONE_ELSE, prizeOwed: parseUsdc('50') })).toBe(
      'not-this-time',
    );
  });

  /**
   * Checksum casing is presentation, not identity.
   *
   * A wallet connected through one path can present the same address cased
   * differently from another, and a case-sensitive comparison would tell a
   * winner they had lost.
   */
  it('recognises the winner whatever the address casing', () => {
    const shouted = classify({
      raffle: raffle({
        status: 'Completed',
        winner: WALLET.toUpperCase() as `0x${string}`,
        prizeOwed: parseUsdc('50'),
      }),
      entries: 2,
      wallet: WALLET.toLowerCase() as `0x${string}`,
    });
    expect(shouted.kind).toBe('won-unclaimed');
    expect(shouted.owed).toBe(parseUsdc('50'));
  });

  it('owes nothing on a draw that is not complete', () => {
    expect(classify({ raffle: raffle(), entries: 2, wallet: WALLET }).owed).toBe(0n);
  });

  it('owes nothing once the prize is paid', () => {
    const paid = classify({
      raffle: raffle({
        status: 'Completed',
        winner: WALLET,
        prizeOwed: parseUsdc('50'),
        prizePaid: true,
      }),
      entries: 2,
      wallet: WALLET,
    });
    expect(paid.owed).toBe(0n);
  });

  /**
   * Section 6.1: a failed transfer leaves the prize owed and retryable.
   *
   * `prizeOwed` stays set until the payout actually succeeds, which is what
   * makes "Claim recovery" possible at all. Treating a completed draw as
   * settled would hide a prize the contract is still holding.
   */
  it('still owes a winner whose payout failed', () => {
    const stuck = classify({
      raffle: raffle({
        status: 'Completed',
        winner: WALLET,
        prizeOwed: parseUsdc('50'),
        prizePaid: false,
      }),
      entries: 1,
      wallet: WALLET,
    });
    expect(stuck.kind).toBe('won-unclaimed');
    expect(stuck.owed).toBe(parseUsdc('50'));
  });

  it('reports the odds this wallet had', () => {
    expect(classify({ raffle: raffle(), entries: 5, wallet: WALLET }).oddsBps).toBe(714);
  });
});

describe('sortHoldings', () => {
  const holding = (id: number, kind: Holding['kind']): Holding => ({
    raffle: raffle({ id: BigInt(id) }),
    entries: 1,
    kind,
    oddsBps: 0,
    owed: 0n,
  });

  it('puts an unclaimed prize first however old it is', () => {
    // The only item on this screen that asks anything of the user.
    const sorted = sortHoldings([
      holding(9, 'live'),
      holding(1, 'won-unclaimed'),
      holding(8, 'awaiting-draw'),
    ]);
    expect(sorted.map((h) => h.raffle.id)).toEqual([1n, 9n, 8n]);
  });

  it('orders the rest newest first', () => {
    const sorted = sortHoldings([holding(1, 'live'), holding(3, 'live'), holding(2, 'live')]);
    expect(sorted.map((h) => h.raffle.id)).toEqual([3n, 2n, 1n]);
  });

  it('compares ids past the safe integer range', () => {
    // Raffle ids are uint256. Subtracting bigints for a comparator would throw,
    // and converting them to Number would make these two compare equal.
    const big = 9007199254740993n;
    const sorted = sortHoldings([
      { ...holding(1, 'live'), raffle: raffle({ id: big }) },
      { ...holding(1, 'live'), raffle: raffle({ id: big + 1n }) },
    ]);
    expect(sorted.map((h) => h.raffle.id)).toEqual([big + 1n, big]);
  });

  it('does not mutate what it was given', () => {
    const input = [holding(1, 'live'), holding(2, 'won-unclaimed')];
    sortHoldings(input);
    expect(input.map((h) => h.raffle.id)).toEqual([1n, 2n]);
  });
});

describe('totalOwed', () => {
  it('adds up every unclaimed prize', () => {
    const owed = (amount: string): Holding => ({
      raffle: raffle(),
      entries: 1,
      kind: 'won-unclaimed',
      oddsBps: 0,
      owed: parseUsdc(amount),
    });
    expect(totalOwed([owed('50'), owed('250')])).toBe(parseUsdc('300'));
  });

  it('is zero with nothing owed', () => {
    expect(totalOwed([])).toBe(0n);
  });
});
