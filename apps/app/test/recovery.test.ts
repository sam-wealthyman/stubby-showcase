import { describe, expect, it } from 'vitest';

import {
  checkRecipient,
  diagnose,
  guidanceFor,
  recipientProblemMessage,
  type ClaimFailure,
} from '../src/chain/recovery.js';

/** Shaped like what viem throws: a wrapped revert with the custom error name. */
const revert = (name: string) =>
  new Error(
    `ContractFunctionExecutionError: The contract function "claim" reverted.\n\nError: ${name}()\n`,
  );

describe('diagnose', () => {
  it('reads a dismissed prompt as declined', () => {
    expect(diagnose(new Error('User rejected the request.'))).toBe('declined');
  });

  /**
   * Checked before the revert names on purpose.
   *
   * A dismissal can carry a revert reason from simulation, and telling a user
   * their claim failed when they simply closed the wallet is the wrong story.
   */
  it('prefers declined over a revert reason carried alongside it', () => {
    const both = new Error('UserRejectedRequestError: ... Error: NotTheWinner()');
    expect(diagnose(both)).toBe('declined');
  });

  it('names each contract error', () => {
    expect(diagnose(revert('NotTheWinner'))).toBe('not-the-winner');
    expect(diagnose(revert('PrizeAlreadyPaid'))).toBe('already-paid');
    expect(diagnose(revert('NotCompleted'))).toBe('not-completed');
    expect(diagnose(revert('ZeroAddress'))).toBe('zero-address');
  });

  it('reads a token-level transfer failure as a refused recipient', () => {
    // Arc's USDC gives no named error for a blocklisted address, so this is
    // matched on what the failure looks like from outside.
    expect(diagnose(new Error('SafeERC20: ERC20 operation did not succeed'))).toBe(
      'recipient-refused',
    );
    expect(diagnose(new Error('execution reverted: transfer not allowed'))).toBe(
      'recipient-refused',
    );
  });

  it('reads anything else as unknown rather than guessing', () => {
    expect(diagnose(new Error('nonce too low'))).toBe('unknown');
    expect(diagnose('something odd')).toBe('unknown');
    expect(diagnose(undefined)).toBe('unknown');
  });

  it('looks at the cause as well as the message', () => {
    const wrapped = new Error('transaction failed');
    wrapped.cause = revert('NotTheWinner');
    expect(diagnose(wrapped)).toBe('not-the-winner');
  });
});

describe('guidanceFor', () => {
  const all: ClaimFailure[] = [
    'declined',
    'not-the-winner',
    'already-paid',
    'not-completed',
    'zero-address',
    'recipient-refused',
    'unknown',
  ];

  /**
   * Section 12.2, and it matters most here.
   *
   * This is the screen someone reaches when their prize did not arrive. The
   * first sentence has to say the prize is not gone, because that is the fear.
   */
  it('leads with what is safe for every failure', () => {
    for (const failure of all) {
      const { safe } = guidanceFor(failure);
      expect(safe, failure).toMatch(/safe|untouched|nothing|already been paid|not finished/i);
    }
  });

  it('offers a redirect only where one would help', () => {
    // Retrying a blocklisted recipient forever is the trap this avoids.
    expect(guidanceFor('recipient-refused')).toMatchObject({
      offerRedirect: true,
      offerRetry: false,
    });
    // Wrong wallet: neither retry nor redirect helps, switching wallets does.
    expect(guidanceFor('not-the-winner')).toMatchObject({
      offerRedirect: false,
      offerRetry: false,
    });
    expect(guidanceFor('already-paid').offerRedirect).toBe(false);
  });

  it('offers a plain retry after a dismissal', () => {
    expect(guidanceFor('declined')).toMatchObject({ offerRetry: true, offerRedirect: false });
  });

  it('offers both when it does not know', () => {
    expect(guidanceFor('unknown')).toMatchObject({ offerRetry: true, offerRedirect: true });
  });

  it('sends a refused recipient elsewhere rather than retrying', () => {
    expect(guidanceFor('recipient-refused').fix).toMatch(/another address/i);
  });
});

describe('checkRecipient', () => {
  const WINNER = '0x55715594636e32E5da4Cb27236da7c811418a833';

  it('accepts an address', () => {
    expect(checkRecipient(WINNER).address).toBe(WINNER);
  });

  it('tolerates whitespace from pasting', () => {
    expect(checkRecipient(`  ${WINNER}\n`).address).toBe(WINNER);
  });

  /**
   * Unlike the treasury field, "same as before" is fine here.
   *
   * The winner's own address is a perfectly good recipient — that is just a
   * claim. Rejecting it would block the action that most often works.
   */
  it('accepts the winner"s own address', () => {
    expect(checkRecipient(WINNER).problem).toBeUndefined();
  });

  it('asks for a value when empty', () => {
    expect(checkRecipient('').problem).toBe('empty');
    expect(checkRecipient('   ').problem).toBe('empty');
  });

  it('rejects a malformed address', () => {
    for (const bad of ['0x123', WINNER.slice(0, -1), `${WINNER}ff`, 'nope']) {
      expect(checkRecipient(bad).problem, bad).toBe('malformed');
    }
  });

  it('rejects the zero address, which would destroy the prize', () => {
    expect(checkRecipient(`0x${'0'.repeat(40)}`).problem).toBe('zero');
    expect(recipientProblemMessage('zero')).toMatch(/destroy/i);
  });
});
