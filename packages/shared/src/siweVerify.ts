/**
 * Verifying a signed SIWE message (Section 4.1).
 *
 * `siwe.ts` builds and checks the *message*. This checks the *signature*, and
 * the two are deliberately separate: the message rules need no crypto and no
 * network, so they stay testable and dependency-free, while this needs both.
 *
 * It lives here rather than in the API because viem became a dependency of this
 * package when the contract client landed. Before that, keeping keccak out of
 * the app bundle was the argument for putting verification in the API; that
 * argument is gone, and one implementation both sides share is better than two.
 *
 * **Verification is two independent checks and both are required.** A valid
 * signature over a message nobody validated proves only that somebody signed
 * something. A validated message with no signature proves nothing at all.
 * `verifySiweSignature` does both and will not let a caller do one.
 */

import { verifyMessage, type Address, type PublicClient } from 'viem';

import {
  SiweParseError,
  parseSiweMessage,
  validateSiweMessage,
  type SiweExpectation,
  type SiweFailure,
  type SiweMessage,
} from './siwe.js';

export interface SiweVerifyInput {
  /** The exact text the wallet signed. Not a re-rendered copy. */
  message: string;
  signature: `0x${string}`;
  expected: SiweExpectation;
  /**
   * A chain client, which enables smart-contract wallets.
   *
   * Without it only plain key-pair wallets can sign in. With it, viem also
   * tries ERC-1271, which is how Safe and other contract accounts sign. Section
   * 4.2 says any EVM wallet, so production should always pass one.
   */
  client?: PublicClient;
}

export type SiweVerifyResult =
  | { valid: true; address: Address; message: SiweMessage }
  | { valid: false; reason: 'malformed'; detail: string }
  | { valid: false; reason: 'message-rejected'; failures: readonly SiweFailure[] }
  | { valid: false; reason: 'bad-signature' };

/**
 * Verify a sign-in attempt.
 *
 * The order matters. The message is parsed and validated *before* the signature
 * is checked, because signature recovery is the expensive step and an attacker
 * should not be able to make the server do it by posting rubbish. It also means
 * a rejected attempt reports what was actually wrong rather than a generic
 * failure.
 *
 * Never throws for an invalid attempt: a caller that handles failure with a
 * try/catch tends to end up treating an unexpected error as a success.
 */
export async function verifySiweSignature({
  message,
  signature,
  expected,
  client,
}: SiweVerifyInput): Promise<SiweVerifyResult> {
  let parsed: SiweMessage;
  try {
    parsed = parseSiweMessage(message);
  } catch (error) {
    return {
      valid: false,
      reason: 'malformed',
      detail: error instanceof SiweParseError ? error.message : String(error),
    };
  }

  const failures = validateSiweMessage(parsed, expected);
  if (failures.length > 0) return { valid: false, reason: 'message-rejected', failures };

  let ok: boolean;
  try {
    ok = await verifyMessage({
      address: parsed.address as Address,
      message,
      signature,
      // Passing the client lets viem fall back to ERC-1271 for contract wallets.
      ...(client ? { client } : {}),
    } as Parameters<typeof verifyMessage>[0]);
  } catch {
    // A malformed signature, or an ERC-1271 call that reverted. Both are just
    // "not verified" — there is nothing the caller can usefully distinguish.
    return { valid: false, reason: 'bad-signature' };
  }

  if (!ok) return { valid: false, reason: 'bad-signature' };
  return { valid: true, address: parsed.address as Address, message: parsed };
}

/**
 * Somewhere to keep issued nonces.
 *
 * A nonce is only worth having if it can be used once. That requires state the
 * server controls, which is why this is an interface: the API will back it with
 * Postgres, tests use memory, and neither should know about the other.
 */
export interface NonceStore {
  /** Record a freshly issued nonce. */
  issue(nonce: string, expiresAt: Date): Promise<void>;
  /**
   * Consume a nonce, returning whether it was valid and unused.
   *
   * Must be atomic. Two simultaneous sign-ins with the same nonce must not both
   * succeed, which is the whole point.
   */
  consume(nonce: string, now?: Date): Promise<boolean>;
}

/**
 * A nonce store in memory.
 *
 * For tests and local development. Not for more than one process, and not for
 * anything that restarts — a forgotten nonce is a sign-in that fails, and a
 * remembered one after a restart is a replay window.
 */
export function createMemoryNonceStore(): NonceStore & { size(): number } {
  const issued = new Map<string, Date>();

  const sweep = (now: Date) => {
    for (const [nonce, expiry] of issued) if (expiry <= now) issued.delete(nonce);
  };

  return {
    async issue(nonce, expiresAt) {
      issued.set(nonce, expiresAt);
    },
    async consume(nonce, now = new Date()) {
      sweep(now);
      const expiry = issued.get(nonce);
      if (expiry === undefined) return false;
      // Delete before returning, so a concurrent caller cannot also consume it.
      issued.delete(nonce);
      return expiry > now;
    },
    size() {
      return issued.size;
    },
  };
}
