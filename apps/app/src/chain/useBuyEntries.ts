/**
 * Buying entries: approve, then enter.
 *
 * Two transactions, because the contract pulls payment with
 * `safeTransferFrom` and therefore needs an allowance first. The screen has to
 * say so before the first prompt: a user told "confirm in your wallet" who then
 * gets a second prompt nobody warned them about has every reason to think
 * something has gone wrong, and cancelling there leaves an approval granted and
 * no ticket bought.
 *
 * The step is exposed rather than hidden so the screen can name which prompt is
 * on the wallet right now.
 *
 * **A purchase that takes the last tickets also starts the draw**, as a third
 * prompt, so the last buyer pays that gas and nobody waits for "someone" to
 * press a button. The contract keeps filling and drawing apart on purpose (a
 * failing randomness provider must not block the last purchase), so this is
 * the app doing it straight after. Declining it, or finding someone else got
 * there first, still leaves a successful purchase; the draw screen's button is
 * the fallback.
 */

import { useCallback, useState } from 'react';
import { useWriteContract } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';

import { USDC_ADDRESS, stubbyRaffleAbi } from '@stubby/shared';

import { targetChain, wagmiConfig } from '@/wallet/config';

/** The slice of ERC-20 this needs. The full ABI is not worth carrying. */
const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export type BuyStep =
  | { kind: 'idle' }
  /** Waiting for the user to approve USDC in their wallet. */
  | { kind: 'approving' }
  /** The approval is on chain and being confirmed. */
  | { kind: 'confirming-approval'; hash: `0x${string}` }
  /** Waiting for the user to confirm the entry itself. */
  | { kind: 'entering' }
  | { kind: 'confirming-entry'; hash: `0x${string}` }
  /** The purchase filled the raffle; waiting for the user to start the draw. */
  | { kind: 'starting-draw' }
  | { kind: 'confirming-draw'; hash: `0x${string}` }
  /** `drawStarted` only when this purchase filled the raffle and started it. */
  | { kind: 'bought'; hash: `0x${string}`; drawStarted?: boolean }
  | { kind: 'failed'; reason: string; declined: boolean };

export interface BuyEntries {
  step: BuyStep;
  buy(input: {
    raffleId: bigint;
    count: number;
    cost: bigint;
    approve: boolean;
    /** This purchase takes the last tickets, so it starts the draw too. */
    fills: boolean;
    /** True once the stubs are bought, whether or not the draw then started. */
  }): Promise<boolean>;
  reset(): void;
}

export function useBuyEntries(raffleAddress: `0x${string}`): BuyEntries {
  const { writeContractAsync } = useWriteContract();
  const [step, setStep] = useState<BuyStep>({ kind: 'idle' });

  const buy = useCallback(
    async ({
      raffleId,
      count,
      cost,
      approve,
      fills,
    }: {
      raffleId: bigint;
      count: number;
      cost: bigint;
      approve: boolean;
      fills: boolean;
    }) => {
      try {
        if (approve) {
          setStep({ kind: 'approving' });
          const hash = await writeContractAsync({
            chainId: targetChain.id,
            address: USDC_ADDRESS,
            abi: erc20Abi,
            functionName: 'approve',
            // Exactly what this purchase costs, not an unlimited allowance.
            // An infinite approval is one compromised contract away from being
            // the user's whole balance, and the saving is one cheap
            // transaction per purchase.
            args: [raffleAddress, cost],
          });
          setStep({ kind: 'confirming-approval', hash });
          // The entry must not be sent until the approval has actually landed,
          // or `safeTransferFrom` reverts against an allowance that does not
          // exist yet.
          await confirm(hash);
        }

        setStep({ kind: 'entering' });
        const hash = await writeContractAsync({
          chainId: targetChain.id,
          address: raffleAddress,
          abi: stubbyRaffleAbi,
          functionName: 'enter',
          args: [raffleId, count],
        });
        setStep({ kind: 'confirming-entry', hash });
        await confirm(hash);

        if (!fills) {
          setStep({ kind: 'bought', hash });
          return true;
        }
        // The tickets are bought whatever happens next.
        try {
          setStep({ kind: 'starting-draw' });
          const drawHash = await writeContractAsync({
            chainId: targetChain.id,
            address: raffleAddress,
            abi: stubbyRaffleAbi,
            functionName: 'startDraw',
            args: [raffleId],
          });
          setStep({ kind: 'confirming-draw', hash: drawHash });
          await confirm(drawHash);
          setStep({ kind: 'bought', hash, drawStarted: true });
        } catch {
          setStep({ kind: 'bought', hash, drawStarted: false });
        }
        return true;
      } catch (error) {
        setStep({
          kind: 'failed',
          reason: String(error),
          declined: isDeclined(error),
        });
        return false;
      }
    },
    [raffleAddress, writeContractAsync],
  );

  return { step, buy, reset: () => setStep({ kind: 'idle' }) };
}

/**
 * Wait for a transaction to be mined.
 *
 * The imperative action rather than `useWaitForTransactionReceipt`, because a
 * hook cannot be called partway through a sequence — and the sequence is the
 * point: the approval has to exist before the entry is sent.
 *
 * Arc has sub-second deterministic finality (Section 5), so this is a short
 * wait rather than the minutes an optimistic chain would need. It is still not
 * optional.
 */
function confirm(hash: `0x${string}`) {
  return waitForTransactionReceipt(wagmiConfig, { hash, chainId: targetChain.id });
}

function isDeclined(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /rejected|denied|declined|cancell?ed|UserRejected/i.test(text);
}
