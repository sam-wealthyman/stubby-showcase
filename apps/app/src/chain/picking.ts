/**
 * How many tickets this wallet may buy, and what stops it buying more.
 *
 * Section 12.5: quick-pick chips 1 to 5 rather than a stepper, and a chip the
 * wallet cannot use shows **a lock rather than an error**. That is a design
 * rule with a correctness consequence — the screen has to know *why* each chip
 * is unavailable before it is pressed, so every reason the contract can revert
 * with has to be computable in advance.
 *
 * The contract's reverts are the checklist: `NotOpen`, `WalletCapReached`,
 * `NotEnoughEntriesLeft`, and the transfer failing for want of USDC. Each has a
 * lock reason below, so a press never turns into a rejected transaction the
 * user has already paid gas to attempt.
 *
 * Pure. No wallet, no chain, no renderer.
 */

import { MAX_ENTRIES_PER_WALLET, walletCap, type RaffleState } from '@stubby/shared';

import { ENTRY_GAS_BUDGET, FLOOR_FEE_PER_GAS } from '@/wallet/gas';

export type LockReason =
  /** The raffle is not taking entries. */
  | 'closed'
  /** Section 2: five per wallet, and this wallet already holds some. */
  | 'wallet-cap'
  /** Fewer entries remain than this chip would buy. */
  | 'sold-out'
  /** The wallet cannot cover the tickets and the network fee. */
  | 'balance';

export interface Chip {
  count: number;
  /** Total price of this many entries, in USDC base units (6 decimals). */
  cost: bigint;
  available: boolean;
  /** Why not, when `available` is false. */
  lock?: LockReason;
}

export interface PickingInput {
  raffle: RaffleState;
  /** Entries this wallet already holds in this raffle. */
  held: number;
  /**
   * The wallet's USDC, in the **6-decimal ERC-20 view**.
   *
   * On Arc this is the same balance gas is paid from — the native 18-decimal
   * view is the same money in a finer denomination (see `units.ts`). So a
   * wallet that spends everything on tickets has nothing left to pay the fee
   * with, and an affordability check that ignores gas will happily offer a chip
   * whose transaction cannot be sent. That is the whole reason `gasBudget`
   * exists here.
   */
  balance: bigint | undefined;
}

/**
 * Gas to keep back, in the 6-decimal view.
 *
 * `checkGas` works in native units because that is what a balance query
 * returns; here everything is ticket money, so the budget is converted once and
 * rounded **up** — reserving a fraction too much costs a user nothing, and
 * reserving too little costs them a failed transaction.
 */
export const GAS_RESERVE_USDC = ceilToUsdc(ENTRY_GAS_BUDGET * FLOOR_FEE_PER_GAS);

/**
 * The most this wallet could buy right now, ignoring money.
 *
 * Section 2's cap and the entries actually left, whichever binds first.
 */
export function maxBuyable(raffle: RaffleState, held: number): number {
  if (raffle.status !== 'Open') return 0;
  const byCap = Math.max(0, walletCap(raffle.totalEntries) - held);
  const byStock = Math.max(0, raffle.totalEntries - raffle.entriesSold);
  return Math.min(byCap, byStock);
}

/**
 * One chip per ticket a wallet may hold in this draw (five in most, fewer in
 * a small one), each knowing whether it can be pressed and why not.
 */
export function chips({ raffle, held, balance }: PickingInput): Chip[] {
  return Array.from({ length: walletCap(raffle.totalEntries) }, (_, index) => {
    const count = index + 1;
    const cost = BigInt(count) * raffle.entryPrice;
    const lock = lockFor({ raffle, held, balance }, count, cost);
    return lock === undefined
      ? { count, cost, available: true }
      : { count, cost, available: false, lock };
  });
}

/**
 * The reasons, in the order they matter to the person reading them.
 *
 * A closed raffle explains every chip at once, so it comes first. The cap is
 * next because it is about this wallet rather than the raffle, and it is the
 * one a user is most likely to have caused themselves. Money is last: it is the
 * only one they can do something about in the next minute, so it is worth
 * surfacing precisely rather than hiding behind a reason they cannot act on.
 */
function lockFor(
  { raffle, held, balance }: PickingInput,
  count: number,
  cost: bigint,
): LockReason | undefined {
  if (raffle.status !== 'Open') return 'closed';
  if (held + count > walletCap(raffle.totalEntries)) return 'wallet-cap';
  if (count > raffle.totalEntries - raffle.entriesSold) return 'sold-out';
  // Unknown balance is not a reason to lock. A wallet still loading would
  // otherwise show every chip locked for lack of funds it may well have.
  if (balance !== undefined && balance < cost + GAS_RESERVE_USDC) return 'balance';
  return undefined;
}

/** What to say about a locked chip. Section 12.2: safe first, then the fix. */
export function lockMessage(
  reason: LockReason,
  held: number,
  cap: number = MAX_ENTRIES_PER_WALLET,
): string {
  switch (reason) {
    case 'closed':
      return "This draw isn't selling tickets right now.";
    case 'wallet-cap':
      return held >= cap
        ? `You've reached the limit of ${cap} tickets per wallet for this draw.`
        : `You can add ${cap - held} more (limit ${cap}).`;
    case 'sold-out':
      return "This draw doesn't have that many tickets left.";
    case 'balance':
      return "You don't have enough USDC for the tickets plus the network fee.";
  }
}

/**
 * Does the wallet need to approve USDC before entering?
 *
 * The contract pulls payment with `safeTransferFrom`, so the raffle must hold
 * an allowance first. Two transactions, and the screen has to say so up front:
 * a user told "confirm in your wallet" who then gets a second prompt they were
 * not warned about has every reason to think something is wrong.
 */
export function needsApproval(allowance: bigint | undefined, cost: bigint): boolean {
  // Unknown allowance is treated as needing approval. Skipping it wrongly means
  // `enter` reverts; asking for it unnecessarily costs one cheap transaction.
  return allowance === undefined || allowance < cost;
}

function ceilToUsdc(nativeUnits: bigint): bigint {
  const factor = 10n ** 12n;
  return nativeUnits % factor === 0n ? nativeUnits / factor : nativeUnits / factor + 1n;
}
