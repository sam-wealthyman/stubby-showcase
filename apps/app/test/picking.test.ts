import { describe, expect, it } from 'vitest';

import { parseUsdc, NATIVE_PER_USDC_UNIT, type RaffleState } from '@stubby/shared';

import {
  GAS_RESERVE_USDC,
  chips,
  lockMessage,
  maxBuyable,
  needsApproval,
} from '../src/chain/picking.js';
import { ENTRY_GAS_BUDGET, FLOOR_FEE_PER_GAS } from '../src/wallet/gas.js';

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

const locks = (input: Parameters<typeof chips>[0]) => chips(input).map((chip) => chip.lock ?? null);

describe('maxBuyable', () => {
  it('stops at the five-per-wallet cap', () => {
    expect(maxBuyable(raffle(), 0)).toBe(5);
    expect(maxBuyable(raffle(), 3)).toBe(2);
    expect(maxBuyable(raffle(), 5)).toBe(0);
  });

  it('stops at the entries actually left', () => {
    expect(maxBuyable(raffle({ entriesSold: 68, totalEntries: 70 }), 0)).toBe(2);
  });

  it('holds a wallet to a quarter of a small draw', () => {
    // 10 tickets: 2 per wallet, so nobody holds more than 25% of the odds.
    expect(maxBuyable(raffle({ totalEntries: 10, entriesSold: 0 }), 0)).toBe(2);
    expect(
      chips({ raffle: raffle({ totalEntries: 10, entriesSold: 0 }), held: 0, balance: undefined }),
    ).toHaveLength(2);
    expect(lockMessage('wallet-cap', 2, 2)).toMatch(/2 tickets per wallet/i);
  });

  it('is zero for a raffle that is not open', () => {
    for (const status of ['ReadyToDraw', 'Drawing', 'Completed'] as const) {
      expect(maxBuyable(raffle({ status }), 0), status).toBe(0);
    }
  });

  it('never goes negative if a wallet somehow holds more than the cap', () => {
    expect(maxBuyable(raffle(), 9)).toBe(0);
  });
});

describe('chips', () => {
  const rich = parseUsdc('1000');

  it('offers all five to a wallet holding none', () => {
    expect(locks({ raffle: raffle(), held: 0, balance: rich })).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('locks the chips past the wallet cap rather than erroring', () => {
    // Section 12.5: a chip over the cap shows a lock, not an error.
    expect(locks({ raffle: raffle(), held: 3, balance: rich })).toEqual([
      null,
      null,
      'wallet-cap',
      'wallet-cap',
      'wallet-cap',
    ]);
  });

  it('locks chips the raffle cannot supply', () => {
    expect(locks({ raffle: raffle({ entriesSold: 68 }), held: 0, balance: rich })).toEqual([
      null,
      null,
      'sold-out',
      'sold-out',
      'sold-out',
    ]);
  });

  it('locks everything when the raffle is not open', () => {
    expect(locks({ raffle: raffle({ status: 'Completed' }), held: 0, balance: rich })).toEqual([
      'closed',
      'closed',
      'closed',
      'closed',
      'closed',
    ]);
  });

  it('prices each chip at count times the entry price', () => {
    expect(chips({ raffle: raffle(), held: 0, balance: rich }).map((c) => c.cost)).toEqual([
      parseUsdc('1'),
      parseUsdc('2'),
      parseUsdc('3'),
      parseUsdc('4'),
      parseUsdc('5'),
    ]);
  });

  /**
   * The Arc-specific trap.
   *
   * Tickets and gas come out of the SAME balance — the native 18-decimal view
   * is the same money as the 6-decimal ERC-20 view, in a finer denomination.
   * So a wallet holding exactly the ticket price cannot actually buy: there is
   * nothing left to pay the fee with, and the transaction fails after the user
   * has been told they could afford it.
   */
  it('reserves gas out of the same balance the tickets come from', () => {
    const exactlyOneTicket = parseUsdc('1');
    expect(locks({ raffle: raffle(), held: 0, balance: exactlyOneTicket })[0]).toBe('balance');

    const oneTicketPlusFee = exactlyOneTicket + GAS_RESERVE_USDC;
    expect(locks({ raffle: raffle(), held: 0, balance: oneTicketPlusFee })[0]).toBeNull();
  });

  it('reserves the gas budget rounded up, never down', () => {
    // Reserving a fraction too much costs nothing; too little costs a failed
    // transaction the user has already approved.
    const exact = (ENTRY_GAS_BUDGET * FLOOR_FEE_PER_GAS) / NATIVE_PER_USDC_UNIT;
    expect(GAS_RESERVE_USDC).toBeGreaterThanOrEqual(exact);
  });

  it('does not lock chips while the balance is still unknown', () => {
    // A wallet still loading would otherwise show every chip locked for want of
    // funds it may well have.
    expect(locks({ raffle: raffle(), held: 0, balance: undefined })).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('reports the cap before the balance when both bind', () => {
    // The cap is about this wallet and is the one a user most likely caused;
    // money is the one they can act on, so it must not be hidden behind a
    // reason they cannot.
    expect(locks({ raffle: raffle(), held: 5, balance: 0n })).toEqual([
      'wallet-cap',
      'wallet-cap',
      'wallet-cap',
      'wallet-cap',
      'wallet-cap',
    ]);
  });
});

describe('lockMessage', () => {
  it('tells a capped wallet how many more it can take', () => {
    expect(lockMessage('wallet-cap', 3)).toMatch(/add 2 more/i);
  });

  it('does not offer more to a wallet that is already full', () => {
    const text = lockMessage('wallet-cap', 5);
    expect(text).toMatch(/reached the limit/i);
    expect(text).not.toMatch(/add \d+ more/i);
  });

  it('names the network fee when the reason is money, since it comes from the same balance', () => {
    expect(lockMessage('balance', 0)).toMatch(/usdc.*network fee/i);
  });
});

describe('needsApproval', () => {
  it('needs approval when the allowance is short', () => {
    expect(needsApproval(parseUsdc('1'), parseUsdc('2'))).toBe(true);
  });

  it('does not when the allowance covers it', () => {
    expect(needsApproval(parseUsdc('5'), parseUsdc('2'))).toBe(false);
    expect(needsApproval(parseUsdc('2'), parseUsdc('2'))).toBe(false);
  });

  it('assumes approval is needed while the allowance is unknown', () => {
    // Skipping it wrongly makes `enter` revert; asking unnecessarily costs one
    // cheap transaction.
    expect(needsApproval(undefined, parseUsdc('2'))).toBe(true);
  });
});
