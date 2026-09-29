import { describe, expect, it } from 'vitest';

import {
  BlocklistError,
  DEFAULT_BLOCKED_COUNTRIES,
  FATF_CALL_FOR_ACTION,
  LICENSING_RISK,
  OFAC_COMPREHENSIVE,
  geoDecision,
  regionBlocked,
  parseBlockedCountries,
} from '../src/geo.js';

describe('the default blocklist', () => {
  it('carries the four comprehensively sanctioned countries', () => {
    expect([...OFAC_COMPREHENSIVE].sort()).toEqual(['CU', 'IR', 'KP', 'SY']);
    for (const code of OFAC_COMPREHENSIVE) {
      expect(DEFAULT_BLOCKED_COUNTRIES).toContain(code);
    }
  });

  it('adds the FATF call-for-action jurisdiction not already covered', () => {
    expect([...FATF_CALL_FOR_ACTION]).toEqual(['MM']);
    expect(DEFAULT_BLOCKED_COUNTRIES).toContain('MM');
  });

  it("carries the owner's restrictions of 2026-09-27", () => {
    for (const code of ['US', 'GB', 'CN', 'RU', 'BY', 'CU', 'IR', 'KP', 'SY']) {
      expect(DEFAULT_BLOCKED_COUNTRIES, code).toContain(code);
    }
  });

  it('leaves the rest of the licensing tier to a lawyer', () => {
    for (const code of ['AU', 'SG', 'FR', 'NL', 'BE', 'IT', 'ES']) {
      expect(DEFAULT_BLOCKED_COUNTRIES, code).not.toContain(code);
    }
    expect(LICENSING_RISK).toContain('AU');
  });

  it('is every entry a valid ISO 3166-1 alpha-2 code, with no duplicates', () => {
    for (const code of DEFAULT_BLOCKED_COUNTRIES) expect(code).toMatch(/^[A-Z]{2}$/);
    expect(new Set(DEFAULT_BLOCKED_COUNTRIES).size).toBe(DEFAULT_BLOCKED_COUNTRIES.length);
  });

  it('does not block Ukraine, since the sanctioned areas are regions not a country', () => {
    // OFAC covers Crimea, Donetsk and Luhansk. Blocking UA would overshoot by a
    // whole country, and a country list cannot express a region.
    expect(DEFAULT_BLOCKED_COUNTRIES).not.toContain('UA');
  });
});

describe('parsing the environment variable', () => {
  it('falls back to the default only when the variable is absent', () => {
    expect(parseBlockedCountries(undefined)).toEqual(new Set(DEFAULT_BLOCKED_COUNTRIES));
  });

  it('treats an empty value as blocking nobody, deliberately', () => {
    // Distinct from absent: someone has explicitly chosen to block nothing.
    expect(parseBlockedCountries('')).toEqual(new Set());
    expect(parseBlockedCountries('  ')).toEqual(new Set());
  });

  it('accepts a list, ignoring whitespace and case', () => {
    expect(parseBlockedCountries('cu, ir ,KP')).toEqual(new Set(['CU', 'IR', 'KP']));
  });

  it('throws on a typo rather than silently not blocking it', () => {
    // The failure worth preventing: a malformed code that looks like diligence
    // and blocks nobody.
    for (const bad of ['USA', 'U', 'U1', 'cu;ir', '🇨🇺']) {
      expect(() => parseBlockedCountries(bad), bad).toThrow(BlocklistError);
    }
  });
});

describe('the deposit-time decision, Section 11.9', () => {
  const blocked = new Set(['CU', 'IR']);

  it('allows an ordinary address', () => {
    expect(geoDecision({ countryCode: 'DE', blocked })).toEqual({ allowed: true });
  });

  it('refuses a blocked country, whatever case the provider used', () => {
    expect(geoDecision({ countryCode: 'ir', blocked })).toEqual({
      allowed: false,
      reason: 'blocked-country',
    });
  });

  it('refuses an anonymised address', () => {
    expect(geoDecision({ countryCode: 'DE', anonymised: true, blocked })).toEqual({
      allowed: false,
      reason: 'anonymised',
    });
  });

  it('reports the country before the VPN flag, since that is the firmer reason', () => {
    expect(geoDecision({ countryCode: 'CU', anonymised: true, blocked })).toEqual({
      allowed: false,
      reason: 'blocked-country',
    });
  });

  it('lets an unresolvable address through by default', () => {
    // A provider outage must not become a total outage. The contract is
    // permissionless regardless, so this was never a technical barrier.
    expect(geoDecision({ countryCode: undefined, blocked })).toEqual({ allowed: true });
    expect(geoDecision({ countryCode: '', blocked })).toEqual({ allowed: true });
  });

  it('can be told to refuse an unresolvable address instead', () => {
    expect(geoDecision({ countryCode: undefined, blocked, refuseUnknown: true })).toEqual({
      allowed: false,
      reason: 'unknown-country',
    });
  });
});

describe('regions', () => {
  const blocked = new Set(DEFAULT_BLOCKED_COUNTRIES);

  it('blocks Ontario and Alberta, not the rest of Canada', () => {
    expect(regionBlocked('CA', 'ON', 'Ontario')).toBe(true);
    expect(regionBlocked('ca', 'ab', undefined)).toBe(true);
    expect(regionBlocked('CA', 'BC', 'British Columbia')).toBe(false);
    expect(geoDecision({ countryCode: 'CA', regionCode: 'QC', blocked })).toEqual({
      allowed: true,
    });
  });

  it('blocks Crimea, Sevastopol, Donetsk and Luhansk by code or by name', () => {
    expect(regionBlocked('UA', '43', undefined)).toBe(true);
    expect(regionBlocked('UA', undefined, 'Autonomous Republic of Crimea')).toBe(true);
    expect(regionBlocked('UA', 'UA-40', 'Sevastopol')).toBe(true);
    expect(regionBlocked('UA', undefined, 'Donetsk Oblast')).toBe(true);
    expect(regionBlocked('UA', undefined, 'Lugansk')).toBe(true);
    expect(regionBlocked('UA', '30', 'Kyiv City')).toBe(false);
  });

  it('says a blocked region is a region', () => {
    expect(geoDecision({ countryCode: 'UA', regionName: 'Luhansk', blocked })).toEqual({
      allowed: false,
      reason: 'blocked-region',
    });
  });

  it('does not match a region name to another country', () => {
    expect(regionBlocked('US', undefined, 'Ontario County')).toBe(false);
  });
});
