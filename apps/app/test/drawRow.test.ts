import { describe, expect, it } from 'vitest';

import type { RaffleState } from '@stubby/shared';

import {
  HIGH_STAKES_FROM,
  SEGMENTS,
  drawTag,
  newestOpen,
  rowStub,
  segmentsFilled,
} from '@/chain/drawRow';

const NOW = new Date('2026-09-24T12:00:00Z');

function raffle(p: Partial<RaffleState>): RaffleState {
  return {
    id: 1n,
    status: 'Open',
    prize: 100_000_000n,
    entryPrice: 2_000_000n,
    totalEntries: 65,
    entriesSold: 18,
    collected: 36_000_000n,
    prizeCovered: false,
    windowEnds: new Date(NOW.getTime() + (2 * 24 + 4) * 3_600_000 + 60_000),
    winner: null,
    winningEntry: null,
    prizeOwed: 0n,
    commissionOwed: 0n,
    prizePaid: false,
    ...p,
  };
}

describe('drawTag', () => {
  it('calls a premium prize a high roller, whatever its state', () => {
    expect(drawTag(raffle({ prize: HIGH_STAKES_FROM }), undefined, NOW)).toBe('high-roller');
    expect(drawTag(raffle({ prize: HIGH_STAKES_FROM, status: 'Drawing' }), undefined, NOW)).toBe(
      'high-roller',
    );
  });

  it('calls the newest open draw new', () => {
    expect(drawTag(raffle({ id: 7n, entriesSold: 12, totalEntries: 50 }), 7n, NOW)).toBe('new');
  });

  it('calls an open draw hot from a quarter sold, and nothing below', () => {
    expect(drawTag(raffle({ entriesSold: 18, totalEntries: 65 }), 99n, NOW)).toBe('hot');
    expect(drawTag(raffle({ entriesSold: 10, totalEntries: 65 }), 99n, NOW)).toBeNull();
  });

  it('calls an open draw ending soon in its last day, ahead of new and hot', () => {
    const now = new Date('2026-09-01T00:00:00Z');
    const ends = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
    expect(drawTag(raffle({ id: 7n, windowEnds: ends(23) }), 7n, now)).toBe('ending-soon');
    expect(drawTag(raffle({ id: 7n, windowEnds: ends(25) }), 7n, now)).toBe('new');
    expect(drawTag(raffle({ windowEnds: ends(-1) }), 99n, now)).not.toBe('ending-soon');
  });

  it('tags nothing that has stopped selling unless it is premium', () => {
    expect(drawTag(raffle({ status: 'Completed', entriesSold: 65 }), 1n, NOW)).toBeNull();
  });
});

describe('newestOpen', () => {
  it('ignores draws that are not selling', () => {
    expect(
      newestOpen([raffle({ id: 2n }), raffle({ id: 5n, status: 'Completed' }), raffle({ id: 3n })]),
    ).toBe(3n);
  });
});

describe('segmentsFilled', () => {
  it('rounds as the board does', () => {
    expect(segmentsFilled(18, 65)).toBe(6);
    expect(segmentsFilled(12, 50)).toBe(5);
    expect(segmentsFilled(60, 60)).toBe(SEGMENTS);
  });

  it('never hides a first sale', () => {
    expect(segmentsFilled(1, 400)).toBe(1);
    expect(segmentsFilled(0, 400)).toBe(0);
  });
});

describe('rowStub', () => {
  it('shows the time left, without "left", while selling', () => {
    expect(rowStub(raffle({}), NOW)).toEqual({ label: 'ENDS', value: '2d 4h' });
  });

  it('keeps an open draw open once its window has passed, since it still sells', () => {
    const passed = raffle({ windowEnds: new Date(NOW.getTime() - 3_600_000) });
    expect(rowStub(passed, NOW)).toEqual({ label: 'STATUS', value: 'Open' });
  });

  it('shows the status once it stops', () => {
    expect(rowStub(raffle({ status: 'ReadyToDraw' }), NOW).value).toBe('Full');
    expect(rowStub(raffle({ status: 'Drawing' }), NOW).value).toBe('Drawing');
    expect(rowStub(raffle({ status: 'Completed' }), NOW).value).toBe('Drawn');
  });
});
