import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOUNDS,
  MAX_ENTRIES_PER_WALLET,
  entriesToCoverPrize,
  isPrizeCovered,
  maxWalletOddsBps,
  walletCap,
  oddsBps,
  roiBps,
  roiFromBps,
  solveRaffle,
  validateRaffle,
} from '../src/raffle.js';
import { formatUsdc, parseUsdc } from '../src/units.js';

const usdc = parseUsdc;

describe('the worked examples in the brief', () => {
  it('Section 2: 50 prize at 1 per entry over 70 entries leaves the owner 20', () => {
    const { config, collected } = solveRaffle({
      prize: usdc('50'),
      entryPrice: usdc('1'),
      totalEntries: 70,
    });

    expect(collected).toBe(usdc('70'));
    expect(config.ownerRoi).toBe(usdc('20'));
    // "20 USDC (about 29%)"
    expect(roiBps(config)).toBe(4000);
    expect(formatUsdc(config.ownerRoi)).toBe('20');
  });

  it('Section 11.6: 50 prize, 3 entry, 20 target rounds 23.33 up to 24 entries', () => {
    const result = solveRaffle({
      prize: usdc('50'),
      entryPrice: usdc('3'),
      targetRoi: usdc('20'),
    });

    expect(result.solvedFor).toBe('totalEntries');
    expect(result.config.totalEntries).toBe(24);
    expect(result.collected).toBe(usdc('72'));
    // The prize stays exact; the owner takes 22 rather than the 20 asked for.
    expect(result.config.prize).toBe(usdc('50'));
    expect(result.config.ownerRoi).toBe(usdc('22'));
    expect(result.roundedUp).toBe(true);
    expect(result.roundingGain).toBe(usdc('2'));
    expect(result.issues).toEqual([]);
  });

  it('rounding never leaves the owner short, and never by a whole entry price', () => {
    const prize = usdc('50');
    const targetRoi = usdc('20');

    for (const price of ['0.5', '1', '1.25', '3', '7', '13.37', '100']) {
      const entryPrice = usdc(price);
      const { config, collected, roundingGain } = solveRaffle({ prize, entryPrice, targetRoi });

      expect(collected).toBe(BigInt(config.totalEntries) * entryPrice);
      expect(config.ownerRoi).toBeGreaterThanOrEqual(targetRoi);
      expect(roundingGain).toBeLessThan(entryPrice);
    }
  });
});

describe('solving for each field', () => {
  it('solves entry price, rounded up to a whole cent', () => {
    const result = solveRaffle({
      prize: usdc('50'),
      totalEntries: 70,
      targetRoi: usdc('20'),
    });

    expect(result.solvedFor).toBe('entryPrice');
    expect(result.config.entryPrice).toBe(usdc('1'));
    expect(result.issues).toEqual([]);
  });

  it('rounds an awkward entry price up rather than down', () => {
    // 60 / 70 = 0.857142... which must not become 0.85.
    const { config, collected } = solveRaffle({
      prize: usdc('50'),
      totalEntries: 70,
      targetRoi: usdc('10'),
    });

    expect(config.entryPrice).toBe(usdc('0.86'));
    expect(collected).toBe(usdc('60.2'));
    expect(config.ownerRoi).toBe(usdc('10.2'));
  });

  it('solves the prize from price, entries and target', () => {
    const { config, solvedFor } = solveRaffle({
      entryPrice: usdc('2'),
      totalEntries: 65,
      targetRoi: usdc('30'),
    });

    expect(solvedFor).toBe('prize');
    expect(config.prize).toBe(usdc('100'));
    expect(config.ownerRoi).toBe(usdc('30'));
  });

  it('refuses anything other than exactly three inputs', () => {
    expect(() => solveRaffle({ prize: usdc('50'), entryPrice: usdc('1') })).toThrow(RangeError);
    expect(() =>
      solveRaffle({
        prize: usdc('50'),
        entryPrice: usdc('1'),
        totalEntries: 70,
        targetRoi: usdc('20'),
      }),
    ).toThrow(RangeError);
  });

  it('keeps the identity exact however it was solved', () => {
    const cases = [
      { prize: usdc('10'), entryPrice: usdc('0.5'), targetRoi: usdc('0') },
      { prize: usdc('10000'), entryPrice: usdc('100'), targetRoi: usdc('5000') },
      { prize: usdc('250'), totalEntries: 300, targetRoi: usdc('50') },
      { entryPrice: usdc('1.5'), totalEntries: 1000, targetRoi: usdc('500') },
      { prize: usdc('99.99'), entryPrice: usdc('3.33'), totalEntries: 40 },
    ];

    for (const input of cases) {
      const { config, collected } = solveRaffle(input);
      expect(BigInt(config.totalEntries) * config.entryPrice).toBe(collected);
      expect(collected).toBe(config.prize + config.ownerRoi);
    }
  });
});

