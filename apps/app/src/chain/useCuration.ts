import { useQuery } from '@tanstack/react-query';

import { useApiClient } from '@/auth/useSession';
import { TARGET_NETWORK } from '@/wallet/network';

import type { Curation } from './useRaffles';

export const CURATION_KEY = ['curation', TARGET_NETWORK.chainId] as const;

/**
 * The owner's featured draw and draw order, from the API.
 *
 * Undefined while loading or if the API is unreachable, and then the app
 * falls back to its own rule (the draw closest to filling leads). Display
 * only, so a stale or missing answer can mis-order the page but never
 * misrepresent a draw: every number shown still comes from the chain.
 */
export function useCuration(): Curation | undefined {
  const api = useApiClient();
  const { data } = useQuery({
    queryKey: CURATION_KEY,
    queryFn: async () => {
      const result = await api.curation();
      return result.ok ? result.value : null;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return data ?? undefined;
}
