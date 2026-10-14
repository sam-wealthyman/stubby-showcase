/**
 * What this wallet has, in this raffle.
 *
 * Three reads the picker cannot work without: how many entries the wallet
 * already holds (Section 2's cap is per wallet), its USDC, and whether the
 * raffle is already allowed to take payment.
 *
 * Through wagmi rather than the shared read client, because all three are
 * scoped to the connected account and must re-read when it changes. A raffle's
 * own state is not — that stays in `useRaffles`.
 */

import { useAccount, useReadContract } from 'wagmi';

import { USDC_ADDRESS, stubbyRaffleAbi } from '@stubby/shared';

import { targetChain } from '@/wallet/config';

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface WalletRaffle {
  /** Entries this wallet holds. 0 when not connected. */
  held: number;
  /**
   * USDC in the 6-decimal ERC-20 view, or undefined until read.
   *
   * Undefined is not zero, and the picker depends on the difference: an unread
   * balance must not lock every chip for want of funds the wallet may have.
   */
  balance: bigint | undefined;
  allowance: bigint | undefined;
  /** Re-read after a purchase, so the screen does not show stale holdings. */
  refetch(): void;
}

export function useWalletRaffle(
  raffleAddress: `0x${string}`,
  raffleId: bigint | undefined,
): WalletRaffle {
  const { address } = useAccount();
  const enabled = address !== undefined && raffleId !== undefined;

  const held = useReadContract({
    chainId: targetChain.id,
    address: raffleAddress,
    abi: stubbyRaffleAbi,
    functionName: 'entriesOf',
    args: enabled ? [raffleId, address] : undefined,
    query: { enabled },
  });

  const balance = useReadContract({
    chainId: targetChain.id,
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: address !== undefined },
  });

  const allowance = useReadContract({
    chainId: targetChain.id,
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, raffleAddress] : undefined,
    query: { enabled: address !== undefined },
  });

  return {
    held: Number(held.data ?? 0),
    balance: balance.data,
    allowance: allowance.data,
    refetch: () => {
      void held.refetch();
      void balance.refetch();
      void allowance.refetch();
    },
  };
}
