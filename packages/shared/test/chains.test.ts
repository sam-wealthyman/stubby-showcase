import { describe, expect, it } from 'vitest';

import {
  ARC_MAINNET,
  ARC_NETWORKS,
  ARC_TESTNET,
  MIN_BASE_FEE_GWEI,
  USDC_ADDRESS,
  addressUrl,
  arcNetworkByChainId,
  isLocalChain,
  txUrl,
} from '../src/chains.js';

describe('Arc networks', () => {
  it('pins the chain ids', () => {
    expect(ARC_MAINNET.chainId).toBe(5042);
    expect(ARC_TESTNET.chainId).toBe(5042002);
  });

  it('puts USDC at the same address on both networks', () => {
    expect(ARC_MAINNET.usdc).toBe(USDC_ADDRESS);
    expect(ARC_TESTNET.usdc).toBe(USDC_ADDRESS);
    expect(USDC_ADDRESS).toBe('0x3600000000000000000000000000000000000000');
  });

  it('uses a different VRF coordinator per network', () => {
    expect(ARC_MAINNET.vrfCoordinator).not.toBe(ARC_TESTNET.vrfCoordinator);
    for (const network of ARC_NETWORKS) {
      expect(network.vrfCoordinator).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(network.vrfManifestUrl).toContain('d20dao.org');
    }
  });

  it('carries the mempool floor, which is not optional to respect', () => {
    // Arc drops a transaction below this silently, with no error to catch.
    expect(MIN_BASE_FEE_GWEI).toBe(20);
    for (const network of ARC_NETWORKS) {
      expect(network.minBaseFeeGwei).toBe(MIN_BASE_FEE_GWEI);
    }
  });

  it('only gives the testnet a faucet', () => {
    expect(ARC_TESTNET.faucetUrl).toBe('https://faucet.circle.com');
    expect(ARC_MAINNET.faucetUrl).toBeUndefined();
    expect(ARC_TESTNET.isTestnet).toBe(true);
    expect(ARC_MAINNET.isTestnet).toBe(false);
  });

  it('uses https everywhere', () => {
    for (const network of ARC_NETWORKS) {
      expect(network.rpcUrl.startsWith('https://')).toBe(true);
      expect(network.explorerUrl.startsWith('https://')).toBe(true);
    }
  });
});

describe('lookup and links', () => {
  it('finds a network by chain id', () => {
    expect(arcNetworkByChainId(5042)).toBe(ARC_MAINNET);
    expect(arcNetworkByChainId(5042002)).toBe(ARC_TESTNET);
    expect(arcNetworkByChainId(1)).toBeUndefined();
    expect(arcNetworkByChainId(31337)).toBeUndefined();
  });

  it('recognises local chains, which are not Arc networks', () => {
    expect(isLocalChain(31337)).toBe(true);
    expect(isLocalChain(1337)).toBe(true);
    expect(isLocalChain(5042)).toBe(false);
  });

  it('builds explorer links', () => {
    expect(txUrl(ARC_TESTNET, '0xabc')).toBe('https://explorer.testnet.arc.io/tx/0xabc');
    expect(addressUrl(ARC_MAINNET, '0xdef')).toBe('https://explorer.arc.io/address/0xdef');
  });
});