describe('bounds from Section 11.8', () => {
  it('accepts a raffle sitting exactly on every limit', () => {
    expect(
      validateRaffle({
        prize: usdc('10'),
        entryPrice: usdc('0.5'),
        totalEntries: 30,
        ownerRoi: usdc('5'),
      }),
    ).toEqual([]);
  });

  it('flags a prize under the floor and a price over the ceiling', () => {
    const issues = validateRaffle({
      prize: usdc('5'),
      entryPrice: usdc('200'),
      totalEntries: 20,
      ownerRoi: usdc('3995'),
    });

    expect(issues.map((i) => i.code)).toContain('prize-below-min');
    expect(issues.map((i) => i.code)).toContain('entry-price-above-max');
  });

  it('flags ROI above half the prize', () => {
    const { issues } = solveRaffle({
      prize: usdc('100'),
      entryPrice: usdc('1'),
      totalEntries: 151,
    });

    expect(issues.map((i) => i.code)).toEqual(['roi-above-max']);
  });

  it('allows ROI at exactly half the prize', () => {
    const { issues } = solveRaffle({
      prize: usdc('100'),
      entryPrice: usdc('1'),
      totalEntries: 150,
    });

    expect(issues).toEqual([]);
  });

  it('flags a pot that does not cover the prize', () => {
    const { config, issues } = solveRaffle({
      prize: usdc('100'),
      entryPrice: usdc('1'),
      totalEntries: 90,
    });

    expect(config.ownerRoi).toBe(usdc('-10'));
    expect(issues.map((i) => i.code)).toContain('roi-negative');
  });

  it('flags a sub-cent entry price', () => {
    const issues = validateRaffle({
      prize: usdc('10'),
      entryPrice: usdc('0.505'),
      totalEntries: 20,
      ownerRoi: usdc('0.1'),
    });

    expect(issues.map((i) => i.code)).toContain('entry-price-sub-cent');
  });

  it('honours custom bounds', () => {
    const relaxed = { ...DEFAULT_BOUNDS, totalEntries: { min: 2, max: 5 } };
    expect(
      validateRaffle(
        { prize: usdc('10'), entryPrice: usdc('4'), totalEntries: 3, ownerRoi: usdc('2') },
        relaxed,
      ),
    ).toEqual([]);
  });
});

describe('odds and the per-wallet cap', () => {
  it('keeps one wallet at or under 25% of the odds at any size (Section 11.3)', () => {
    expect(maxWalletOddsBps(DEFAULT_BOUNDS.totalEntries.min)).toBe(2000);
    for (let total = DEFAULT_BOUNDS.totalEntries.min; total <= 200; total += 1) {
      expect(maxWalletOddsBps(total), String(total)).toBeLessThanOrEqual(2500);
    }
  });

  it('allows a quarter of the draw, at least 1 and at most 5', () => {
    expect(walletCap(3)).toBe(1);
    expect(walletCap(10)).toBe(2);
    expect(walletCap(12)).toBe(3);
    expect(walletCap(16)).toBe(4);
    expect(walletCap(20)).toBe(5);
    expect(walletCap(10_000)).toBe(MAX_ENTRIES_PER_WALLET);
  });

  it('shrinks a whale as the raffle grows', () => {
    expect(maxWalletOddsBps(70)).toBe(714);
    expect(maxWalletOddsBps(10_000)).toBe(5);
  });

  it('never claims more than the whole raffle for a tiny one', () => {
    expect(maxWalletOddsBps(3)).toBe(3333);
    expect(maxWalletOddsBps(1)).toBe(10_000);
    expect(MAX_ENTRIES_PER_WALLET).toBe(5);
  });

  it('reports odds for a held position', () => {
    expect(oddsBps(2, 70)).toBe(286);
    expect(oddsBps(0, 70)).toBe(0);
    expect(oddsBps(1, 0)).toBe(0);
  });
});

