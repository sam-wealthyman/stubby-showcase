/**
 * The raffle identity, and the one place it is implemented.
 *
 *     totalEntries × entryPrice = prize + ownerRoi
 *
 * The app, the API and the Solidity contract must all agree on this, so it
 * lives here and nowhere else (project brief, Sections 7, 11.6 and 11.8).
 */

import { USDC_CENT, formatUsdc, isWholeCents, parseUsdc } from './units.js';

/** Section 2: a wallet may hold at most 5 entries in any one raffle. */
export const MAX_ENTRIES_PER_WALLET = 5;

/**
 * The most entries one wallet may hold in a raffle of this size: a quarter
 * of it, at least 1 and at most 5. The contract's `walletCap`, mirrored.
 *
 * So no wallet holds more than 25% of a draw's odds however small it is:
 * 10 entries allow 2 each, 12 allow 3, 16 allow 4, 20 and up allow 5.
 */
export function walletCap(totalEntries: number): number {
  return Math.max(1, Math.min(MAX_ENTRIES_PER_WALLET, Math.floor(totalEntries / 4)));
}

export interface RaffleBounds {
  entryPrice: { min: bigint; max: bigint };
  prize: { min: bigint; max: bigint };
  totalEntries: { min: number; max: number };
  /** Owner ROI ceiling as a fraction of the prize, in basis points. */
  maxRoiBps: number;
}

/** Section 11.8 defaults. All configurable by the platform owner. */
export const DEFAULT_BOUNDS: RaffleBounds = {
  entryPrice: { min: parseUsdc('0.5'), max: parseUsdc('100') },
  prize: { min: parseUsdc('10'), max: parseUsdc('10000') },
  totalEntries: { min: 10, max: 10_000 },
  maxRoiBps: 5_000,
};

export interface RaffleConfig {
  prize: bigint;
  entryPrice: bigint;
  totalEntries: number;
  /** What the owner actually takes: `collected - prize`. */
  ownerRoi: bigint;
}

export type IssueCode =
  | 'prize-below-min'
  | 'prize-above-max'
  | 'entry-price-below-min'
  | 'entry-price-above-max'
  | 'entry-price-sub-cent'
  | 'entries-below-min'
  | 'entries-above-max'
  | 'entries-not-integer'
  | 'roi-negative'
  | 'roi-above-max'
  | 'identity-broken';

export interface ValidationIssue {
  code: IssueCode;
  message: string;
}

export interface SolveRequest {
  prize?: bigint;
  entryPrice?: bigint;
  totalEntries?: number;
  /** The ROI the owner is aiming for. Rounding may land slightly above it. */
  targetRoi?: bigint;
}

export interface SolveResult {
  config: RaffleConfig;
  /** `totalEntries × entryPrice`, i.e. what a full raffle takes in. */
  collected: bigint;
  solvedFor: 'prize' | 'entryPrice' | 'totalEntries' | 'ownerRoi';
  /** Section 11.6: rounding up left the owner taking more than the target. */
  roundedUp: boolean;
  /** How much more than `targetRoi` rounding produced. Zero when exact. */
  roundingGain: bigint;
  issues: ValidationIssue[];
}

/** Ceiling division for non-negative bigints. */
function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('divisor must be positive');
  return a <= 0n ? 0n : (a + b - 1n) / b;
}

function roundUpTo(value: bigint, step: bigint): bigint {
  return ceilDiv(value, step) * step;
}

/**
 * Solve the raffle identity.
 *
 * Exactly three of `prize`, `entryPrice`, `totalEntries` and `targetRoi` must
 * be supplied; the fourth is computed.
 *
 * Section 7 said "lock any two", but with one equation and four unknowns two
 * knowns cannot fix the other two. Resolved: the owner locks three. The
 * "prize + total entries" flow therefore takes a target ROI too, which
 * `roiFromBps` lets the dashboard express as a percentage.
 *
 * Rounding follows Section 11.6: always up, so the prize stays exact and the
 * owner's take never falls below target. The excess is under one entry price.
 */
export function solveRaffle(
  request: SolveRequest,
  bounds: RaffleBounds = DEFAULT_BOUNDS,
): SolveResult {
  const { prize, entryPrice, totalEntries, targetRoi } = request;
  const given = [prize, entryPrice, totalEntries, targetRoi].filter((v) => v !== undefined);
  if (given.length !== 3) {
    throw new RangeError(
      `solveRaffle needs exactly three of prize, entryPrice, totalEntries, targetRoi; got ${given.length}`,
    );
  }

  let solved: RaffleConfig;
  let solvedFor: SolveResult['solvedFor'];

  if (totalEntries === undefined) {
    const entries = ceilDiv(prize! + targetRoi!, entryPrice!);
    if (entries > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError('total entries overflows a safe integer');
    }
    solvedFor = 'totalEntries';
    solved = {
      prize: prize!,
      entryPrice: entryPrice!,
      totalEntries: Number(entries),
      ownerRoi: 0n,
    };
  } else if (entryPrice === undefined) {
    // Round the price up to a whole cent: admins set prices, not wei.
    const exact = ceilDiv(prize! + targetRoi!, BigInt(totalEntries));
    solvedFor = 'entryPrice';
    solved = { prize: prize!, entryPrice: roundUpTo(exact, USDC_CENT), totalEntries, ownerRoi: 0n };
  } else if (prize === undefined) {
    solvedFor = 'prize';
    solved = {
      prize: BigInt(totalEntries) * entryPrice - targetRoi!,
      entryPrice,
      totalEntries,
      ownerRoi: targetRoi!,
    };
  } else {
    solvedFor = 'ownerRoi';
    solved = { prize, entryPrice, totalEntries, ownerRoi: 0n };
  }

  // The owner's take is always whatever is left after the prize, never the
  // target that was asked for.
  const collected = BigInt(solved.totalEntries) * solved.entryPrice;
  const config: RaffleConfig = { ...solved, ownerRoi: collected - solved.prize };
  const roundingGain = targetRoi === undefined ? 0n : config.ownerRoi - targetRoi;

  return {
    config,
    collected,
    solvedFor,
    roundedUp: roundingGain > 0n,
    roundingGain: roundingGain > 0n ? roundingGain : 0n,
    issues: validateRaffle(config, bounds),
  };
}

