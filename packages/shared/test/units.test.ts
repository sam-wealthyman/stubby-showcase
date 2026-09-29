import { describe, expect, it } from 'vitest';

import {
  NATIVE_DECIMALS,
  NATIVE_PER_USDC_UNIT,
  NATIVE_UNIT,
  USDC_CENT,
  USDC_DECIMALS,
  USDC_UNIT,
  UsdcParseError,
  compactNumber,
  formatUsdc,
  formatUsdcCompact,
  isWholeCents,
  nativeToUsdc,
  parseUsdc,
  usdcToNative,
} from '../src/units.js';

describe("Arc's two views of one USDC balance", () => {
  it('uses the 6-decimal ERC-20 view for amounts, because that is what contracts move', () => {
    expect(USDC_DECIMALS).toBe(6);
    expect(USDC_UNIT).toBe(1_000_000n);
    expect(parseUsdc('1')).toBe(USDC_UNIT);
    expect(USDC_CENT).toBe(10_000n);
  });

  it('keeps the native gas view at 18 decimals', () => {
    expect(NATIVE_DECIMALS).toBe(18);
    expect(NATIVE_UNIT).toBe(1_000_000_000_000_000_000n);
  });

  it('separates the two views by exactly 1e12', () => {
    expect(NATIVE_PER_USDC_UNIT).toBe(1_000_000_000_000n);
    expect(usdcToNative(parseUsdc('1'))).toBe(NATIVE_UNIT);
    expect(nativeToUsdc(NATIVE_UNIT)).toBe(parseUsdc('1'));
  });

  it('round-trips an ERC-20 amount through the native view', () => {
    for (const value of ['0', '0.01', '1', '50', '10000']) {
      expect(nativeToUsdc(usdcToNative(parseUsdc(value)))).toBe(parseUsdc(value));
    }
  });

  it('truncates when narrowing a native gas figure, which display can tolerate', () => {
    // 0.0000001 USDC of gas is below what the ERC-20 view can express.
    expect(nativeToUsdc(100_000_000_000n)).toBe(0n);
    expect(nativeToUsdc(1_500_000_000_000n)).toBe(1n);
  });

  it('keeps full precision at the smallest ERC-20 unit', () => {
    expect(parseUsdc('0.000001')).toBe(1n);
    expect(formatUsdc(1n)).toBe('0.000001');
  });
});

describe('parseUsdc', () => {
  it('parses whole and fractional amounts', () => {
    expect(parseUsdc('0')).toBe(0n);
    expect(parseUsdc('0.5')).toBe(USDC_UNIT / 2n);
    expect(parseUsdc('24.50')).toBe(24_500_000n);
    expect(parseUsdc('10000')).toBe(10_000n * USDC_UNIT);
  });

  it('tolerates surrounding whitespace and a sign', () => {
    expect(parseUsdc('  7.25  ')).toBe(parseUsdc('7.25'));
    expect(parseUsdc('-3')).toBe(-3n * USDC_UNIT);
  });

  it('rejects anything that is not a plain decimal', () => {
    for (const bad of ['', '.5', '5.', '1e18', '1,000', '0x10', 'abc', '1.2.3', ' ']) {
      expect(() => parseUsdc(bad), bad).toThrow(UsdcParseError);
    }
  });

  it('rejects more precision than the ERC-20 interface has', () => {
    expect(() => parseUsdc('0.0000001')).toThrow(/Too many decimal places/);
  });
});

describe('formatUsdc', () => {
  it('trims trailing zeros by default so prizes read as whole numbers', () => {
    expect(formatUsdc(parseUsdc('50'))).toBe('50');
    expect(formatUsdc(parseUsdc('50.00'))).toBe('50');
    expect(formatUsdc(parseUsdc('24.50'))).toBe('24.5');
    expect(formatUsdc(0n)).toBe('0');
  });

  it('pads to a fixed width when asked, for aligned tabular figures', () => {
    expect(formatUsdc(parseUsdc('24.5'), { decimals: 2 })).toBe('24.50');
    expect(formatUsdc(parseUsdc('50'), { decimals: 2 })).toBe('50.00');
    expect(formatUsdc(parseUsdc('50'), { decimals: 0 })).toBe('50');
  });

  it('truncates rather than rounds at a fixed width', () => {
    expect(formatUsdc(parseUsdc('0.999'), { decimals: 2 })).toBe('0.99');
  });

  it('handles negatives, but not a negative zero', () => {
    expect(formatUsdc(parseUsdc('-10.25'))).toBe('-10.25');
    expect(formatUsdc(-0n)).toBe('0');
  });

  it('round-trips every amount the admin dashboard can produce', () => {
    for (const value of ['0', '0.5', '1', '10', '99.99', '100', '10000', '0.01']) {
      expect(formatUsdc(parseUsdc(value), { decimals: 2 })).toBe(Number(value).toFixed(2));
    }
  });

  it('rejects an impossible width', () => {
    expect(() => formatUsdc(0n, { decimals: 7 })).toThrow(RangeError);
    expect(() => formatUsdc(0n, { decimals: -1 })).toThrow(RangeError);
  });
});

describe('isWholeCents', () => {
  it('accepts cent amounts and rejects finer ones', () => {
    expect(isWholeCents(parseUsdc('0.5'))).toBe(true);
    expect(isWholeCents(parseUsdc('0.01'))).toBe(true);
    expect(isWholeCents(parseUsdc('0.001'))).toBe(false);
  });
});

describe('compactNumber', () => {
  it('leaves anything under a thousand alone', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(999)).toBe('999');
    expect(compactNumber(-42)).toBe('-42');
  });

  it('uses k, M, B and T, with one decimal only below ten', () => {
    expect(compactNumber(1_000)).toBe('1k');
    expect(compactNumber(1_250)).toBe('1.2k');
    expect(compactNumber(12_345)).toBe('12k');
    expect(compactNumber(999_999)).toBe('999k');
    expect(compactNumber(1_500_000n)).toBe('1.5M');
    expect(compactNumber(3_000_000_000n)).toBe('3B');
    expect(compactNumber(7_100_000_000_000n)).toBe('7.1T');
  });

  it('never rounds a figure up', () => {
    expect(compactNumber(1_999)).toBe('1.9k');
    expect(compactNumber(9_999_999)).toBe('9.9M');
  });
});

describe('formatUsdcCompact', () => {
  it('is exact below 1,000 USDC', () => {
    expect(formatUsdcCompact(5_000_000n)).toBe('5');
    expect(formatUsdcCompact(999_990_000n, { decimals: 2 })).toBe('999.99');
  });

  it('is compact from 1,000 USDC, in whole USDC', () => {
    expect(formatUsdcCompact(1_000_000_000n)).toBe('1k');
    expect(formatUsdcCompact(1_234_560_000n, { decimals: 2 })).toBe('1.2k');
    expect(formatUsdcCompact(2_500_000_000_000n)).toBe('2.5M');
  });
});
