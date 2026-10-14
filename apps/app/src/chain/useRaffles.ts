/**
 * Reading raffles from the chain.
 *
 * Section 4.2 makes the chain the source of truth, so these read it directly
 * rather than going through the API. The API will mirror this state for
 * notifications and history; it is never the thing a participant's screen
 * believes about a prize.
 *
 * The read functions themselves live in `@stubby/shared`, shared with the API
 * and the monitoring script, so all three agree about what a raffle is. This
 * file adds only caching and refresh.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { createArcClient, readAllRaffles, readRaffle, type RaffleState } from '@stubby/shared';

import { TARGET_NETWORK, TARGET_RPC_URL } from '@/wallet/network';

/**
 * One client for the app.
 *
 * Built at module load rather than per render: viem caches per client, and a
 * client rebuilt on every render is a cache thrown away on every render.
 */
const client = createArcClient({
  network: TARGET_NETWORK,
  rpcUrl: TARGET_RPC_URL,
});

/**
 * The deployed raffle contract.
 *
 * Read at module load so a build without it fails immediately and visibly,
 * rather than rendering an empty list that looks like "no draws yet".
 */
export const RAFFLE_ADDRESS = process.env.EXPO_PUBLIC_RAFFLE_ADDRESS as `0x${string}`;

export class RaffleAddressMissingError extends Error {
  override readonly name = 'RaffleAddressMissingError';
}

function address(): `0x${string}` {
  if (!RAFFLE_ADDRESS) {
    throw new RaffleAddressMissingError(
      'EXPO_PUBLIC_RAFFLE_ADDRESS is not set, so there is no contract to read. ' +
        'An empty draw list would be indistinguishable from a working app with no raffles.',
    );
  }
  return RAFFLE_ADDRESS;
}

/**
 * How often to re-read.
 *
 * Arc has sub-second finality (Section 5), so this is about how live the screen
 * should feel rather than about waiting for confirmation. Twelve seconds keeps
 * a filling raffle visibly moving without making a list screen chatty.
 */
const REFETCH_MS = 12_000;

export function useRaffles(): UseQueryResult<RaffleState[]> {
  return useQuery({
    queryKey: ['raffles', TARGET_NETWORK.chainId],
    // A cancelled raffle never sold a ticket, so nobody has a reason to see it.
    queryFn: async () =>
      (await readAllRaffles(client, address())).filter((r) => r.status !== 'Cancelled'),
    refetchInterval: REFETCH_MS,
    // A raffle list is worth showing immediately and correcting a moment later;
    // a spinner over yesterday's answer helps nobody.
    staleTime: REFETCH_MS,
  });
}

/**
 * While a draw is being decided the screen is watching for one moment, and
 * D20DAO usually answers within seconds; twelve would make the reveal lag.
 */
const DRAWING_REFETCH_MS = 3_000;

export function useRaffle(id: bigint | undefined): UseQueryResult<RaffleState | null> {
  return useQuery({
    queryKey: ['raffle', TARGET_NETWORK.chainId, id?.toString()],
    queryFn: async () => {
      const raffle = await readRaffle(client, address(), id!);
      return raffle?.status === 'Cancelled' ? null : raffle;
    },
    enabled: id !== undefined,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'ReadyToDraw' || status === 'Drawing' ? DRAWING_REFETCH_MS : REFETCH_MS;
    },
    staleTime: REFETCH_MS,
  });
}

/**
 * The draw to lead with, and the rest behind it.
 *
 * Section 12.6's Welcome hero and Home both want "the live one, then the
 * others". Live means Open — a raffle being drawn or already complete is not
 * something anyone can enter, so leading with it would put a screen's largest
 * element on the one thing a visitor cannot act on.
 */
function fillOf(raffle: RaffleState): number {
  return raffle.totalEntries > 0 ? raffle.entriesSold / raffle.totalEntries : 0;
}

/**
 * The owner's arrangement (control room, API `/draws/curation`): a featured
 * draw and an order. Display only; the contract knows nothing of it.
 */
export interface Curation {
  featured: string | null;
  order: readonly string[];
}

/**
 * Draws in the owner's order: the listed ones first, by position, then the
 * rest as they came. With no order, unchanged.
 */
export function inCuratedOrder<T extends { id: bigint }>(
  raffles: readonly T[],
  order: readonly string[] | undefined,
): T[] {
  if (!order || order.length === 0) return [...raffles];
  const position = new Map(order.map((id, i) => [id, i]));
  const at = (r: T) => position.get(r.id.toString()) ?? Number.POSITIVE_INFINITY;
  return raffles
    .map((raffle, index) => ({ raffle, index }))
    .sort((a, b) => at(a.raffle) - at(b.raffle) || a.index - b.index)
    .map(({ raffle }) => raffle);
}

export function splitForHero(
  raffles: readonly RaffleState[],
  curation?: Curation,
): {
  featured: RaffleState | undefined;
  rest: RaffleState[];
} {
  const open = raffles.filter((raffle) => raffle.status === 'Open');

  // The owner's pick leads while it is still open; a closed one cannot be
  // entered, so the rule below takes over rather than featuring it.
  const picked = open.find((raffle) => raffle.id.toString() === curation?.featured);
  if (picked) {
    return {
      featured: picked,
      rest: inCuratedOrder(
        raffles.filter((raffle) => raffle.id !== picked.id),
        curation?.order,
      ),
    };
  }

  /*
   * Among open raffles, the one closest to filling: the most urgent, and the
   * most likely to be worth a visitor's attention.
   *
   * `fillOf` guards the divide. A raffle with no entries gives 0/0, which is
   * NaN, and a comparator that returns NaN leaves the order untouched — so the
   * broken raffle would quietly stay first and be featured. It fails silently
   * and looks like a sort that simply did nothing.
   */
  const featured = [...open].sort((a, b) => fillOf(b) - fillOf(a))[0];

  return {
    featured,
    rest: inCuratedOrder(
      raffles.filter((raffle) => raffle.id !== featured?.id),
      curation?.order,
    ),
  };
}
