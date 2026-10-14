/**
 * The owner's view and the owner's actions.
 *
 * `StubbyRaffle` is `Ownable2Step`, so "am I the owner" is a chain read, not a
 * login. That is the right shape: the admin screen guards nothing by itself —
 * every function it calls is `onlyOwner` and would revert for anyone else.
 * Hiding the screen is courtesy, not security.
 */

import { useCallback, useState } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';

import { d20RandomnessAdapterAbi, stubbyRaffleAbi } from '@stubby/shared';

import { RAFFLE_ADDRESS } from './useRaffles';
import { targetChain, wagmiConfig } from '@/wallet/config';

/** Who the contract answers to, and where its commission goes. */
export function useGovernance(): {
  owner: `0x${string}` | undefined;
  pendingOwner: `0x${string}` | undefined;
  treasury: `0x${string}` | undefined;
  /** The randomness adapter, and who it has been offered to, if anyone. */
  adapter: `0x${string}` | undefined;
  adapterPendingOwner: `0x${string}` | undefined;
  refetch(): void;
} {
  const owner = useReadContract({
    chainId: targetChain.id,
    address: RAFFLE_ADDRESS,
    abi: stubbyRaffleAbi,
    functionName: 'owner',
  });
  const pendingOwner = useReadContract({
    chainId: targetChain.id,
    address: RAFFLE_ADDRESS,
    abi: stubbyRaffleAbi,
    functionName: 'pendingOwner',
  });
  const treasury = useReadContract({
    chainId: targetChain.id,
    address: RAFFLE_ADDRESS,
    abi: stubbyRaffleAbi,
    functionName: 'treasury',
  });
  const adapter = useReadContract({
    chainId: targetChain.id,
    address: RAFFLE_ADDRESS,
    abi: stubbyRaffleAbi,
    functionName: 'randomness',
  });
  const adapterPending = useReadContract({
    chainId: targetChain.id,
    address: adapter.data as `0x${string}` | undefined,
    abi: d20RandomnessAdapterAbi,
    functionName: 'pendingOwner',
    query: { enabled: adapter.data !== undefined },
  });

  return {
    owner: owner.data as `0x${string}` | undefined,
    pendingOwner: pendingOwner.data as `0x${string}` | undefined,
    treasury: treasury.data as `0x${string}` | undefined,
    adapter: adapter.data as `0x${string}` | undefined,
    adapterPendingOwner: adapterPending.data as `0x${string}` | undefined,
    refetch: () => {
      void owner.refetch();
      void pendingOwner.refetch();
      void treasury.refetch();
      void adapterPending.refetch();
    },
  };
}

/** Is the connected wallet the contract's owner? */
export function useIsOwner(): { isOwner: boolean; owner: `0x${string}` | undefined } {
  const { address } = useAccount();
  const { data: owner } = useReadContract({
    chainId: targetChain.id,
    address: RAFFLE_ADDRESS,
    abi: stubbyRaffleAbi,
    functionName: 'owner',
  });

  return {
    // Case-insensitive, for the same reason the holdings check is: checksum
    // casing is presentation, not identity.
    isOwner:
      address !== undefined &&
      owner !== undefined &&
      address.toLowerCase() === (owner as string).toLowerCase(),
    owner: owner as `0x${string}` | undefined,
  };
}

export type OwnerStep =
  | { kind: 'idle' }
  | { kind: 'confirming'; what: string }
  | { kind: 'sending'; what: string; hash: `0x${string}` }
  | { kind: 'done'; what: string; hash: `0x${string}` }
  | { kind: 'failed'; what: string; declined: boolean; reason: string };

export interface OwnerActions {
  step: OwnerStep;
  createRaffle(input: {
    prize: bigint;
    entryPrice: bigint;
    totalEntries: number;
    windowSeconds: bigint;
  }): Promise<boolean>;
  /** Change a draw nobody has bought into yet. The window restarts. */
  updateRaffle(input: {
    raffleId: bigint;
    prize: bigint;
    entryPrice: bigint;
    totalEntries: number;
    windowSeconds: bigint;
  }): Promise<boolean>;
  /** Withdraw a draw nobody has bought into yet. Final. */
  cancelRaffle(raffleId: bigint): Promise<boolean>;
  /** Section 6.1: permissionless, but the owner is usually the one watching. */
  startDraw(raffleId: bigint): Promise<boolean>;
  withdrawCommission(raffleIds: readonly bigint[]): Promise<boolean>;
  /**
   * Nominate a new owner. Step one of two.
   *
   * `Ownable2Step`, so this only nominates: ownership moves when that address
   * calls `acceptOwnership`. A typo nominates an address that can never accept,
   * the current owner keeps everything, and the nomination can be replaced.
   */
  transferOwnership(to: `0x${string}`): Promise<boolean>;
  /** Step two, called by the nominee. */
  acceptOwnership(): Promise<boolean>;
  /** The same, for the randomness adapter, which has its own owner. */
  acceptAdapterOwnership(adapter: `0x${string}`): Promise<boolean>;
  /** Immediate and one transaction. Where commission is paid from now on. */
  setTreasury(to: `0x${string}`): Promise<boolean>;
  reset(): void;
}

