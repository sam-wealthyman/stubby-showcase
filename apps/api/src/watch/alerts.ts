/**
 * What the platform owner should be told about (Section 13.6).
 *
 * Pure: the watcher reads the chain and the database, and this decides. The
 * per-raffle conditions are `attentionFor` from @stubby/shared, the same rules
 * the admin control room shows, so the owner's inbox and screen agree.
 *
 * Not every "needs a look" is an alert. An unclaimed prize has no deadline and
 * uncollected commission is safe where it is; mailing about either every day
 * would train the owner to ignore the mail that matters.
 */

import { attentionFor, attentionMessage, type RaffleState } from '@stubby/shared';

export interface OwnerAlert {
  /** Stable while the condition lasts, so it is sent once and repeated rarely. */
  key: string;
  title: string;
  detail: string;
  /** How long the condition must hold before it is worth a mail. */
  graceMs: number;
}

export interface AlertInput {
  raffles: readonly RaffleState[];
  now: Date;
  /** The contract's `randomnessTimeout`. */
  randomnessTimeoutMs: number;
  /** From `readHoldings`: can the contract pay everything it owes? */
  solvent?: boolean;
  /** From the randomness adapter; undefined where the source has no float. */
  requestsAffordable?: bigint;
  /** A randomness source scheduled to take over, if any. */
  pendingRandomness?: { source: string; activatesAt: Date };
}

/**
 * A full raffle waits for somebody to call `startDraw`. Usually that is quick,
 * so ten minutes of nobody doing it is the point to say so.
 */
export const WAITING_GRACE_MS = 10 * 60 * 1000;

/** Fewer draws than this left in the randomness float is worth a top-up. */
export const LOW_FLOAT = 3n;

export function ownerAlerts(input: AlertInput): OwnerAlert[] {
  const alerts: OwnerAlert[] = [];

  if (input.solvent === false) {
    alerts.push({
      key: 'holdings',
      title: 'The contract holds less USDC than it owes',
      detail:
        'requiredHoldings is above the USDC balance. This should be impossible; entries and claims may fail. Look now.',
      graceMs: 0,
    });
  }

  // The source decides winners. A change the owner did not make means the
  // owner key is in someone else's hands, and there is an hour to act.
  if (input.pendingRandomness) {
    const { source, activatesAt } = input.pendingRandomness;
    alerts.push({
      key: `randomness-source:${source.toLowerCase()}`,
      title: 'A new randomness source has been scheduled',
      detail: `${source} takes over at ${activatesAt.toISOString()}. If you did not schedule it, your owner key is compromised: call cancelRandomnessSource now, and pause entries. Buying is paused in the app until it takes effect.`,
      graceMs: 0,
    });
  }
  if (input.requestsAffordable !== undefined && input.requestsAffordable < LOW_FLOAT) {
    alerts.push({
      key: 'randomness-float',
      title: `The randomness float covers ${input.requestsAffordable} more draw${input.requestsAffordable === 1n ? '' : 's'}`,
      detail:
        'Top up the D20RandomnessAdapter. Without it, startDraw reverts and full raffles wait.',
      graceMs: 0,
    });
  }

  for (const raffle of input.raffles) {
    const attention = attentionFor(raffle, input.now, input.randomnessTimeoutMs);
    if (
      attention !== 'waiting-to-draw' &&
      attention !== 'draw-stuck' &&
      attention !== 'window-closed'
    ) {
      continue;
    }
    const { title, action } = attentionMessage(attention);
    alerts.push({
      key: `raffle:${raffle.id}:${attention}`,
      title: `Draw #${raffle.id}: ${title}`,
      detail: action,
      graceMs: attention === 'waiting-to-draw' ? WAITING_GRACE_MS : 0,
    });
  }

  return alerts;
}

/** Remind about a condition that is still true this often. */
export const REPEAT_MS = 12 * 60 * 60 * 1000;

/** Whether an alert should go out now, given when it was first seen and last sent. */
export function isDue(
  alert: OwnerAlert,
  state: { firstSeen: Date; lastSent: Date | null },
  now: Date,
  repeatMs = REPEAT_MS,
): boolean {
  if (now.getTime() - state.firstSeen.getTime() < alert.graceMs) return false;
  return state.lastSent === null || now.getTime() - state.lastSent.getTime() >= repeatMs;
}
