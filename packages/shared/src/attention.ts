/**
 * Which raffles need the owner, and why (Section 12.6's "Needs a look").
 *
 * Shared because two places ask the same question: the admin control room,
 * which shows it, and the API's watcher, which emails it. Two copies of these
 * rules would disagree about when a draw is stuck, and the owner would be told
 * one thing by the screen and another by their inbox.
 *
 * Pure. No chain, no wallet, no renderer.
 */

import type { RaffleState } from './client.js';

/** Why a raffle is in "Needs a look", in the owner's words. */
export type Attention =
  /** Full, and nobody has called `startDraw`. Anyone can, but somebody must. */
  | 'waiting-to-draw'
  /** Randomness was requested and has not come back. Section 6.1: re-requestable. */
  | 'draw-stuck'
  /** The selling window has closed with the raffle unfilled. */
  | 'window-closed'
  /** Drawn, and the winner has not taken their prize. No deadline, just unfinished. */
  | 'prize-unclaimed'
  /** Settled, and the owner's commission is still in the contract. */
  | 'commission-owed';

/** Default matching the contract's deployed randomness timeout. */
export const RANDOMNESS_TIMEOUT_MS = 60 * 60 * 1000;

export function attentionFor(
  raffle: RaffleState,
  now: Date,
  timeoutMs: number,
): Attention | undefined {
  if (raffle.status === 'ReadyToDraw') return 'waiting-to-draw';

  if (raffle.status === 'Drawing') {
    // Stuck means past the contract's own timeout since the request, which is
    // exactly when `reRequestRandomness` starts to be allowed. A raffle read
    // without its request time falls back to the window, which errs late: a
    // premature "stuck" would have the owner re-requesting randomness that is
    // merely in flight.
    const from = raffle.requestedAt ?? raffle.windowEnds;
    const since = now.getTime() - from.getTime();
    return since > timeoutMs ? 'draw-stuck' : undefined;
  }

  if (raffle.status === 'Completed') {
    if (!raffle.prizePaid && raffle.prizeOwed > 0n) return 'prize-unclaimed';
    if (raffle.commissionOwed > 0n) return 'commission-owed';
    return undefined;
  }

  if (raffle.status === 'Open' && raffle.windowEnds.getTime() <= now.getTime()) {
    return 'window-closed';
  }

  return undefined;
}

/** What to tell the owner, and what they can do about it. */
export function attentionMessage(attention: Attention): { title: string; action: string } {
  switch (attention) {
    case 'waiting-to-draw':
      return {
        title: 'Full, and no draw has started',
        action: 'Anyone can call startDraw, including you. Until somebody does, nothing happens.',
      };
    case 'draw-stuck':
      return {
        title: 'Randomness has not come back',
        action: 'Past the timeout, so the request can be made again. Entries and prizes are safe.',
      };
    case 'window-closed':
      return {
        title: 'The window closed before it filled',
        action: 'Extend the window, or close early if the pot already covers the prize.',
      };
    case 'prize-unclaimed':
      return {
        title: 'The winner has not claimed',
        action: 'There is no deadline. Nothing needs doing. It is here so it is not forgotten.',
      };
    case 'commission-owed':
      return {
        title: 'Commission is still in the contract',
        action: 'Withdraw it whenever suits. It is not at risk where it is.',
      };
  }
}
