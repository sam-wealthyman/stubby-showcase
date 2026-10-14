/**
 * Changing who owns the contract, and where commission goes.
 *
 * Two different risks wearing similar shapes, which is the reason this module
 * exists rather than the screen validating inline.
 *
 * **`setTreasury` takes effect immediately and is one transaction.** Get it
 * wrong and the next `withdrawCommission` pays a stranger. It is recoverable
 * only in the sense that you can set it again — the money already sent is gone.
 *
 * **`transferOwnership` is two steps and is therefore forgiving.** The contract
 * is `Ownable2Step`, so a transfer only nominates; ownership moves when the new
 * address calls `acceptOwnership`. A typo nominates an address that can never
 * accept, the current owner keeps everything, and the nomination can simply be
 * replaced. That asymmetry is worth telling the owner about, because the
 * dangerous-looking button is the safe one.
 *
 * Pure. No chain, no wallet, no renderer.
 */

import { getAddress, isAddress } from 'viem';

export type AddressProblem =
  | 'empty'
  | 'malformed'
  /** `address(0)`. The contract reverts, and for treasury it would burn money. */
  | 'zero'
  /** Already this value, so the transaction would cost gas and change nothing. */
  | 'unchanged';

export interface AddressCheck {
  /** Checksummed, ready to send. Only set when there is no problem. */
  address?: `0x${string}`;
  problem?: AddressProblem;
}

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Validate an address the owner typed.
 *
 * Returns the **checksummed** form, not what was typed. EIP-55 casing is a
 * checksum, and normalising here means a comparison against the current value
 * cannot miss because one side was pasted lower-case.
 */
export function checkAddress(input: string, current?: string): AddressCheck {
  const trimmed = input.trim();
  if (trimmed === '') return { problem: 'empty' };
  if (!isAddress(trimmed, { strict: false })) return { problem: 'malformed' };

  const address = getAddress(trimmed);
  if (address === ZERO) return { problem: 'zero' };
  if (current !== undefined && address.toLowerCase() === current.toLowerCase()) {
    return { problem: 'unchanged' };
  }
  return { address };
}

export function addressProblemMessage(problem: AddressProblem, what: string): string {
  switch (problem) {
    case 'empty':
      return `Paste the new ${what}.`;
    case 'malformed':
      return "That isn't a valid address. It should be 0x followed by 40 letters and numbers.";
    case 'zero':
      return `The zero address cannot be the ${what}. The contract would refuse it, and commission sent there is destroyed.`;
    case 'unchanged':
      return `That's already the ${what}. Nothing to do.`;
  }
}

/** Shortened for display. The middle is the part nobody checks. */
export function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Where an ownership handover has got to.
 *
 * `pendingOwner` being set is not a problem — it is the middle of a deliberate
 * two-step change, and the screen should say so rather than look alarmed.
 */
export type HandoverState =
  | { kind: 'settled' }
  /** Nominated, waiting for that address to accept. */
  | { kind: 'awaiting-acceptance'; pending: `0x${string}` }
  /** The connected wallet is the nominee and can complete it. */
  | { kind: 'yours-to-accept'; pending: `0x${string}` };

export function handoverState(
  pendingOwner: string | undefined,
  connected: string | undefined,
): HandoverState {
  if (pendingOwner === undefined || pendingOwner === ZERO) return { kind: 'settled' };
  const pending = getAddress(pendingOwner);
  if (connected !== undefined && connected.toLowerCase() === pending.toLowerCase()) {
    return { kind: 'yours-to-accept', pending };
  }
  return { kind: 'awaiting-acceptance', pending };
}
