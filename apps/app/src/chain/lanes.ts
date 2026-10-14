/**
 * Sorting raffles into the admin control room's lanes (Section 12.6).
 *
 * Three of the four lanes are just the chain's status. The fourth — **Needs a
 * look** — is the one that earns the screen, because it is the set of raffles
 * that are not wrong yet but will be if nobody acts. A dashboard that only
 * mirrored `status` would show four healthy columns while a raffle sat waiting
 * for a draw nobody knew to start.
 *
 * Pure. No chain, no wallet, no renderer.
 */

import {
  RANDOMNESS_TIMEOUT_MS,
  attentionFor,
  type Attention,
  type RaffleState,
} from '@stubby/shared';

export { RANDOMNESS_TIMEOUT_MS, attentionMessage, type Attention } from '@stubby/shared';

export type Lane = 'open' | 'prize-covered' | 'drawing' | 'needs-a-look' | 'settled';

export interface LaneEntry {
  raffle: RaffleState;
  lane: Lane;
  /** Set only for the `needs-a-look` lane. */
  attention?: Attention;
}

export interface LaneInput {
  raffle: RaffleState;
  now?: Date;
  /**
   * How long a raffle may sit in Drawing before it counts as stuck.
   *
   * The contract's own randomness timeout, so the dashboard and the chain agree
   * about when a re-request becomes possible rather than the screen inventing
   * its own patience.
   */
  randomnessTimeoutMs?: number;
}

/**
 * Which lane a raffle belongs in.
 *
 * `needs-a-look` wins over the status lanes wherever both apply: a raffle that
 * is technically "Drawing" but has been for an hour is not a healthy Drawing,
 * and showing it as one is how it stays there.
 */
export function laneFor({
  raffle,
  now = new Date(),
  randomnessTimeoutMs = RANDOMNESS_TIMEOUT_MS,
}: LaneInput): LaneEntry {
  const attention = attentionFor(raffle, now, randomnessTimeoutMs);
  if (attention !== undefined) return { raffle, lane: 'needs-a-look', attention };

  switch (raffle.status) {
    case 'Drawing':
      return { raffle, lane: 'drawing' };
    case 'Open':
      return { raffle, lane: raffle.prizeCovered ? 'prize-covered' : 'open' };
    case 'Completed':
      /*
       * Finished, claimed, and the commission taken. Nothing to do.
       *
       * This branch used to fall through to `open`, on the reasoning that a
       * Completed raffle always has an attention reason — which is wrong, and
       * live data said so within a minute: testnet raffle #1 is settled in
       * full and appeared under "Open" on the owner's board.
       */
      return { raffle, lane: 'settled' };
    default:
      // ReadyToDraw always has an attention reason above, so reaching here
      // means a status this build does not know about. Flag it rather than
      // filing it somewhere reassuring.
      return { raffle, lane: 'needs-a-look' };
  }
}

/**
 * The lanes Section 12.6 puts on the board, in order.
 *
 * `settled` is deliberately absent: it is history rather than a status the
 * owner acts on, and a fifth column of finished draws would push the one that
 * needs attention further from the top every week.
 */
export const LANES: readonly { id: Lane; label: string }[] = [
  { id: 'needs-a-look', label: 'Needs attention' },
  { id: 'open', label: 'Open' },
  { id: 'prize-covered', label: 'Prize covered' },
  { id: 'drawing', label: 'Drawing' },
];

/** Group raffles into lanes, keeping "needs a look" first. */
export function intoLanes(
  raffles: readonly RaffleState[],
  now: Date = new Date(),
): Record<Lane, LaneEntry[]> {
  const grouped: Record<Lane, LaneEntry[]> = {
    'needs-a-look': [],
    open: [],
    'prize-covered': [],
    drawing: [],
    settled: [],
  };
  for (const raffle of raffles) {
    const entry = laneFor({ raffle, now });
    grouped[entry.lane].push(entry);
  }
  // Newest first within a lane. Bigint ids cannot be subtracted for a
  // comparator without overflowing a Number at scale.
  for (const lane of Object.values(grouped)) {
    lane.sort((a, b) => (a.raffle.id > b.raffle.id ? -1 : a.raffle.id < b.raffle.id ? 1 : 0));
  }
  return grouped;
}

/** Everything the owner is owed across every settled raffle. */
export function commissionOwed(raffles: readonly RaffleState[]): {
  total: bigint;
  raffleIds: bigint[];
} {
  const raffleIds = raffles.filter((r) => r.commissionOwed > 0n).map((r) => r.id);
  const total = raffles.reduce((sum, r) => sum + r.commissionOwed, 0n);
  return { total, raffleIds };
}
