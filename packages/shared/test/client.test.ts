import { describe, expect, it } from 'vitest';

import { ARC_MAINNET, ARC_TESTNET } from '../src/chains.js';
import { RAFFLE_STATUS, arcTestnet, toViemChain } from '../src/client.js';
import { stubbyRaffleAbi } from '../src/abi/stubbyRaffle.js';

describe('status decoding', () => {
  /**
   * The contract's enum is None, Open, ReadyToDraw, Drawing, Completed,
   * Cancelled. The order is the wire format: a mismatch here silently
   * mislabels every raffle, and would have done exactly that when filling and
   * drawing were separated and ReadyToDraw was inserted at index 2.
   */
  it('matches the contract enum, in order', () => {
    expect(RAFFLE_STATUS).toEqual([
      'None',
      'Open',
      'ReadyToDraw',
      'Drawing',
      'Completed',
      'Cancelled',
    ]);
    expect(RAFFLE_STATUS[2]).toBe('ReadyToDraw');
    expect(RAFFLE_STATUS[4]).toBe('Completed');
    expect(RAFFLE_STATUS[5]).toBe('Cancelled');
  });
});

describe('the generated ABI', () => {
  it('carries the functions the client calls', () => {
    const names = new Set(
      stubbyRaffleAbi.filter((entry) => entry.type === 'function').map((entry) => entry.name),
    );
    for (const fn of [
      'getRaffle',
      'collected',
      'isPrizeCovered',
      'entriesOf',
      'nextRaffleId',
      'requiredHoldings',
    ]) {
      expect(names, fn).toContain(fn);
    }
  });

  it('carries the two-step draw, so a stale ABI is caught here', () => {
    const names = new Set(
      stubbyRaffleAbi.filter((entry) => entry.type === 'function').map((entry) => entry.name),
    );
    expect(names).toContain('startDraw');
    expect(names).toContain('closeEarly');
    // The old coupled name must be gone: if this fails, the ABI was not
    // regenerated after the contract changed.
    expect(names).not.toContain('closeAndDraw');
  });

  it('carries claimTo, the Section 6.1 escape hatch', () => {
    const names = new Set(
      stubbyRaffleAbi.filter((entry) => entry.type === 'function').map((entry) => entry.name),
    );
    expect(names).toContain('claim');
    expect(names).toContain('claimTo');
  });
});

describe('the viem chain description', () => {
  it('describes Arc testnet from the pinned config', () => {
    expect(arcTestnet.id).toBe(ARC_TESTNET.chainId);
    expect(arcTestnet.testnet).toBe(true);
    expect(arcTestnet.rpcUrls.default.http[0]).toBe(ARC_TESTNET.rpcUrl);
  });

  it('marks mainnet as not a testnet', () => {
    expect(toViemChain(ARC_MAINNET).testnet).toBe(false);
  });

  /**
   * viem's nativeCurrency is the gas denomination, which on Arc is 18 decimals.
   * Token amounts everywhere else in this project are the 6-decimal ERC-20
   * view. Both are correct in their place; confusing them is a 10^12 error.
   */
  it('uses 18 decimals for the gas view, not the 6 used for token amounts', () => {
    expect(arcTestnet.nativeCurrency.decimals).toBe(18);
    expect(arcTestnet.nativeCurrency.symbol).toBe('USDC');
  });
});
