import { describe, expect, it } from 'vitest';

import { formatUsdc, parseUsdc } from '@stubby/shared';

import { DEFAULT_WINDOW_DAYS, composeRaffle, windowSeconds } from '../src/chain/composer.js';

const blank = { prize: '', entryPrice: '', totalEntries: '', targetRoi: '' };
const fields = (o: Partial<typeof blank>) => ({ ...blank, ...o });

describe('composeRaffle', () => {
  it('waits until three fields are filled', () => {
    expect(composeRaffle(fields({ prize: '50' }))).toMatchObject({ kind: 'incomplete', filled: 1 });
    expect(composeRaffle(fields({ prize: '50', entryPrice: '1' }))).toMatchObject({
      kind: 'incomplete',
      filled: 2,
    });
  });

  it('refuses all four, because the solver could not know what to derive', () => {
    expect(
      composeRaffle({ prize: '50', entryPrice: '1', totalEntries: '70', targetRoi: '20' }),
    ).toMatchObject({ kind: 'over-specified', filled: 4 });
  });

  it('does not treat whitespace as a value', () => {
    // An owner who typed a space into a field they meant to leave blank would
    // otherwise get "over-specified" and no explanation.
    const state = composeRaffle({
      prize: '50',
      entryPrice: '1',
      totalEntries: '70',
      targetRoi: '   ',
    });
    expect(state.kind).toBe('solved');
  });

  it('solves for the missing number', () => {
    const state = composeRaffle(fields({ prize: '50', entryPrice: '1', totalEntries: '70' }));
    expect(state).toMatchObject({ kind: 'solved' });
    if (state.kind !== 'solved') throw new Error('unreachable');
    expect(state.result.solvedFor).toBe('ownerRoi');
    // 70 x 1 = 70 collected, 50 prize, so the owner takes 20.
    expect(formatUsdc(state.result.config.ownerRoi)).toBe('20');
    expect(state.result.collected).toBe(parseUsdc('70'));
  });

  it('solves for entries when given a target return', () => {
    const state = composeRaffle(fields({ prize: '50', entryPrice: '1', targetRoi: '20' }));
    if (state.kind !== 'solved') throw new Error(`expected solved, got ${state.kind}`);
    expect(state.result.solvedFor).toBe('totalEntries');
    expect(state.result.config.totalEntries).toBe(70);
  });

  it('rejects a fractional ticket count', () => {
    // Entries are a count, not money. parseUsdc would read "70.5" happily and
    // the contract cannot represent half a ticket.
    expect(
      composeRaffle(fields({ prize: '50', entryPrice: '1', totalEntries: '70.5' })),
    ).toMatchObject({ kind: 'unparseable', field: 'totalEntries' });
  });

  it('rejects an amount that is not a plain decimal', () => {
    for (const bad of ['1e3', '1,000', 'fifty', '.5']) {
      const state = composeRaffle(fields({ prize: bad, entryPrice: '1', totalEntries: '70' }));
      expect(state.kind, bad).toBe('unparseable');
    }
  });

  it('rejects more decimal places than USDC has', () => {
    const state = composeRaffle(
      fields({ prize: '50.1234567', entryPrice: '1', totalEntries: '70' }),
    );
    expect(state).toMatchObject({ kind: 'unparseable', field: 'prize' });
  });

  it('names the field that could not be read', () => {
    const state = composeRaffle(fields({ prize: '50', entryPrice: 'x', totalEntries: '70' }));
    expect(state).toMatchObject({ kind: 'unparseable', field: 'entryPrice' });
  });

  it('surfaces the solver"s own complaints rather than hiding them', () => {
    // Section 11.3's floor: 10 entries minimum. The solver reports it as an
    // issue and the composer must not swallow it.
    const state = composeRaffle(fields({ prize: '10', entryPrice: '1.2', totalEntries: '9' }));
    if (state.kind !== 'solved') throw new Error(`expected solved, got ${state.kind}`);
    expect(state.result.issues.length).toBeGreaterThan(0);
  });
});

describe('windowSeconds', () => {
  it('converts days to seconds', () => {
    expect(windowSeconds(7)).toBe(604_800n);
    expect(windowSeconds(DEFAULT_WINDOW_DAYS)).toBe(604_800n);
  });

  it('rounds rather than producing a fractional second', () => {
    // uint64 seconds on the contract; a fraction would throw in BigInt().
    expect(windowSeconds(0.5)).toBe(43_200n);
    expect(() => windowSeconds(1 / 3)).not.toThrow();
  });
});
