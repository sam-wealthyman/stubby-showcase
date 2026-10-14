import { useQuery } from '@tanstack/react-query';

import { useApiClient } from '@/auth/useSession';

export type GeoBlock = 'blocked-country' | 'blocked-region' | 'anonymised' | 'unknown-country';

/**
 * Whether buying is offered from where this visitor is (Section 11.9).
 *
 * Asked only where tickets are bought. An API that cannot be reached is not a
 * refusal: the contract is permissionless, so this is a courtesy the app keeps,
 * not a lock, and an outage must not stop honest buyers.
 */
export function useGeoBlock(): GeoBlock | undefined {
  const api = useApiClient();
  const query = useQuery({
    queryKey: ['geo'],
    queryFn: async () => {
      const result = await api.geo();
      return result.ok ? result.value : { allowed: true };
    },
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
  const value = query.data;
  return value && !value.allowed ? (value.reason ?? 'blocked-country') : undefined;
}

/** What to say, and what to do about it. */
export function geoBlockMessage(block: GeoBlock): { title: string; line: string } {
  switch (block) {
    case 'anonymised':
      return {
        title: 'Turn off your VPN to buy',
        line: "You can't buy tickets while using a VPN or proxy. You can still browse and claim prizes.",
      };
    default:
      return {
        title: 'Not available where you are',
        line: "Tickets can't be bought from your country or region. You can still browse and claim prizes.",
      };
  }
}
