import { describe, expect, it } from 'vitest';

import { parseUsdc, type RaffleState } from '@stubby/shared';

import { bpsToPercent, countdown, present, statusPill } from '../src/chain/present.js';

function raffle(overrides: Partial<RaffleState> = {}): RaffleState {
  return {
    id: 1n,
    status: 'Open',
    prize: parseUsdc('50'),
    entryPrice: parseUsdc('1'),
    totalEntries: 70,
    entriesSold: 52,
    collected: parseUsdc('52'),
    prizeCovered: true,
    windowEnds: new Date('2026-10-01T00:00:00Z'),
    winner: null,
    winningEntry: null,
    prizeOwed: 0n,
    commissionOwed: 0n,
    prizePaid: false,
    ...overrides,
  };
}

describe('statusPill', () => {
  it('shows one pill per state, and the chain wins', () => {
    expect(statusPill(raffle({ status: 'Completed' }))).toEqual({ kind: 'complete' });
    expect(statusPill(raffle({ status: 'Drawing' }))).toEqual({ kind: 'drawing' });
    expect(statusPill(raffle({ status: 'ReadyToDraw' }))).toEqual({ kind: 'ready-to-draw' });
  });

  it('does not call a finished raffle "filling" however its counters read', () => {
    // A completed raffle still has entriesSold < totalEntries if it was closed
    // early, which is exactly when a counter-driven pill would get it wrong.
    const closedEarly = raffle({ status: 'Completed', entriesSold: 52, prizeCovered: true });
    expect(statusPill(closedEarly)).toEqual({ kind: 'complete' });
  });

  it('distinguishes filling from prize-covered while open', () => {
    expect(statusPill(raffle({ prizeCovered: false }))).toEqual({ kind: 'filling' });
    expect(statusPill(raffle({ prizeCovered: true }))).toEqual({ kind: 'prize-covered' });
  });

  it('shows the extended window ahead of prize-covered', () => {
    // Section 11.5: window 2 means no refunds, which a participant needs to
    // know more than they need to know the pot is safe.
    expect(statusPill(raffle({ prizeCovered: true }), 2)).toEqual({ kind: 'window-2' });
  });
});

describe('present', () => {
  it('reports the fill as a fraction', () => {
    expect(present(raffle({ entriesSold: 35, totalEntries: 70 })).fill).toBeCloseTo(0.5);
  });

  it('clamps a fill that would run past the end of the bar', () => {
    // Should be impossible on-chain; renders happily and reads as a bug.
    expect(present(raffle({ entriesSold: 99, totalEntries: 70 })).fill).toBe(1);
  });

  it('survives a raffle with no entries at all', () => {
    const shown = present(raffle({ totalEntries: 0, entriesSold: 0 }));
    // 0/0 is NaN, which renders as a blank bar and an empty countdown.
    expect(shown.fill).toBe(0);
    expect(shown.coverMarker).toBeNull();
    expect(shown.entriesLeft).toBe(0);
  });

  it('puts the cover marker where the pot reaches the prize', () => {
    // 50 USDC prize at 1 USDC an entry: the 50th of 70 entries covers it.
    const shown = present(raffle({ prizeCovered: false, entriesSold: 10 }));
    expect(shown.coverMarker).toBeCloseTo(50 / 70);
  });

  it('hides the marker once the prize is covered', () => {
    // A marker pointing behind the fill is noise.
    expect(present(raffle({ prizeCovered: true })).coverMarker).toBeNull();
  });

  it('hides the marker when entries alone can never cover the prize', () => {
    // 50 USDC prize, 20 entries at 1 USDC: the pot tops out at 20. The raffle
    // wants the owner's top-up, not a marker past the end of the bar.
    const shown = present(
      raffle({
        prize: parseUsdc('50'),
        entryPrice: parseUsdc('1'),
        totalEntries: 20,
        prizeCovered: false,
      }),
    );
    expect(shown.coverMarker).toBeNull();
  });

  it('derives the owner return from the identity the contract holds', () => {
    // Section 7: totalEntries x entryPrice = prize + ownerRoi.
    // 70 x 1 = 70, prize 50, so ownerRoi is 20 — 40% of the prize.
    expect(present(raffle()).roiBps).toBe(4000);
  });

  it('never reports a negative return', () => {
    // Entries cannot cover the prize: a loss the owner chose, not a number to
    // render with a minus sign.
    const shown = present(raffle({ prize: parseUsdc('100'), totalEntries: 70 }));
    expect(shown.roiBps).toBe(0);
  });

  it('reports the best odds one wallet can reach', () => {
    // Section 11.3: the 5-entry cap over 70 entries is just over 7%.
    expect(present(raffle()).bestOddsBps).toBe(714);
  });

  /**
   * Found by reading the real contract, not by testing `countdown` alone.
   *
   * Raffle #1 on Arc testnet is Completed with a `windowEnds` still in the
   * future — it was drawn once the prize was covered. Rendering a bare
   * countdown beside it said "6d 3h left" under a draw that was already over.
   */
  it('shows no countdown for a raffle nobody can enter', () => {
    const future = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
    for (const status of ['Completed', 'Drawing', 'ReadyToDraw'] as const) {
      expect(present(raffle({ status, windowEnds: future })).countdownText, status).toBeNull();
    }
  });

  it('shows a countdown while the raffle is open', () => {
    const shown = present(
      raffle({ status: 'Open', windowEnds: new Date('2026-09-04T03:00:00Z') }),
      1,
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(shown.countdownText).toBe('3d 3h left');
  });

  it('counts the entries left', () => {
    expect(present(raffle({ entriesSold: 52, totalEntries: 70 })).entriesLeft).toBe(18);
  });
});

describe('countdown', () => {
  const at = (iso: string) => new Date(iso);

  it('never counts up', () => {
    // A negative countdown renders happily and tells a participant something
    // false about whether they can still enter.
    expect(countdown(at('2026-09-01T00:00:00Z'), at('2026-09-02T00:00:00Z'))).toBe('Until filled');
  });

  it('says the window is closed at exactly the deadline', () => {
    expect(countdown(at('2026-09-01T00:00:00Z'), at('2026-09-01T00:00:00Z'))).toBe('Until filled');
  });

  it('reads in days and hours when there is time', () => {
    expect(countdown(at('2026-09-04T03:00:00Z'), at('2026-09-01T00:00:00Z'))).toBe('3d 3h left');
  });

  it('drops to hours and minutes inside a day', () => {
    expect(countdown(at('2026-09-01T05:30:00Z'), at('2026-09-01T00:00:00Z'))).toBe('5h 30m left');
  });

  it('drops to minutes inside an hour', () => {
    expect(countdown(at('2026-09-01T00:12:00Z'), at('2026-09-01T00:00:00Z'))).toBe('12m left');
  });

  it('stops short of seconds', () => {
    // Seconds would tick on a screen nobody watches that closely, and imply a
    // precision the window does not have.
    expect(countdown(at('2026-09-01T00:00:30Z'), at('2026-09-01T00:00:00Z'))).toBe(
      'Less than a minute left',
    );
  });
});

describe('bpsToPercent', () => {
  it('renders basis points as a percentage', () => {
    expect(bpsToPercent(4000)).toBe('40%');
    expect(bpsToPercent(714, 1)).toBe('7.1%');
  });
});