describe('prize cover, Section 11.5', () => {
  const config = {
    prize: usdc('50'),
    entryPrice: usdc('1'),
    totalEntries: 70,
    ownerRoi: usdc('20'),
  };

  it('covers the prize at entry 50 of 70', () => {
    expect(entriesToCoverPrize(config.prize, config.entryPrice)).toBe(50);
    expect(isPrizeCovered(49, config)).toBe(false);
    expect(isPrizeCovered(50, config)).toBe(true);
  });

  it('rounds the cover point up when the price does not divide the prize', () => {
    // 50 / 3 = 16.67, so 17 entries are needed to be genuinely covered.
    expect(entriesToCoverPrize(usdc('50'), usdc('3'))).toBe(17);
  });
});

describe('the remaining guard rails', () => {
  it('flags an entry price under the floor', () => {
    const issues = validateRaffle({
      prize: usdc('10'),
      entryPrice: usdc('0.25'),
      totalEntries: 48,
      ownerRoi: usdc('2'),
    });

    expect(issues.map((i) => i.code)).toContain('entry-price-below-min');
  });

  it('flags more entries than the ceiling allows', () => {
    const { issues } = solveRaffle({
      prize: usdc('10000'),
      entryPrice: usdc('0.5'),
      totalEntries: 20_001,
    });

    expect(issues.map((i) => i.code)).toContain('entries-above-max');
  });

  it('flags a fractional entry count', () => {
    const issues = validateRaffle({
      prize: usdc('50'),
      entryPrice: usdc('1'),
      totalEntries: 70.5,
      ownerRoi: usdc('20.5'),
    });

    expect(issues.map((i) => i.code)).toContain('entries-not-integer');
  });

  it('catches a config where the identity simply does not hold', () => {
    // Hand-built, as the API might receive over the wire.
    const issues = validateRaffle({
      prize: usdc('50'),
      entryPrice: usdc('1'),
      totalEntries: 70,
      ownerRoi: usdc('19'),
    });

    expect(issues.map((i) => i.code)).toEqual(['identity-broken']);
  });

  it('refuses an entry count that would not survive being a JS number', () => {
    // At one base unit per entry the entry count equals the prize in base
    // units, so 10 billion USDC is 1e16 entries — past Number.MAX_SAFE_INTEGER.
    expect(() =>
      solveRaffle({ prize: usdc('10000000000'), entryPrice: 1n, targetRoi: 0n }),
    ).toThrow(/overflows a safe integer/);
  });

  it('treats a zero prize as zero ROI rather than dividing by it', () => {
    expect(roiBps({ prize: 0n, entryPrice: usdc('1'), totalEntries: 0, ownerRoi: 0n })).toBe(0);
  });
});

describe('ROI as a percentage, Section 7', () => {
  it('converts basis points against the prize', () => {
    expect(roiFromBps(usdc('50'), 4000)).toBe(usdc('20'));
    expect(roiFromBps(usdc('100'), 5000)).toBe(usdc('50'));
    expect(roiFromBps(usdc('50'), 0)).toBe(0n);
  });

  it('rounds down so the stated percentage is a ceiling', () => {
    // 1/3 of 10 USDC is 3.333..., which must not become 3.34.
    expect(roiFromBps(usdc('10'), 3333)).toBe(3_333_000n);
  });

  it('completes the prize-plus-entries flow that Section 7 left underdetermined', () => {
    const prize = usdc('50');
    const result = solveRaffle({ prize, totalEntries: 70, targetRoi: roiFromBps(prize, 4000) });

    expect(result.solvedFor).toBe('entryPrice');
    expect(result.config.entryPrice).toBe(usdc('1'));
    expect(roiBps(result.config)).toBe(4000);
    expect(result.issues).toEqual([]);
  });

  it('rejects a nonsense percentage', () => {
    expect(() => roiFromBps(usdc('50'), -1)).toThrow(RangeError);
    expect(() => roiFromBps(usdc('50'), 1.5)).toThrow(RangeError);
  });
});
