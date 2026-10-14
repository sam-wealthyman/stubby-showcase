import { describe, expect, it } from 'vitest';

import { ARC_MAINNET, ARC_TESTNET } from '@stubby/shared';

import { selectNetwork } from '../src/wallet/network.js';

describe('selectNetwork', () => {
  it('defaults to testnet when nothing is configured', () => {
    // The safe mistake is pointing at play money.
    expect(selectNetwork(undefined)).toBe(ARC_TESTNET);
    expect(selectNetwork('')).toBe(ARC_TESTNET);
  });

  it('selects the network the id names', () => {
    expect(selectNetwork(String(ARC_TESTNET.chainId))).toBe(ARC_TESTNET);
    expect(selectNetwork(String(ARC_MAINNET.chainId))).toBe(ARC_MAINNET);
  });

  it('refuses a chain that is not Arc rather than falling back', () => {
    // A typo that silently selected testnet would look like a working app right
    // up to the point someone expected real USDC to move.
    expect(() => selectNetwork('1')).toThrow(/not an Arc network/);
  });

  it('refuses something that is not a chain id at all', () => {
    expect(() => selectNetwork('mainnet')).toThrow(/not a chain id/);
  });
});
