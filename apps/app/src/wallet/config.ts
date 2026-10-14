/**
 * The wagmi configuration.
 *
 * One config for the whole app, built once at module load. wagmi keys its cache
 * by config identity, so building a second one — which is what happens if this
 * is created inside a component — silently gives two disconnected views of the
 * same wallet.
 */

import { Platform } from 'react-native';
import { createConfig, http } from 'wagmi';

import { toViemChain } from '@stubby/shared';

import { walletConnectors } from './connectors';
import { wagmiStorage } from './storage';
import { TARGET_NETWORK, TARGET_RPC_URL } from './network';

/** Arc, as viem and wagmi describe a chain. */
export const targetChain = toViemChain(TARGET_NETWORK);

export const wagmiConfig = createConfig({
  // One chain, deliberately. Section 5 is Arc-only at launch, and listing
  // chains the app cannot serve would let a wallet settle on one of them and
  // look connected while every read returns nothing.
  chains: [targetChain],
  connectors: walletConnectors(),
  transports: { [targetChain.id]: http(TARGET_RPC_URL) },
  // EIP-6963. Every installed wallet announces itself, so the picker lists what
  // is actually there instead of a hardcoded lineup. Web only: it listens with
  // window.addEventListener, which React Native's window does not have, and
  // on Android it crashed the app on launch (build 43). Phones connect
  // through WalletConnect instead.
  multiInjectedProviderDiscovery: Platform.OS === 'web',
  // Balances, allowances and holdings read together go out as one Multicall3
  // call, for the same rate-limit reason as the shared client.
  batch: { multicall: true },
  ...(wagmiStorage ? { storage: wagmiStorage } : {}),
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
