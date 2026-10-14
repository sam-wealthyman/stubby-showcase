/**
 * Claiming a won prize.
 *
 * Section 6.1: claims are pull-based and retryable. A prize stays owed until a
 * transfer actually succeeds, so a failed claim is not a lost prize — it is a
 * claim to try again, possibly to a different address.
 *
 * `claimTo` exists for the case that cannot be retried into success: a winning
 * wallet that USDC will not pay, because Arc's USDC reverts transfers to
 * blocklisted addresses. Only the winning wallet can authorise the redirect, so
 * nobody else can point a prize somewhere new.
 */

import { useCallback, useState } from 'react';
import { useWriteContract } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';

import { stubbyRaffleAbi } from '@stubby/shared';

import { diagnose, type ClaimFailure } from './recovery';
import { targetChain, wagmiConfig } from '@/wallet/config';

export type ClaimStep =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'sending'; hash: `0x${string}` }
  | { kind: 'claimed'; hash: `0x${string}` }
  | { kind: 'failed'; declined: boolean; reason: string; failure: ClaimFailure };

export interface Claim {
  step: ClaimStep;
  /** `to` redirects the prize; omit it to claim to the winning wallet. */
  claim(raffleId: bigint, to?: `0x${string}`): Promise<void>;
  reset(): void;
}

export function useClaim(raffleAddress: `0x${string}`): Claim {
  const { writeContractAsync } = useWriteContract();
  const [step, setStep] = useState<ClaimStep>({ kind: 'idle' });

  const claim = useCallback(
    async (raffleId: bigint, to?: `0x${string}`) => {
      try {
        setStep({ kind: 'confirming' });
        const hash = await writeContractAsync(
          to
            ? {
                chainId: targetChain.id,
                address: raffleAddress,
                abi: stubbyRaffleAbi,
                functionName: 'claimTo',
                args: [raffleId, to],
              }
            : {
                chainId: targetChain.id,
                address: raffleAddress,
                abi: stubbyRaffleAbi,
                functionName: 'claim',
                args: [raffleId],
              },
        );
        setStep({ kind: 'sending', hash });
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: targetChain.id });
        setStep({ kind: 'claimed', hash });
      } catch (error) {
        // The contract's custom errors are the vocabulary for what to do next:
        // NotTheWinner means switch wallets, a token-level revert means redirect.
        // A generic "it failed" would tell the user nothing actionable.
        const failure = diagnose(error);
        setStep({
          kind: 'failed',
          declined: failure === 'declined',
          reason: String(error),
          failure,
        });
      }
    },
    [raffleAddress, writeContractAsync],
  );

  return { step, claim, reset: () => setStep({ kind: 'idle' }) };
}

/**
 * What to tell a winner whose claim did not go through.
 *
 * Section 12.2, and it matters more here than anywhere else in the app: this is
 * the one screen where a failure could be read as "my prize is gone". It is
 * not, and the first sentence has to say so.
 */
export function claimMessage(step: Extract<ClaimStep, { kind: 'failed' }>): string {
  if (step.declined) {
    return 'Your prize is still waiting. Claim anytime.';
  }
  return "The claim didn't go through. Your prize is safe, so please try again.";
}
