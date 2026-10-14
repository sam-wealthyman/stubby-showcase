import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RaffleState } from '@stubby/shared';
import { generatePrivateKey } from 'viem/accounts';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { LOW_GAS, expiredOpen, gasUsdc, loadKeeperKey } from '../src/watch/keeper.js';

const now = new Date('2026-10-14T12:00:00Z');
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

describe('expiredOpen', () => {
  it('picks open draws past their window, oldest first', () => {
    const due = expiredOpen(
      [
        raffle({ id: 2n, windowEnds: new Date(now.getTime() - HOUR) }),
        raffle({ id: 3n }),
        raffle({ id: 4n, windowEnds: new Date(now.getTime() - 48 * HOUR) }),
        raffle({ id: 5n, windowEnds: now }),
      ],
      now,
    );
    expect(due).toEqual([4n, 2n, 5n]);
  });

  it('leaves anything not Open alone, however old its window', () => {
    const old = new Date(now.getTime() - 48 * HOUR);
    const due = expiredOpen(
      (['ReadyToDraw', 'Drawing', 'Completed', 'Cancelled'] as const).map((status, i) =>
        raffle({ id: BigInt(i + 1), status, windowEnds: old }),
      ),
      now,
    );
    expect(due).toEqual([]);
  });
});

describe('loadKeeperKey', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keeper-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };

  it('reads one key, with or without 0x and a trailing newline', () => {
    const key = generatePrivateKey();
    expect(loadKeeperKey(file('a', `${key}\n`))).toBe(key);
    expect(loadKeeperKey(file('b', key.slice(2)))).toBe(key);
  });

  it('switches the keeper off for a missing or malformed file, and never logs its contents', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secretish = 'KEEPER=0xdeadbeef';
    expect(loadKeeperKey(join(dir, 'missing'))).toBeNull();
    expect(loadKeeperKey(file('c', secretish))).toBeNull();
    const logged = errors.mock.calls.flat().join(' ');
    expect(logged).toContain('keeper off');
    expect(logged).not.toContain('deadbeef');
    errors.mockRestore();
  });
});

describe('gas', () => {
  it('reads the native 18-decimal balance as USDC', () => {
    expect(gasUsdc(LOW_GAS)).toBe('0.0500');
    expect(gasUsdc(1_234_500_000_000_000_000n)).toBe('1.2345');
  });
});
