/**
 * When a claim will not go through.
 *
 * Section 6.1 designs for this: `_claim` marks the prize paid and transfers it
 * **in the same transaction**, so a failed transfer reverts the bookkeeping with
 * it. A claim that fails is a no-op — the prize stays owed, stays claimable, and
 * there is no deadline and no limit on retries. That is the single most
 * important thing to tell someone whose claim just failed, and the reason this
 * screen can be calm.
 *
 * The one failure a retry cannot fix is a recipient the token refuses. Arc's
 * USDC reverts transfers to blocklisted addresses, so a winner whose own wallet
 * is blocklisted would retry forever. `claimTo` exists for exactly that, and
 * only the winning wallet can authorise it.
 *
 * Pure. No chain, no wallet, no renderer.
 */

export type ClaimFailure =
  /** The wallet prompt was dismissed. Nothing was attempted. */
  | 'declined'
  /** `NotTheWinner` — the connected wallet is not the one that won. */
  | 'not-the-winner'
  /** `PrizeAlreadyPaid` — it has already been paid out. */
  | 'already-paid'
  /** `NotCompleted` — the draw has not finished. */
  | 'not-completed'
  /** `ZeroAddress` — the recipient was `address(0)`. */
  | 'zero-address'
  /**
   * The transfer itself reverted. On Arc this is the blocklist case, and it is
   * the only failure a plain retry cannot fix.
   */
  | 'recipient-refused'
  /** Something else. Retry is still safe, because a failed claim changes nothing. */
  | 'unknown';

/**
 * Work out why a claim failed, from whatever the wallet threw.
 *
 * Matched on the contract's own custom error names, which is why they are worth
 * having: `NotTheWinner` tells the user to switch wallets, and a generic
 * "transaction failed" does not. Order matters — a dismissal can carry a
 * revert reason from simulation, so it is checked first.
 */
export function diagnose(error: unknown): ClaimFailure {
  const text =
    error instanceof Error
      ? `${error.name} ${error.message} ${String(error.cause ?? '')}`
      : String(error);

  if (/rejected|denied|declined|cancell?ed|UserRejected/i.test(text)) return 'declined';
  if (/NotTheWinner/.test(text)) return 'not-the-winner';
  if (/PrizeAlreadyPaid/.test(text)) return 'already-paid';
  if (/NotCompleted/.test(text)) return 'not-completed';
  if (/ZeroAddress/.test(text)) return 'zero-address';

  /*
   * A revert from inside the token rather than from the raffle.
   *
   * Arc's USDC gives no named error for a blocklisted recipient, so this is
   * matched on what a token transfer failure looks like. Deliberately last
   * among the specific cases: a false positive here would send someone to
   * redirect a prize when a plain retry would have worked.
   */
  if (/SafeERC20|transfer|blocklist|blacklist|not allowed/i.test(text)) return 'recipient-refused';

  return 'unknown';
}

export interface Guidance {
  /** What is safe. Section 12.2: this comes first, always. */
  safe: string;
  /** What to do about it. */
  fix: string;
  /** Would sending to a different address help? */
  offerRedirect: boolean;
  /** Is a plain retry worth offering? */
  offerRetry: boolean;
}

export function guidanceFor(failure: ClaimFailure): Guidance {
  switch (failure) {
    case 'declined':
      return {
        safe: 'Nothing was attempted and your prize is untouched.',
        fix: 'Claim again whenever you are ready. There is no deadline.',
        offerRetry: true,
        offerRedirect: false,
      };
    case 'not-the-winner':
      return {
        safe: "Your prize is safe, but this isn't the wallet that won.",
        fix: 'Connect the winning wallet. Only that wallet can claim.',
        offerRetry: false,
        offerRedirect: false,
      };
    case 'already-paid':
      return {
        safe: "This prize has already been paid out. There's nothing left to claim.",
        fix: 'Check the receiving wallet. The draw page shows the payout.',
        offerRetry: false,
        offerRedirect: false,
      };
    case 'not-completed':
      return {
        safe: "Nothing is wrong. This draw just hasn't finished yet.",
        fix: 'You can claim the prize once the winner is picked.',
        offerRetry: false,
        offerRedirect: false,
      };
    case 'zero-address':
      return {
        safe: 'The contract refused this, so nothing was sent.',
        fix: "That address can't receive payments. Please use a different one.",
        offerRetry: false,
        offerRedirect: true,
      };
    case 'recipient-refused':
      return {
        safe: 'Your prize is safe and still owed.',
        fix: "USDC can't be sent to this address (it may be blocked). Send it to another address you control.",
        offerRetry: false,
        offerRedirect: true,
      };
    case 'unknown':
      return {
        safe: 'Your prize is safe and still owed.',
        fix: 'Try again, or send it to another address.',
        offerRetry: true,
        offerRedirect: true,
      };
  }
}

/**
 * Check a redirect recipient.
 *
 * Unlike the treasury, the winner's **own** address is a perfectly good
 * recipient here — that is just a claim. So "same as before" is not a problem,
 * and saying it was would block the one action that often works.
 */
export type RecipientProblem = 'empty' | 'malformed' | 'zero';

export function checkRecipient(input: string): {
  address?: `0x${string}`;
  problem?: RecipientProblem;
} {
  const trimmed = input.trim();
  if (trimmed === '') return { problem: 'empty' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return { problem: 'malformed' };
  if (/^0x0{40}$/i.test(trimmed)) return { problem: 'zero' };
  return { address: trimmed as `0x${string}` };
}

export function recipientProblemMessage(problem: RecipientProblem): string {
  switch (problem) {
    case 'empty':
      return 'Paste the address to send the prize to.';
    case 'malformed':
      return "That isn't a valid address. It should be 0x followed by 40 letters and numbers.";
    case 'zero':
      return 'The zero address would destroy the prize. The contract refuses it.';
  }
}
