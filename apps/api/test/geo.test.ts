import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_BLOCKED_COUNTRIES } from '@stubby/shared';

import { isPrivateAddress, proxycheckLookup, type GeoLookup } from '../src/geo/lookup.js';
import { geoRoutes } from '../src/http/geo.js';

/** A stand-in for proxycheck.io, answering from a table and counting calls. */
function fakeProxycheck(
  table: Record<
    string,
    { isocode: string; proxy: 'yes' | 'no'; regioncode?: string; region?: string }
  >,
) {
  let calls = 0;
  const fakeFetch = (async (input: URL | string) => {
    calls += 1;
    // The real API returns location only with asn=1; so does this one.
    if (new URL(String(input)).searchParams.get('asn') !== '1') {
      return new Response(JSON.stringify({ status: 'ok', '0': {} }));
    }
    const ip = decodeURIComponent(new URL(String(input)).pathname.split('/').pop()!);
    const entry = table[ip];
    return new Response(
      JSON.stringify(entry ? { status: 'ok', [ip]: entry } : { status: 'denied' }),
    );
  }) as typeof fetch;
  return { fetch: fakeFetch, calls: () => calls };
}

describe('proxycheckLookup', () => {
  it('reads the country and the VPN flag, and asks once a day per address', async () => {
    const fake = fakeProxycheck({ '203.0.113.7': { isocode: 'ng', proxy: 'yes' } });
    const lookup = proxycheckLookup({ fetch: fake.fetch });
    expect(await lookup('203.0.113.7')).toEqual({ countryCode: 'NG', anonymised: true });
    await lookup('203.0.113.7');
    expect(fake.calls()).toBe(1);
  });

  it('reads the region, for region blocks', async () => {
    const fake = fakeProxycheck({
      '203.0.113.9': { isocode: 'CA', regioncode: 'ON', region: 'Ontario', proxy: 'no' },
    });
    expect(await proxycheckLookup({ fetch: fake.fetch })('203.0.113.9')).toEqual({
      countryCode: 'CA',
      regionCode: 'ON',
      regionName: 'Ontario',
      anonymised: false,
    });
  });

  it('knows nothing, rather than guessing, when the provider fails', async () => {
    const lookup = proxycheckLookup({
      fetch: (async () => {
        throw new Error('down');
      }) as typeof fetch,
    });
    expect(await lookup('203.0.113.8')).toBeUndefined();
  });
});

describe('isPrivateAddress', () => {
  it('treats loopback and private ranges as local', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:10.1.2.3', '192.168.0.4', '172.20.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress('203.0.113.7')).toBe(false);
  });
});

describe('GET /geo', () => {
  const previous = process.env.TRUSTED_PROXIES;
  beforeEach(() => {
    process.env.TRUSTED_PROXIES = '1';
  });
  afterEach(() => {
    process.env.TRUSTED_PROXIES = previous;
  });

  const facts: Record<string, Awaited<ReturnType<GeoLookup>>> = {
    '198.51.100.1': { countryCode: 'NG', anonymised: false },
    '198.51.100.2': { countryCode: 'IR', anonymised: false },
    '198.51.100.3': { countryCode: 'DE', anonymised: true },
    '198.51.100.4': undefined,
    '198.51.100.5': {
      countryCode: 'CA',
      regionCode: 'ON',
      regionName: 'Ontario',
      anonymised: false,
    },
    '198.51.100.6': { countryCode: 'US', anonymised: false },
  };
  const app = geoRoutes(async (ip) => facts[ip], new Set(DEFAULT_BLOCKED_COUNTRIES));
  const ask = async (ip: string) =>
    (await app.request('/', { headers: { 'x-forwarded-for': ip } })).json();

  it('lets a visitor from an allowed country buy', async () => {
    expect(await ask('198.51.100.1')).toEqual({ allowed: true });
  });

  it('refuses a sanctioned country, and says which', async () => {
    expect(await ask('198.51.100.2')).toEqual({
      allowed: false,
      reason: 'blocked-country',
      country: 'IR',
    });
  });

  it('refuses a blocked region inside an allowed country', async () => {
    expect(await ask('198.51.100.5')).toMatchObject({ allowed: false, reason: 'blocked-region' });
  });

  it('refuses the United States', async () => {
    expect(await ask('198.51.100.6')).toMatchObject({ allowed: false, reason: 'blocked-country' });
  });

  it('refuses a VPN or proxy', async () => {
    expect(await ask('198.51.100.3')).toMatchObject({ allowed: false, reason: 'anonymised' });
  });

  it('allows when the provider could not place the address', async () => {
    expect(await ask('198.51.100.4')).toEqual({ allowed: true });
  });
});
