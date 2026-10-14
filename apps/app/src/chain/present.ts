/**
 * Turning a raffle on the chain into the things a screen shows.
 *
 * Every value here is derived, never stored: the chain is the source of truth
 * (Section 4.2), so a countdown, a fill bar and a status pill are three views of
 * state that already exists rather than three fields to keep in step with it.
 *
 * Pure, and separate from the hooks that fetch, so all of it is testable without
 * a network, a chain or a renderer. That matters more here than it looks: these
 * are the numbers a participant reads before spending money, and most of them
 * are wrong in ways that still render — a fill bar past 100%, a countdown
 * counting up, a marker for a prize that is already covered.
 */

import { entriesToCoverPrize, maxWalletOddsBps, roiBps, type RaffleState } from '@stubby/shared';

/** Section 12.5: the one pill a raffle shows, and only one. */
export type StatusPill =
  /** Still selling, prize not yet covered. */
  | { kind: 'filling' }
  /** Section 11.5: the pot has reached the prize. */
  | { kind: 'prize-covered' }
  /** The window was extended. Section 11.5: no refunds. */
  | { kind: 'window-2' }
  /** Full, waiting for anyone to call startDraw. */
  | { kind: 'ready-to-draw' }
  | { kind: 'drawing' }
  | { kind: 'complete' };

export interface RafflePresentation {
  pill: StatusPill;
  /** 0 to 1. Clamped, because a bar past its end reads as a bug, not as good news. */
  fill: number;
  /**
   * The entry at which the pot covers the prize (Section 11.5), as a fraction
   * of the way along the bar — or null once it is covered, because a marker for
   * something already true is noise.
   */
  coverMarker: number | null;
  /** Return on the entry price, in basis points. */
  roiBps: number;
  /** A single wallet's best possible odds, in basis points. */
  bestOddsBps: number;
  entriesLeft: number;
  /**
   * The countdown, or null when there is nothing left to count down to.
   *
   * Derived here rather than at the call site, so the countdown cannot
   * contradict the pill. A completed raffle can easily still have a
   * `windowEnds` in the future — it was drawn early, or closed once the prize
   * was covered — and a bare countdown then reads "6d 3h left" beside a draw
   * that is already over, which tells a visitor they can still enter something
   * they cannot. Found by reading the real contract, not by testing the
   * countdown on its own.
   */
  countdownText: string | null;
}

/**
 * Which pill to show.
 *
 * Ordered, not independent. A completed raffle is not "filling" however its
 * counters read, and a full one is not "prize covered" even though it is. The
 * chain's status wins wherever it says anything definite; the two mid-flight
 * distinctions are the only ones this has to work out for itself.
 */
export function statusPill(raffle: RaffleState, windowNumber = 1): StatusPill {
  switch (raffle.status) {
    case 'Completed':
      return { kind: 'complete' };
    case 'Drawing':
      return { kind: 'drawing' };
    case 'ReadyToDraw':
      return { kind: 'ready-to-draw' };
    case 'Open':
      if (windowNumber > 1) return { kind: 'window-2' };
      return raffle.prizeCovered ? { kind: 'prize-covered' } : { kind: 'filling' };
    default:
      // 'None' never reaches a screen — readRaffle returns null for it — but a
      // pill is still better than a crash if one ever did.
      return { kind: 'filling' };
  }
}

export function present(
  raffle: RaffleState,
  windowNumber = 1,
  now: Date = new Date(),
): RafflePresentation {
  /*
   * The owner's cut, from the identity Section 7 holds the raffle to:
   * `totalEntries x entryPrice = prize + ownerRoi`.
   *
   * Derived rather than read, because the chain does not store it — and
   * deriving it is the honest option: a stored copy could disagree with the
   * three numbers it is made of, and then the app would be showing a return
   * the contract does not actually pay.
   */
  const gross = BigInt(raffle.totalEntries) * raffle.entryPrice;
  const config = {
    prize: raffle.prize,
    entryPrice: raffle.entryPrice,
    totalEntries: raffle.totalEntries,
    // Never negative: a raffle whose entries cannot cover its prize is a loss
    // the owner has chosen, not a negative return to render.
    ownerRoi: gross > raffle.prize ? gross - raffle.prize : 0n,
  };

  const covering = entriesToCoverPrize(raffle.prize, raffle.entryPrice);

  return {
    pill: statusPill(raffle, windowNumber),
    fill: clamp01(raffle.totalEntries === 0 ? 0 : raffle.entriesSold / raffle.totalEntries),
    // Hidden once covered: a marker pointing behind the fill is noise, and
    // hidden when it sits past the end, which means the raffle can never cover
    // its prize from entries alone and wants the owner's top-up, not a bar.
    coverMarker:
      raffle.prizeCovered || covering > raffle.totalEntries || raffle.totalEntries === 0
        ? null
        : covering / raffle.totalEntries,
    roiBps: roiBps(config),
    bestOddsBps: maxWalletOddsBps(raffle.totalEntries),
    entriesLeft: Math.max(0, raffle.totalEntries - raffle.entriesSold),
    // Only an open raffle has a window anyone can act within.
    countdownText: raffle.status === 'Open' ? countdown(raffle.windowEnds, now) : null,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * What an open draw says once its window has passed. The window is a target,
 * not a deadline: `enter` checks only that the draw is Open, and anyone may
 * call `extendWindow` to restart the clock. An underfilled draw keeps selling
 * until it fills (docs/audit, "Entries are never refunded").
 */
export const UNTIL_FILLED = 'Until filled';

/**
 * A countdown, as words.
 *
 * Never counts up. A window that has passed says the draw sells on until it
 * fills, never that sales have closed: they have not, and saying so turns
 * buyers away from a draw they can still enter.
 */
export function countdown(windowEnds: Date, now: Date = new Date()): string {
  const ms = windowEnds.getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return UNTIL_FILLED;

  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;

  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${mins}m left`;
  if (minutes > 0) return `${minutes}m left`;
  // Under a minute: seconds would tick visibly on a screen nobody is watching
  // that closely, and "less than a minute" is the honest amount of precision.
  return 'Less than a minute left';
}

/** Basis points as a percentage string, e.g. 4900 -> "49%". */
export function bpsToPercent(bps: number, decimals = 0): string {
  return `${(bps / 100).toFixed(decimals)}%`;
}
