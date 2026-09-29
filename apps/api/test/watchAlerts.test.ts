import type { RaffleState } from '@stubby/shared';
import { describe, expect, it } from 'vitest';

import { WAITING_GRACE_MS, isDue, ownerAlerts } from '../src/watch/alerts.js';
import { alertNotice, resultNotice } from '../src/watch/notices.js';

const now = new Date('2026-09-25T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function raffle(over: Partial<RaffleState>): RaffleState {
  return {
    id: 1n,
    status: 'Open',
    prize: 4_000_000n,
    entryPrice: 1_000_000n,
    totalEntries: 5,
    entriesSold: 0,
    collected: 0n,
    prizeCovered: false,
    windowEnds: new Date(now.getTime() + 24 * HOUR),
    winner: null,
    winningEntry: null,
    prizeOwed: 0n,
    commissionOwed: 0n,
    prizePaid: false,
    requestedAt: null,
    ...over,
  };
}

describe('ownerAlerts', () => {
  it('says nothing about healthy raffles, or about unclaimed prizes and commission', () => {
    const alerts = ownerAlerts({
      raffles: [
        raffle({}),
        raffle({ id: 2n, status: 'Completed', prizeOwed: 4n, winner: '0x1' as never }),
        raffle({ id: 3n, status: 'Completed', prizePaid: true, commissionOwed: 1n }),
      ],
      now,
      randomnessTimeoutMs: HOUR,
      solvent: true,
      requestsAffordable: 10n,
    });
    expect(alerts).toEqual([]);
  });

  it('alerts at once when a new randomness source is scheduled', () => {
    const alerts = ownerAlerts({
      raffles: [],
      now,
      randomnessTimeoutMs: HOUR,
      pendingRandomness: {
        source: '0xAbC0000000000000000000000000000000000001',
        activatesAt: new Date(now.getTime() + HOUR),
      },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      key: 'randomness-source:0xabc0000000000000000000000000000000000001',
      graceMs: 0,
    });
    expect(alerts[0]!.detail).toMatch(/cancelRandomnessSource/);
  });

  it('flags a full undrawn raffle after a grace period, and a stuck draw at once', () => {
    const alerts = ownerAlerts({
      raffles: [
        raffle({ id: 4n, status: 'ReadyToDraw' }),
        raffle({ id: 5n, status: 'Drawing', requestedAt: new Date(now.getTime() - 2 * HOUR) }),
      ],
      now,
      randomnessTimeoutMs: HOUR,
    });
    expect(alerts.map((a) => [a.key, a.graceMs])).toEqual([
      ['raffle:4:waiting-to-draw', WAITING_GRACE_MS],
      ['raffle:5:draw-stuck', 0],
    ]);
  });

  it('flags a contract that cannot pay what it owes, and a float about to run out', () => {
    const keys = ownerAlerts({
      raffles: [],
      now,
      randomnessTimeoutMs: HOUR,
      solvent: false,
      requestsAffordable: 1n,
    }).map((a) => a.key);
    expect(keys).toEqual(['holdings', 'randomness-float']);
  });
});

describe('isDue', () => {
  const alert = { key: 'k', title: 't', detail: 'd', graceMs: 10 * 60 * 1000 };

  it('waits out the grace period, then sends, then repeats rarely', () => {
    const firstSeen = new Date(now.getTime() - 5 * 60 * 1000);
    expect(isDue(alert, { firstSeen, lastSent: null }, now)).toBe(false);
    const older = new Date(now.getTime() - 11 * 60 * 1000);
    expect(isDue(alert, { firstSeen: older, lastSent: null }, now)).toBe(true);
    expect(isDue(alert, { firstSeen: older, lastSent: new Date(now.getTime() - HOUR) }, now)).toBe(
      false,
    );
    expect(
      isDue(alert, { firstSeen: older, lastSent: new Date(now.getTime() - 13 * HOUR) }, now),
    ).toBe(true);
  });
});

describe('notices', () => {
  it('tells a winner the prize and where to claim, with no deadline', () => {
    const n = resultNotice({
      to: 'a@example.com',
      raffleId: 7n,
      won: true,
      prize: 4_000_000n,
      appOrigin: 'https://stubby.example/',
    });
    expect(n.subject).toBe('You won 4 USDC in Stubby draw #7');
    expect(n.text).toContain('https://stubby.example/won/7');
    expect(n.text).toContain('no deadline');
  });

  it('tells everyone else plainly, with the proof', () => {
    const n = resultNotice({
      to: 'a@example.com',
      raffleId: 7n,
      won: false,
      prize: 4_000_000n,
      appOrigin: 'https://stubby.example',
    });
    expect(n.subject).toBe('Stubby draw #7 has been drawn');
    expect(n.text).toContain('https://stubby.example/raffle/7');
    expect(n.text).not.toContain('won/7');
  });

  it('puts every due alert in one mail', () => {
    const n = alertNotice(
      'owner@example.com',
      [
        { key: 'a', title: 'One', detail: 'do one', graceMs: 0 },
        { key: 'b', title: 'Two', detail: 'do two', graceMs: 0 },
      ],
      'https://stubby.example',
    );
    expect(n.subject).toBe('Stubby: 2 things need a look');
    expect(n.text).toContain('- One');
    expect(n.text).toContain('https://stubby.example/admin');
  });
});
