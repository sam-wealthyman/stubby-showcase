/**
 * The transactions behind a draw: started, number delivered, prize paid.
 *
 * Read from the API, which keeps them as the watcher sees them
 * (`GET /raffles/:id/events`). This used to scan the chain backwards from
 * the browser, up to 40 eth_getLogs per lookup against a public RPC that
 * rate-limits, and a draw settled seconds earlier often came back "too old to
 * look up". One request to the API replaces all of it.
 *
 * The watcher reads the chain every 30 seconds, so a milestone can be that
 * far behind. While one is missing the query asks again every 10 seconds; a
 * draw from before the watcher existed simply never has one, and the screens
 * point at the contract on the explorer instead.
 */

import { useQuery } from '@tanstack/react-query';

import { TARGET_NETWORK } from '@/wallet/network';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

/** The raffle events worth linking to, each emitted once per raffle. */
export type RaffleEvent = 'DrawStarted' | 'Drawn' | 'PrizeClaimed';

export interface DrawProof {
  transactionHash: `0x${string}`;
  blockNumber: bigint;
}

type Events = Partial<Record<RaffleEvent, { txHash: string; blockNumber: string }>>;

export async function fetchRaffleEvents(
  raffleId: bigint,
  fetchImpl: typeof fetch = globalThis.fetch,
  base: string = API_URL,
): Promise<Events> {
  const res = await fetchImpl(`${base.replace(/\/$/, '')}/raffles/${raffleId}/events`);
  if (!res.ok) throw new Error(`raffle events: ${res.status}`);
  return ((await res.json()) as { events: Events }).events;
}

export function useRaffleEventTx(
  eventName: RaffleEvent,
  raffleId: bigint | undefined,
  enabled = true,
) {
  return useQuery({
    // One request per raffle serves all three milestones.
    queryKey: ['raffle-events', TARGET_NETWORK.chainId, raffleId?.toString()],
    enabled: enabled && raffleId !== undefined,
    queryFn: () => fetchRaffleEvents(raffleId!),
    select: (events): DrawProof | null => {
      const found = events[eventName];
      return found
        ? {
            transactionHash: found.txHash as `0x${string}`,
            blockNumber: BigInt(found.blockNumber),
          }
        : null;
    },
    // Until it appears, ask again; once there, it never changes.
    refetchInterval: (query) => (query.state.data?.[eventName] ? false : 10_000),
    staleTime: 10_000,
    retry: 2,
  });
}

export function useDrawProof(raffleId: bigint | undefined, enabled = true) {
  return useRaffleEventTx('Drawn', raffleId, enabled);
}
