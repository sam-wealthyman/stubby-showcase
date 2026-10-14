import type { RaffleState } from '@stubby/shared';

import { countdown, UNTIL_FILLED } from '@/chain/present';

/**
 * What a More draws row on Home says about its draw.
 *
 * The board draws three rows — "Hot", "High roller", "New" — but not the rule
 * behind each tag, and a tag that is decoration rather than a fact would be a
 * small lie on the first screen. So each one means something true about the
 * draw it sits on:
 *
 *   high-roller  a premium prize, 250 USDC or more (Section 12.3)
 *   ending-soon  still selling, with less than a day left
 *   new          the most recently opened draw still selling
 *   hot          still selling and at least a quarter sold
 *
 * Anything else carries no tag rather than an invented one.
 */
export type DrawTag = 'high-roller' | 'ending-soon' | 'new' | 'hot';

/** Section 12.3: premium treatment from 250 USDC up. */
export const HIGH_STAKES_FROM = 250_000_000n;

/** The share sold that makes an open draw "hot". */
export const HOT_FROM = 0.25;

/** How close to its end an open draw is "ending soon": a day. */
export const ENDING_SOON_WITHIN_MS = 24 * 60 * 60 * 1000;

export function drawTag(
  raffle: RaffleState,
  newestOpenId: bigint | undefined,
  now: Date = new Date(),
): DrawTag | null {
  if (raffle.prize >= HIGH_STAKES_FROM) return 'high-roller';
  if (raffle.status !== 'Open') return null;
  const left = raffle.windowEnds.getTime() - now.getTime();
  if (left > 0 && left < ENDING_SOON_WITHIN_MS) return 'ending-soon';
  if (newestOpenId !== undefined && raffle.id === newestOpenId) return 'new';
  if (raffle.totalEntries > 0 && raffle.entriesSold / raffle.totalEntries >= HOT_FROM) return 'hot';
  return null;
}

/** The newest draw still selling, which is the one "new" belongs to. */
export function newestOpen(raffles: readonly RaffleState[]): bigint | undefined {
  let newest: bigint | undefined;
  for (const r of raffles) {
    if (r.status === 'Open' && (newest === undefined || r.id > newest)) newest = r.id;
  }
  return newest;
}

/**
 * How many of the row's 20 progress blocks are filled.
 *
 * Rounded, as the board rounds: 18 of 65 fills 6, 12 of 50 fills 5, a full
 * draw fills all 20. A draw that has sold anything shows at least one block, so
 * a first sale is never invisible.
 */
export const SEGMENTS = 20;

export function segmentsFilled(sold: number, total: number): number {
  if (total <= 0) return 0;
  const filled = Math.round((sold / total) * SEGMENTS);
  if (sold > 0 && filled === 0) return 1;
  return Math.min(SEGMENTS, Math.max(0, filled));
}

/**
 * The row's stub: ENDS and the time left while a draw is selling, STATUS once
 * it is not.
 */
export function rowStub(
  raffle: RaffleState,
  now: Date = new Date(),
): { label: string; value: string } {
  switch (raffle.status) {
    case 'Open': {
      const left = countdown(raffle.windowEnds, now);
      if (left === UNTIL_FILLED) return { label: 'STATUS', value: 'Open' };
      // The stub is 84px: "2d 4h", not "2d 4h left".
      return {
        label: 'ENDS',
        value: left.replace(/ left$/, '').replace('Less than a minute', '<1m'),
      };
    }
    case 'ReadyToDraw':
      return { label: 'STATUS', value: 'Full' };
    case 'Drawing':
      return { label: 'STATUS', value: 'Drawing' };
    case 'Completed':
      return { label: 'STATUS', value: 'Drawn' };
    default:
      return { label: 'STATUS', value: '-' };
  }
}
