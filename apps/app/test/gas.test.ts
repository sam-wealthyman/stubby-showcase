import { describe, expect, it } from 'vitest';

import { ENTRY_GAS_BUDGET, FLOOR_FEE_PER_GAS, GWEI, checkGas } from '../src/wallet/gas.js';

/** 1 USDC in the native 18-decimal view. */
const ONE_USDC_NATIVE = 10n ** 18n;
/** 1 USDC in the 6-decimal ERC-20 view. */
const ONE_USDC_ERC20 = 10n ** 6n;

describe('checkGas', () => {
  it('budgets at Arc"s 20 gwei mempool floor', () => {
    // Below this the mempool drops the transaction with no error at all, so the
    // floor is the minimum that works rather than a price to undercut.
    expect(FLOOR_FEE_PER_GAS).toBe(20n * GWEI);
  });

  it('puts the whole budget well under a cent of USDC', () => {
    const { costNative } = checkGas({ balanceNative: 0n });
    // 250,000 gas x 20 gwei = 5e15 native = 0.005 USDC.
    expect(costNative).toBe(5_000_000_000_000_000n);
    expect(costNative * 200n).toBe(ONE_USDC_NATIVE);
  });

  it('clears a wallet holding exactly the cost', () => {
    const cost = ENTRY_GAS_BUDGET * FLOOR_FEE_PER_GAS;
    expect(checkGas({ balanceNative: cost }).sufficient).toBe(true);
    expect(checkGas({ balanceNative: cost - 1n }).sufficient).toBe(false);
  });

  it('reports no shortfall when the balance is enough', () => {
    expect(checkGas({ balanceNative: ONE_USDC_NATIVE }).shortfallUsdc).toBe(0n);
  });

  /**
   * The test this module exists for.
   *
   * A wallet holding 0.001 USDC has 1e15 native units and 1_000 ERC-20 units.
   * The budget costs 5e15 native. Compared correctly it is short. Compared in
   * the wrong denomination — 1e15 against a cost read as if it were ERC-20 —
   * the balance looks a trillion times too large and the check passes, sending
   * the user to a transaction that cannot pay for itself.
   */
  it('does not mistake an ERC-20 balance for a native one', () => {
    const balanceNative = ONE_USDC_NATIVE / 1000n;
    expect(checkGas({ balanceNative }).sufficient).toBe(false);

    // The same quantity of money, written in the other view, is not a balance
    // that can pay for anything — and would wrongly pass a naive comparison.
    const sameMoneyErc20 = ONE_USDC_ERC20 / 1000n;
    expect(sameMoneyErc20).toBeLessThan(balanceNative);
    expect(checkGas({ balanceNative: sameMoneyErc20 }).sufficient).toBe(false);
  });

  it('rounds a shortfall up, so it never reads as needing zero more', () => {
    // One native unit short: a truncating conversion gives 0 ERC-20 units and
    // the screen says "you need 0 more USDC", which reads as a bug.
    const cost = ENTRY_GAS_BUDGET * FLOOR_FEE_PER_GAS;
    const { shortfallUsdc } = checkGas({ balanceNative: cost - 1n });
    expect(shortfallUsdc).toBe(1n);
  });

  it('reports a large shortfall in whole ERC-20 units', () => {
    // Empty wallet: short by the entire 0.005 USDC cost, which is 5000 units.
    expect(checkGas({ balanceNative: 0n }).shortfallUsdc).toBe(5_000n);
  });

  it('accepts a measured gas limit and fee in place of the budget', () => {
    const verdict = checkGas({
      balanceNative: 2n * GWEI * 21_000n,
      gasLimit: 21_000n,
      feePerGas: 2n * GWEI,
    });
    expect(verdict.sufficient).toBe(true);
  });
});
