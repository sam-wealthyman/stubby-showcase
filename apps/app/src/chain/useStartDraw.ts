/**
 * Starting a full raffle's draw, which anyone may do (board 6a).
 *
 * `startDraw` is permissionless by design (Section 6.1): filling a raffle does
 * not start its draw, so that a broken randomness provider can never make the
 * last ticket fail, and somebody has to make the call. Letting a participant
 * make it means a draw nobody is watching still happens. It costs the caller
 * gas and nothing else: the randomness fee comes from the adapter's float.
 */

import { useCallback, useState } from 'react';
import { useWriteContract } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';

import { stubbyRaffleAbi } from '@stubby/shared';

import { targetChain, wagmiConfig } from '@/wallet/config';

export type StartStep =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'sending'; hash: `0x${string}` }
  | { kind: 'started'; hash: `0x${string}` }
  | { kind: 'failed'; declined: boolean };

export function useStartDraw(raffleAddress: `0x${string}`) {
  const { writeContractAsync } = useWriteContract();
  const [step, setStep] = useState<StartStep>({ kind: 'idle' });

  const start = useCallback(
    async (raffleId: bigint) => {
      try {
        setStep({ kind: 'confirming' });
        const hash = await writeContractAsync({
          chainId: targetChain.id,
          address: raffleAddress,
          abi: stubbyRaffleAbi,
          functionName: 'startDraw',
          args: [raffleId],
        });
        setStep({ kind: 'sending', hash });
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: targetChain.id });
        setStep({ kind: 'started', hash });
      } catch (error) {
        const text = String(error);
        setStep({ kind: 'failed', declined: /reject|denied|declin/i.test(text) });
      }
    },
    [raffleAddress, writeContractAsync],
  );

  return { step, start };
}
