/**
 * The live feed: who won what and who bought stubs, newest first,
 * from the API (`GET /activity`, the watcher's record). Names are usernames
 * where people chose one, otherwise shortened wallets; the API decides which,
 * so the app never holds a mapping it would not show.
 */

import { useQuery } from '@tanstack/react-query';

import { compactNumber, formatUsdcCompact, type RaffleState } from '@stubby/shared';

import { TARGET_NETWORK } from '@/wallet/network';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

export interface ActivityItem {
  kind: 'won' | 'entered';
  raffleId: string;
  name: string;
  amount: string | null;
  count: number | null;
}

export interface ActivityStats {
  /** Distinct wallets that have bought a stub, ever. */
  players: number;
  /** The latest few players, newest first, named as the feed names them. */
  recent: string[];
  latestWin: { name: string; amount: string; raffleId: string } | null;
}

interface ActivityFeed {
  items: ActivityItem[];
  stats?: ActivityStats;
}

const activityQuery = {
  queryKey: ['activity', TARGET_NETWORK.chainId],
  queryFn: async (): Promise<ActivityFeed> => {
    const res = await fetch(`${API_URL.replace(/\/$/, '')}/activity`);
    if (!res.ok) throw new Error(`activity: ${res.status}`);
    return (await res.json()) as ActivityFeed;
  },
  refetchInterval: 20_000,
  staleTime: 15_000,
};

/** The live feed's items. */
export function useActivity() {
  return useQuery({ ...activityQuery, select: (feed: ActivityFeed) => feed.items });
}

/**
 * The players row's numbers, from the same request as the feed. Null from an
 * API that does not send them yet.
 */
export function useActivityStats() {
  return useQuery({ ...activityQuery, select: (feed: ActivityFeed) => feed.stats ?? null });
}

/** One line of the Live now card: who, what they did, and which draw. */
export interface LiveEvent {
  kind: 'won' | 'entered' | 'draw';
  who: string;
  what: string;
  detail: string;
}

/**
 * The Live now card's lines: the latest activity, then (while there is less
 * than `max` of it) each draw's own state, so the card is never empty while
 * draws exist. A line names its draw by prize when the draw is known, since
 * "10 USDC draw" says more than "draw #5".
 */
export function liveEvents(
  items: readonly ActivityItem[],
  raffles: readonly RaffleState[],
  max = 3,
): LiveEvent[] {
  const drawName = (id: string) => {
    const raffle = raffles.find((r) => r.id.toString() === id);
    return raffle ? `${formatUsdcCompact(raffle.prize)} USDC draw` : `Draw #${id}`;
  };
  const events: LiveEvent[] = items.slice(0, max).map((item) =>
    item.kind === 'won'
      ? {
          kind: 'won',
          who: item.name,
          what: `won ${formatUsdcCompact(BigInt(item.amount ?? '0'))} USDC`,
          detail: `Draw #${item.raffleId}`,
        }
      : {
          kind: 'entered',
          who: item.name,
          what: `grabbed ${item.count} ${item.count === 1 ? 'stub' : 'stubs'}`,
          detail: drawName(item.raffleId),
        },
  );
  const shown = new Set(items.slice(0, max).map((item) => item.raffleId));
  for (const raffle of raffles) {
    if (events.length >= max) break;
    if (shown.has(raffle.id.toString())) continue;
    const state =
      raffle.status === 'Drawing' || raffle.status === 'ReadyToDraw'
        ? 'is being drawn now'
        : raffle.status === 'Completed'
          ? 'has been drawn'
          : `${compactNumber(raffle.entriesSold)} of ${compactNumber(raffle.totalEntries)} stubs sold`;
    events.push({
      kind: 'draw',
      who: `${formatUsdcCompact(raffle.prize)} USDC draw`,
      what: state,
      detail: `${formatUsdcCompact(raffle.entryPrice, { decimals: 2 })} USDC a stub`,
    });
  }
  return events;
}
