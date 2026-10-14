import { useReadContracts } from 'wagmi';

import { stubbyRaffleAbi } from '@stubby/shared';

import { targetChain } from '@/wallet/config';

import { RAFFLE_ADDRESS } from './useRaffles';

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * When a new randomness source has been announced and not yet taken effect,
 * the time it will. The source decides winners, so buying pauses until then:
 * nobody buys into a draw under a source they have had no chance to judge.
 * Undefined when nothing is pending, or the hour has passed.
 */
export function useSourceChange(now: Date = new Date()): Date | undefined {
  const { data } = useReadContracts({
    contracts: [
      {
        chainId: targetChain.id,
        address: RAFFLE_ADDRESS,
        abi: stubbyRaffleAbi,
        functionName: 'pendingRandomness',
      },
      {
        chainId: targetChain.id,
        address: RAFFLE_ADDRESS,
        abi: stubbyRaffleAbi,
        functionName: 'pendingRandomnessAt',
      },
    ],
    query: { refetchInterval: 60_000 },
  });
  const source = data?.[0]?.result as string | undefined;
  const at = data?.[1]?.result as bigint | undefined;
  if (!source || source === ZERO || at === undefined) return undefined;
  const activatesAt = new Date(Number(at) * 1000);
  return activatesAt > now ? activatesAt : undefined;
}
