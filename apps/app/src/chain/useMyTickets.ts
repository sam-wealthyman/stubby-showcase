/**
 * Every raffle this wallet has entries in.
 *
 * There is no "my raffles" on chain and there should not be: the contract keeps
 * `entriesOf[raffleId][wallet]`, which is the cheap direction for the thing it
 * has to do on every entry. Finding a wallet's positions means asking each
 * raffle, which is fine at this scale and is the honest cost of not keeping a
 * second copy of the truth (Section 4.2).
 *
 * When the raffle count makes this uncomfortable, the answer is the API's
 * mirror of `Entered` events as an index — a hint about *which* raffles to
 * read, never a replacement for reading them.
 */

import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';

import { createArcClient, readEntriesOf, type RaffleState } from '@stubby/shared';

import { classify, sortHoldings, type Holding } from './holdings';
import { RAFFLE_ADDRESS, useRaffles } from './useRaffles';
import { TARGET_NETWORK, TARGET_RPC_URL } from '@/wallet/network';

const client = createArcClient({
  network: TARGET_NETWORK,
  rpcUrl: TARGET_RPC_URL,
});

export interface MyTickets {
  holdings: Holding[] | undefined;
  isPending: boolean;
  isError: boolean;
  /** No wallet connected. Distinct from "connected and holds nothing". */
  disconnected: boolean;
  refetch(): void;
}

export function useMyTickets(): MyTickets {
  const { address } = useAccount();
  const raffles = useRaffles();

  const holdings = useQuery({
    queryKey: ['my-tickets', TARGET_NETWORK.chainId, address, (raffles.data ?? []).length],
    enabled: address !== undefined && raffles.data !== undefined,
    queryFn: async () => {
      const wallet = address!;
      const found = await Promise.all(
        (raffles.data ?? []).map(async (raffle: RaffleState) => {
          const entries = await readEntriesOf(client, RAFFLE_ADDRESS, raffle.id, wallet);
          // A raffle this wallet never entered is not a holding. Returning one
          // with zero entries would fill the screen with everyone else's draws.
          return entries > 0 ? classify({ raffle, entries, wallet }) : null;
        }),
      );
      return sortHoldings(found.filter((holding): holding is Holding => holding !== null));
    },
  });

  return {
    holdings: holdings.data,
    isPending: raffles.isPending || (address !== undefined && holdings.isPending),
    // Only when nothing has loaded: a failed background refresh keeps showing
    // what was already read rather than covering it with an error.
    isError: raffles.isLoadingError || holdings.isLoadingError,
    disconnected: address === undefined,
    refetch: () => {
      void raffles.refetch();
      void holdings.refetch();
    },
  };
}
