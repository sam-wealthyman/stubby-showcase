/**
 * USDC amounts on Arc.
 *
 * Arc has **two views of the same USDC**, and mixing them is a 10^12 error:
 *
 * | View                            | Decimals | Used by                        |
 * | ------------------------------- | -------- | ------------------------------ |
 * | native gas token, `msg.value`   | 18       | raw gas math only              |
 * | ERC-20 at `0x3600…0000`         | 6        | `approve`, `transferFrom`, etc |
 *
 * They are not two tokens; they are two denominations of one balance, and
 * `1e18` native is `1e6` ERC-20. Circle's guidance is to keep amounts in the
 * 6-decimal ERC-20 view everywhere except gas, and to be explicit about which
 * view a value is in.
 *
 * So: **every amount in this package is the 6-decimal ERC-20 view**, because
 * that is the interface the raffle contract moves money through. The native
 * view appears only in `nativeToUsdc` / `usdcToNative`, for reading a gas
 * figure or a raw balance.
 *
 * All amounts are `bigint` base units, so no floating point touches the money
 * path anywhere in the app, the API or the contract.
 */

/** Decimals of the ERC-20 interface, which is the one contracts use. */
export const USDC_DECIMALS = 6;

/** 1 USDC in ERC-20 base units. */
export const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS);

/** 0.01 USDC. The smallest increment the admin dashboard accepts. */
export const USDC_CENT = USDC_UNIT / 100n;

/** Decimals of the native gas token. Gas math only. */
export const NATIVE_DECIMALS = 18;

/** 1 USDC in native base units. */
export const NATIVE_UNIT = 10n ** BigInt(NATIVE_DECIMALS);

/** The factor between the two views: `1e18` native is `1e6` ERC-20. */
export const NATIVE_PER_USDC_UNIT = NATIVE_UNIT / USDC_UNIT;

export class UsdcParseError extends Error {
  override readonly name = 'UsdcParseError';
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal string into USDC base units (the 6-decimal ERC-20 view).
 *
 * Deliberately rejects anything that is not a plain decimal — no exponents, no
 * thousands separators, no bare `.5` — because these values come from admin
 * input and a silent misparse moves real money.
 */
export function parseUsdc(value: string): bigint {
  const match = DECIMAL.exec(value.trim());
  if (!match) {
    throw new UsdcParseError(`Not a plain decimal amount: ${JSON.stringify(value)}`);
  }
  const [, sign, whole, frac = ''] = match as unknown as [string, string, string, string?];
  if (frac.length > USDC_DECIMALS) {
    throw new UsdcParseError(
      `Too many decimal places: ${frac.length}, the USDC ERC-20 interface has ${USDC_DECIMALS}`,
    );
  }
  const units = BigInt(whole) * USDC_UNIT + BigInt(frac.padEnd(USDC_DECIMALS, '0') || '0');
  return sign === '-' ? -units : units;
}

/**
 * Format base units as a decimal string.
 *
 * With no `decimals` option, trailing zeros are trimmed, so 50 USDC renders as
 * `"50"` rather than `"50.00"` — which is what the prize numerals want.
 */
export function formatUsdc(value: bigint, options: { decimals?: number } = {}): string {
  const { decimals } = options;
  if (decimals !== undefined && (decimals < 0 || decimals > USDC_DECIMALS)) {
    throw new RangeError(`decimals must be between 0 and ${USDC_DECIMALS}`);
  }

  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / USDC_UNIT;
  const frac = (abs % USDC_UNIT).toString().padStart(USDC_DECIMALS, '0');

  let shown = decimals === undefined ? frac.replace(/0+$/, '') : frac.slice(0, decimals);
  if (decimals !== undefined && decimals > 0) shown = shown.padEnd(decimals, '0');

  const text = shown.length > 0 ? `${whole}.${shown}` : `${whole}`;
  return negative && abs !== 0n ? `-${text}` : text;
}

const COMPACT_UNITS: readonly [bigint, string][] = [
  [1_000_000_000_000n, 'T'],
  [1_000_000_000n, 'B'],
  [1_000_000n, 'M'],
  [1_000n, 'k'],
];

/**
 * A count for tight spaces: 999 stays 999, then 1k, 1.2k, 12k, 1.2M, 3B.
 *
 * One decimal below ten of a unit, none above. **Truncates**, never rounds up:
 * 1,999 is 1.9k, so a figure never reads as more than it is — which matters
 * most when it is money.
 */
export function compactNumber(value: number | bigint): string {
  const n = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const sign = negative ? '-' : '';
  for (const [unit, suffix] of COMPACT_UNITS) {
    if (abs < unit) continue;
    const tenths = (abs * 10n) / unit;
    if (tenths >= 100n) return `${sign}${abs / unit}${suffix}`;
    const whole = tenths / 10n;
    const tenth = tenths % 10n;
    return `${sign}${whole}${tenth === 0n ? '' : `.${tenth}`}${suffix}`;
  }
  return `${sign}${abs}`;
}

/**
 * `formatUsdc` for display: exact below 1,000 USDC, compact from there
 * (1.2k, 25k, 1.5M). Amounts the user is about to send stay on `formatUsdc`,
 * where every cent is the point.
 */
export function formatUsdcCompact(value: bigint, options: { decimals?: number } = {}): string {
  const abs = value < 0n ? -value : value;
  if (abs < 1_000n * USDC_UNIT) return formatUsdc(value, options);
  return compactNumber(value / USDC_UNIT);
}

/** True when `value` is a whole number of cents. */
export function isWholeCents(value: bigint): boolean {
  return value % USDC_CENT === 0n;
}

/**
 * Convert a native amount (18 decimals, e.g. a gas figure) to the ERC-20 view.
 *
 * Truncates, because the native view is finer. A gas cost of less than
 * 0.000001 USDC therefore reads as 0, which is correct for display but must
 * not be used for accounting.
 */
export function nativeToUsdc(nativeUnits: bigint): bigint {
  return nativeUnits / NATIVE_PER_USDC_UNIT;
}

/** Convert an ERC-20 amount to the native view. Exact in this direction. */
export function usdcToNative(usdcUnits: bigint): bigint {
  return usdcUnits * NATIVE_PER_USDC_UNIT;
}