export function useOwnerActions(): OwnerActions {
  const { writeContractAsync } = useWriteContract();
  const [step, setStep] = useState<OwnerStep>({ kind: 'idle' });

  const run = useCallback(async (what: string, call: () => Promise<`0x${string}`>) => {
    try {
      setStep({ kind: 'confirming', what });
      const hash = await call();
      setStep({ kind: 'sending', what, hash });
      await waitForTransactionReceipt(wagmiConfig, { hash, chainId: targetChain.id });
      setStep({ kind: 'done', what, hash });
      return true;
    } catch (error) {
      const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
      setStep({
        kind: 'failed',
        what,
        declined: /rejected|denied|declined|cancell?ed|UserRejected/i.test(text),
        reason: String(error),
      });
      return false;
    }
  }, []);

  return {
    step,
    createRaffle: ({ prize, entryPrice, totalEntries, windowSeconds }) =>
      run('the new draw', () =>
        writeContractAsync({
          chainId: targetChain.id,
          address: RAFFLE_ADDRESS,
          abi: stubbyRaffleAbi,
          functionName: 'createRaffle',
          args: [prize, entryPrice, totalEntries, windowSeconds],
        }),
      ),
    updateRaffle: ({ raffleId, prize, entryPrice, totalEntries, windowSeconds }) =>
      run('the changes', () =>
        writeContractAsync({
          chainId: targetChain.id,
          address: RAFFLE_ADDRESS,
          abi: stubbyRaffleAbi,
          functionName: 'updateRaffle',
          args: [raffleId, prize, entryPrice, totalEntries, windowSeconds],
        }),
      ),
    cancelRaffle: (raffleId) =>
      run('the cancellation', () =>
        writeContractAsync({
          chainId: targetChain.id,
          address: RAFFLE_ADDRESS,
          abi: stubbyRaffleAbi,
          functionName: 'cancelRaffle',
          args: [raffleId],
        }),
      ),
    startDraw: (raffleId) =>
      run('the draw', () =>
        writeContractAsync({
          chainId: targetChain.id,
          address: RAFFLE_ADDRESS,
          abi: stubbyRaffleAbi,
          functionName: 'startDraw',
          args: [raffleId],
        }),
      ),
    withdrawCommission: (raffleIds) =>
      run('the withdrawal', () =>
        writeContractAsync({
          chainId: targetChain.id,
          address: RAFFLE_ADDRESS,
          abi: stubbyRaffleAbi,
          functionName: 'withdrawCommission',
          // Only raffles that actually owe something. Passing settled ids is
          // gas spent to change nothing.
          args: [raffleIds as readonly bigint[]],
        }),
      ),
    transferOwnership: (to) =>
      run('the ownership handover', () =>
        writeContractAsync({
          chainId: targetChain.id,
          address: RAFFLE_ADDRESS,
          abi: stubbyRaffleAbi,
          functionName: 'transferOwnership',
          args: [to],
        }),
      ),
    acceptOwnership: () =>
      run('taking ownership', () =>
        writeContractAsync({
          chainId: targetChain.id,
          address: RAFFLE_ADDRESS,
          abi: stubbyRaffleAbi,
          functionName: 'acceptOwnership',
        }),
      ),
    acceptAdapterOwnership: (adapter) =>
      run('taking the adapter', () =>
        writeContractAsync({
          chainId: targetChain.id,
          address: adapter,
          abi: d20RandomnessAdapterAbi,
          functionName: 'acceptOwnership',
        }),
      ),
    setTreasury: (to) =>
      run('the treasury change', () =>
        writeContractAsync({
          chainId: targetChain.id,
          address: RAFFLE_ADDRESS,
          abi: stubbyRaffleAbi,
          functionName: 'setTreasury',
          args: [to],
        }),
      ),
    reset: () => setStep({ kind: 'idle' }),
  };
}

/*
 * `renounceOwnership` is deliberately absent.
 *
 * `Ownable` exposes it and it would be one more entry here, but it makes the
 * contract permanently ownerless: no more `createRaffle`, no
 * `withdrawCommission`, no `setEntriesPaused`, and no way back. Commission
 * already earned would be stranded. It is not a setting, it is an ending, and
 * it does not belong behind a button on a dashboard.
 */
