/**
 * Where an IP address is, and whether it is a VPN or proxy (Section 11.9),
 * from proxycheck.io: its free tier returns both (ipinfo's free tier has no
 * VPN flag). With `PROXYCHECK_API_KEY` the free allowance is 1,000 lookups a
 * day; without it, 100.
 *
 * Results are cached per address for a day, so a person moving between
 * screens costs one lookup. A lookup that fails returns nothing, and the
 * decision then allows the purchase: an outage at the provider must not stop
 * the app, and the contract is permissionless anyway (geo.ts).
 */

export interface GeoFacts {
  countryCode?: string;
  /** Sub-division, for region blocks (Ontario, Crimea…). */
  regionCode?: string;
  regionName?: string;
  anonymised: boolean;
}

export type GeoLookup = (ip: string) => Promise<GeoFacts | undefined>;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED = 20_000;

/** Loopback, private and link-local addresses: development, never a person. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, '');
  return (
    v4 === '127.0.0.1' ||
    v4.startsWith('10.') ||
    v4.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(v4) ||
    v4.startsWith('169.254.') ||
    ip === '::1' ||
    /^f[cd]/i.test(ip) ||
    /^fe80:/i.test(ip) ||
    ip === 'unknown'
  );
}

export function proxycheckLookup(options: {
  apiKey?: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}): GeoLookup {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { facts: GeoFacts; at: number }>();

  return async (ip) => {
    const hit = cache.get(ip);
    if (hit && now() - hit.at < DAY_MS) return hit.facts;

    const url = new URL(`https://proxycheck.io/v2/${encodeURIComponent(ip)}`);
    url.searchParams.set('vpn', '1');
    // Location data, isocode included, comes only with asn=1: without it the
    // answer is the proxy flag alone, and no country would ever be blocked.
    url.searchParams.set('asn', '1');
    if (options.apiKey) url.searchParams.set('key', options.apiKey);
    try {
      const response = await request(url, { signal: AbortSignal.timeout(6000) });
      if (!response.ok) return undefined;
      const body = (await response.json()) as Record<string, unknown> & { status?: string };
      const entry = body[ip] as
        { isocode?: string; regioncode?: string; region?: string; proxy?: string } | undefined;
      if (!entry || (body.status !== 'ok' && body.status !== 'warning')) return undefined;
      const facts: GeoFacts = {
        ...(entry.isocode ? { countryCode: entry.isocode.toUpperCase() } : {}),
        ...(entry.regioncode ? { regionCode: entry.regioncode } : {}),
        ...(entry.region ? { regionName: entry.region } : {}),
        anonymised: entry.proxy === 'yes',
      };
      if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
      cache.set(ip, { facts, at: now() });
      return facts;
    } catch {
      return undefined;
    }
  };
}
