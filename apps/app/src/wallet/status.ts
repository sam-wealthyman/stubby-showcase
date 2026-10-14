/**
 * Which of the Connect screen's states to show.
 *
 * Pulled out of `useWallet` so it can be tested without a wallet, a chain or a
 * renderer — and it needed testing, because the inputs do not mean what their
 * names suggest (see `isConnecting` below).
 *
 * Section 12.6 gives the screen three blocking states and they are a sequence,
 * not a menu: there is no useful gas answer for a wallet on the wrong chain,
 * and no chain answer for a wallet that is not connected. Returning one value
 * rather than a set of booleans is what stops the screen rendering two at once.
 */

import type { GasVerdict } from './gas';

export type WalletStatus =
  /**
   * Working out whether a previous session can be resumed.
   *
   * The state of every first page load, including a static render where there
   * is no browser at all. Distinct from `connecting`, and the distinction is
   * not pedantic: folding them together tells a user who has done nothing to
   * go and approve something in a wallet they have not opened.
   */
  | 'restoring'
  /** Nothing connected. The screen offers the wallets it can see. */
  | 'disconnected'
  /** The user picked a wallet and it is now asking them to approve. */
  | 'connecting'
  /** Connected, but to some other chain. The screen offers to switch. */
  | 'wrong-network'
  /** On Arc, but the balance will not cover gas. */
  | 'low-gas'
  /** Connected, on Arc, funded. */
  | 'ready';

export interface StatusInput {
  /** `useConnect().isPending` — the user picked a wallet. */
  connectPending: boolean;
  /** `useAccount().isConnecting`. Not what it sounds like; see below. */
  isConnecting: boolean;
  /** `useAccount().isReconnecting`. Also not what it sounds like. */
  isReconnecting: boolean;
  isConnected: boolean;
  /** Connected, and to the chain this build targets. */
  onArc: boolean;
  /** Undefined until the balance has been read. */
  gas: GasVerdict | undefined;
}

export function walletStatus({
  connectPending,
  isConnecting,
  isReconnecting,
  isConnected,
  onArc,
  gas,
}: StatusInput): WalletStatus {
  /*
   * `connectPending` is the only signal that means the user picked a wallet.
   *
   * Neither account flag can carry that, and the reason is the opposite of what
   * the names suggest. wagmi's reconnect sets
   * `status: x.current ? 'reconnecting' : 'connecting'` (@wagmi/core
   * reconnect.js), so `isReconnecting` is true only when there was already a
   * connection to restore, and a first-time visitor — who has done nothing —
   * arrives reporting `isConnecting`. Trusting that flag put "Approve the
   * connection in your wallet" on the static render of a page nobody had
   * touched, which is how this was found.
   */
  if (connectPending) return 'connecting';
  if (isConnecting || isReconnecting) return 'restoring';
  if (!isConnected) return 'disconnected';
  if (!onArc) return 'wrong-network';
  // Until the balance has been read there is nothing to block on. Treating an
  // unread balance as "low" would flash the top-up screen at every user with a
  // perfectly funded wallet.
  if (gas !== undefined && !gas.sufficient) return 'low-gas';
  return 'ready';
}
