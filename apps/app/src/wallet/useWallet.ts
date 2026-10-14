/**
 * The Connect screen's state, as one value.
 *
 * Section 12.6 designs that screen around three blocking states — choose a
 * wallet, wrong network, not enough USDC for gas — and they are ordered, not
 * independent: there is no useful gas answer for a wallet on the wrong chain,
 * and no chain answer for a wallet that is not connected. Returning a single
 * discriminated status rather than five booleans means the screen cannot render
 * two of them at once, which is the failure a pile of booleans invites.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  useAccount,
  useBalance,
  useConnect,
  useConnectors,
  useSwitchChain,
  type Connector,
} from 'wagmi';

import { type ArcNetwork, formatUsdcCompact, nativeToUsdc } from '@stubby/shared';

import { targetChain } from './config';
import { checkGas, type GasVerdict } from './gas';
import { TARGET_NETWORK } from './network';
import { walletStatus, type WalletStatus } from './status';
import { bringWalletForRequests } from './usePhoneConnect';

export type { WalletStatus } from './status';

export interface Wallet {
  status: WalletStatus;
  address: `0x${string}` | undefined;
  network: ArcNetwork;
  /** The chain the wallet is on right now, which is not Arc when switching is needed. */
  walletChainId: number | undefined;
  /** Wallets this device can actually offer. On web, whatever EIP-6963 found. */
  connectors: readonly Connector[];
  connect(connector: Connector): void;
  switchToArc(): void;
  /** True while a chain switch is waiting on the wallet. */
  switching: boolean;
  /** Set when a connection attempt failed, e.g. the user dismissed the wallet. */
  error: Error | null;
  /** Native balance in the 18-decimal view, and what it covers. */
  gas: GasVerdict | undefined;
  /** The balance as USDC, ready to render. Undefined until it has been read. */
  balanceText: string | undefined;
}

/** Longest the Connect screen shows "Checking for a connected wallet". */
const RESTORE_CEILING_MS = 5000;

export function useWallet(): Wallet {
  const { address, chainId, isConnected, isConnecting, isReconnecting, connector } = useAccount();

  // A WalletConnect session restored on reload still brings its wallet app
  // forward for each request, as it did when it was first made.
  useEffect(() => {
    if (connector) void bringWalletForRequests(connector);
  }, [connector]);
  const connectors = useConnectors();
  const { connect, isPending: connectPending, error: connectError } = useConnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();

  const onArc = isConnected && chainId === targetChain.id;

  const balance = useBalance({
    address,
    chainId: targetChain.id,
    // Asking for a balance on the wrong chain returns a number for the wrong
    // money, so the gas check must not run until the chain is right.
    query: { enabled: onArc && address !== undefined },
  });

  const gas = useMemo(
    () => (balance.data ? checkGas({ balanceNative: balance.data.value }) : undefined),
    [balance.data],
  );

  /*
   * The page-load reconnect gets five seconds. wagmi waits for every
   * connector to say whether it is still connected, and a slow one would
   * otherwise hold the Connect screen on "Checking for a connected wallet".
   */
  const checking = isConnecting || isReconnecting;
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!checking) {
      setGaveUp(false);
      return;
    }
    const t = setTimeout(() => setGaveUp(true), RESTORE_CEILING_MS);
    return () => clearTimeout(t);
  }, [checking]);

  const status = useMemo(
    () =>
      walletStatus({
        connectPending,
        isConnecting: isConnecting && !gaveUp,
        isReconnecting: isReconnecting && !gaveUp,
        isConnected,
        onArc,
        gas,
      }),
    [connectPending, isConnecting, isReconnecting, gaveUp, isConnected, onArc, gas],
  );

  return {
    status,
    address,
    network: TARGET_NETWORK,
    walletChainId: isConnected ? chainId : undefined,
    connectors,
    connect: (connector: Connector) => connect({ connector }),
    switchToArc: () => switchChain({ chainId: targetChain.id }),
    switching,
    error: connectError ?? switchError ?? null,
    gas,
    balanceText: balance.data
      ? // The native 18-decimal balance converted once, at the edge, for display.
        formatUsdcCompact(nativeToUsdc(balance.data.value), { decimals: 2 })
      : undefined,
  };
}
