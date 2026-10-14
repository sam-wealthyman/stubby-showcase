/**
 * What a wallet's tickets mean.
 *
 * "My tickets" is a list of positions, and the states are not obvious from any
 * single field. A raffle can be complete and the wallet still holds entries; a
 * wallet can have won and not been paid; a prize can be owed after a transfer
 * failed (Section 6.1) and be retryable forever. Each of those reads
 * differently to the person looking at the screen, and only one of them is
 * urgent.
 *
 * Section 4.2: the chain is the source of truth, so every state below is read
 * off the raffle rather than remembered by the app. A prize the app believed in
 * and the contract did not would be the worst possible bug on this screen.
 *
 * Pure. No wallet, no chain, no renderer.
 */

import { oddsBps, type RaffleState } from '@stubby/shared';

export type HoldingKind =
  /** The draw is still selling. */
  | 'live'
  /** Full or drawing: entries are locked and the result is coming. */
  | 'awaiting-draw'
  /** Won, and the prize is still sitting in the contract. */
  | 'won-unclaimed'
  /** Won and paid out. */
  | 'won-claimed'
  /** Drawn, and this wallet did not win. */
  | 'not-this-time';

export interface Holding {
  raffle: RaffleState;
  /** Entries this wallet holds. Always at least 1, or there is no holding. */
  entries: number;
  kind: HoldingKind;
  /** Odds this wallet had, in basis points. */
  oddsBps: number;
  /** What is owed, for the states where anything is. */
  owed: bigint;
}

export interface HoldingInput {
  raffle: RaffleState;
  entries: number;
  /** The wallet being looked at, lower-cased by the caller or not — both work. */
  wallet: `0x${string}`;
}

export function classify({ raffle, entries, wallet }: HoldingInput): Holding {
  return {
    raffle,
    entries,
    kind: kindOf(raffle, wallet),
    oddsBps: oddsBps(entries, raffle.totalEntries),
    // Only ever the prize this wallet is actually owed. `prizeOwed` is the
    // contract's own figure and stays set until the transfer succeeds, which is
    // what makes a failed payout retryable rather than lost (Section 6.1).
    owed: won(raffle, wallet) && !raffle.prizePaid ? raffle.prizeOwed : 0n,
  };
}

function won(raffle: RaffleState, wallet: string): boolean {
  // Addresses are compared case-insensitively: checksum casing is presentation,
  // not identity, and a wallet connected through one path can present the same
  // address cased differently from another.
  return raffle.winner !== null && raffle.winner.toLowerCase() === wallet.toLowerCase();
}

function kindOf(raffle: RaffleState, wallet: string): HoldingKind {
  switch (raffle.status) {
    case 'Open':
      return 'live';
    case 'ReadyToDraw':
    case 'Drawing':
      return 'awaiting-draw';
    case 'Completed':
      if (!won(raffle, wallet)) return 'not-this-time';
      return raffle.prizePaid ? 'won-claimed' : 'won-unclaimed';
    default:
      return 'live';
  }
}

/**
 * Sort so the thing that needs doing is first.
 *
 * An unclaimed prize is the only item on this screen that asks anything of the
 * user, so it leads however old it is. Everything else is newest first, which
 * is the order people expect from a history.
 */
const ORDER: Record<HoldingKind, number> = {
  'won-unclaimed': 0,
  live: 1,
  'awaiting-draw': 2,
  'won-claimed': 3,
  'not-this-time': 4,
};

export function sortHoldings(holdings: readonly Holding[]): Holding[] {
  return [...holdings].sort((a, b) => {
    const byKind = ORDER[a.kind] - ORDER[b.kind];
    if (byKind !== 0) return byKind;
    // Newest first within a group. Raffle ids increase, and comparing bigints
    // with subtraction would overflow a Number for large ids.
    return a.raffle.id > b.raffle.id ? -1 : a.raffle.id < b.raffle.id ? 1 : 0;
  });
}

/** Total still owed to this wallet across every draw. */
export function totalOwed(holdings: readonly Holding[]): bigint {
  return holdings.reduce((sum, holding) => sum + holding.owed, 0n);
}