/** Check a config against the configured bounds. Empty array means publishable. */
export function validateRaffle(
  config: RaffleConfig,
  bounds: RaffleBounds = DEFAULT_BOUNDS,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: IssueCode, message: string) => issues.push({ code, message });

  if (config.prize < bounds.prize.min) {
    add('prize-below-min', `The prize must be at least ${formatUsdc(bounds.prize.min)} USDC.`);
  }
  if (config.prize > bounds.prize.max) {
    add('prize-above-max', `The prize can be at most ${formatUsdc(bounds.prize.max)} USDC.`);
  }

  if (config.entryPrice < bounds.entryPrice.min) {
    add(
      'entry-price-below-min',
      `A ticket must cost at least ${formatUsdc(bounds.entryPrice.min)} USDC.`,
    );
  }
  if (config.entryPrice > bounds.entryPrice.max) {
    add(
      'entry-price-above-max',
      `A ticket can cost at most ${formatUsdc(bounds.entryPrice.max)} USDC.`,
    );
  }
  if (!isWholeCents(config.entryPrice)) {
    add('entry-price-sub-cent', 'Entry price is not a whole number of cents.');
  }

  const wholeEntries = Number.isInteger(config.totalEntries);
  if (!wholeEntries) {
    add('entries-not-integer', 'Total entries must be a whole number.');
  }
  if (config.totalEntries < bounds.totalEntries.min) {
    add('entries-below-min', `A draw needs at least ${bounds.totalEntries.min} tickets.`);
  }
  if (config.totalEntries > bounds.totalEntries.max) {
    add('entries-above-max', `A draw can have at most ${bounds.totalEntries.max} tickets.`);
  }

  if (config.ownerRoi < 0n) {
    add('roi-negative', 'Entries at this price do not cover the prize.');
  } else if (config.ownerRoi * 10_000n > config.prize * BigInt(bounds.maxRoiBps)) {
    add('roi-above-max', 'Owner ROI is above the ceiling set for the prize.');
  }

  // Only meaningful once the entry count is a whole number — and BigInt()
  // throws on a fractional one, so this must stay behind that check.
  if (
    wholeEntries &&
    BigInt(config.totalEntries) * config.entryPrice !== config.prize + config.ownerRoi
  ) {
    add('identity-broken', 'totalEntries × entryPrice does not equal prize + ownerRoi.');
  }

  return issues;
}

/** Owner ROI as a fraction of the prize, in basis points. */
export function roiBps(config: RaffleConfig): number {
  if (config.prize === 0n) return 0;
  return Number((config.ownerRoi * 10_000n) / config.prize);
}

/** Odds of a wallet holding `entriesHeld` entries, in basis points. */
export function oddsBps(entriesHeld: number, totalEntries: number): number {
  if (totalEntries <= 0) return 0;
  return Math.round((entriesHeld / totalEntries) * 10_000);
}

/**
 * The most of a raffle one wallet can buy, in basis points.
 *
 * Section 11.3 leans on this: `walletCap` keeps it at or under 25% for a
 * raffle of any size.
 */
export function maxWalletOddsBps(totalEntries: number): number {
  return oddsBps(Math.min(walletCap(totalEntries), totalEntries), totalEntries);
}

/**
 * Entries needed before the collected pot covers the prize (Section 11.5).
 * Past this point the owner may close and draw early.
 */
export function entriesToCoverPrize(prize: bigint, entryPrice: bigint): number {
  return Number(ceilDiv(prize, entryPrice));
}

/** Section 11.5: has this raffle taken in at least its prize? */
export function isPrizeCovered(entriesSold: number, config: RaffleConfig): boolean {
  return BigInt(entriesSold) * config.entryPrice >= config.prize;
}

/**
 * Express an ROI target as a fraction of the prize.
 *
 * Section 7 lets the owner think in percentages ("take 40%") while
 * `solveRaffle` works in absolute amounts. Rounds down, so the stated
 * percentage is a ceiling and Section 11.6's round-up still governs the
 * entry count.
 */
export function roiFromBps(prize: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new RangeError('bps must be a non-negative integer');
  }
  return (prize * BigInt(bps)) / 10_000n;
}
