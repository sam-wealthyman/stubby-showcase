/**
 * Can this wallet afford to transact?
 *
 * The Connect screen's third blocking state (Section 12.6) is "not enough USDC
 * for gas", and on Arc that sentence hides the project's sharpest trap: gas is
 * paid in the **native 18-decimal view** of USDC, while every amount the user
 * ever sees is the **6-decimal ERC-20 view**. They are one balance in two
 * denominations, and comparing one to the other is off by 10^12 — which, for a
 * gas check, reads as "you have a trillion times enough" and lets the user
 * through to a transaction that cannot pay for itself.
 *
 * So this module takes native units, says so in every name, and converts once
 * at the edge for display. Nothing here is a React concern, which is the point:
 * it can be tested without a wallet, a chain or a renderer.
 */

import { MIN_BASE_FEE_GWEI, NATIVE_PER_USDC_UNIT, nativeToUsdc } from '@stubby/shared';

/** One gwei in native base units. */
export const GWEI = 1_000_000_000n;

/**
 * The fee per gas to budget with.
 *
 * Section 10: Arc's mempool silently DROPS transactions under a 20 gwei
 * `maxFeePerGas` — no error, the transaction simply never appears. So the floor
 * is not a suggestion to price near, it is the minimum that works, and budgeting
 * below it would clear a user to send something the network throws away.
 */
export const FLOOR_FEE_PER_GAS = BigInt(MIN_BASE_FEE_GWEI) * GWEI;

/**
 * Gas to budget for buying entries: an ERC-20 `approve`, then `enter`.
 *
 * **This is a budget, not a measurement.** The contract's gas snapshot records
 * whole test cases, not single calls, so there is no measured figure for `enter`
 * yet; this is a deliberately generous allowance until one exists. It is used
 * only to decide whether to show a warning, never to set a transaction's gas
 * limit, so erring high costs a user nothing but an early nudge to top up.
 *
 * At the 20 gwei floor this is 0.005 USDC, which is the useful thing to know:
 * the threshold is tiny, and a wallet that fails it has essentially no balance.
 */
export const ENTRY_GAS_BUDGET = 250_000n;

export interface GasVerdict {
  /** Does the balance cover the budgeted transaction? */
  sufficient: boolean;
  /** What it would cost, in native base units. */
  costNative: bigint;
  /**
   * The shortfall in **ERC-20 base units**, ready to format, or 0n when there
   * is none. Rounded UP: a shortfall that truncates to zero would render as
   * "you need 0 more USDC", which reads as a bug.
   */
  shortfallUsdc: bigint;
}

export interface GasCheck {
  /** The wallet's native balance, 18 decimals. From `useBalance`, not the ERC-20 read. */
  balanceNative: bigint;
  /** Gas units to budget. Defaults to buying entries. */
  gasLimit?: bigint;
  /** Fee per gas. Defaults to Arc's mempool floor. */
  feePerGas?: bigint;
}

/** Round a native amount up to whole ERC-20 base units. */
function nativeToUsdcCeil(nativeUnits: bigint): bigint {
  const truncated = nativeToUsdc(nativeUnits);
  return nativeUnits % NATIVE_PER_USDC_UNIT === 0n ? truncated : truncated + 1n;
}

export function checkGas({
  balanceNative,
  gasLimit = ENTRY_GAS_BUDGET,
  feePerGas = FLOOR_FEE_PER_GAS,
}: GasCheck): GasVerdict {
  const costNative = gasLimit * feePerGas;
  const sufficient = balanceNative >= costNative;
  return {
    sufficient,
    costNative,
    shortfallUsdc: sufficient ? 0n : nativeToUsdcCeil(costNative - balanceNative),
  };
}
