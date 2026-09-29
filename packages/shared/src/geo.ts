/**
 * Geo-restriction (Section 11.9).
 *
 * The blocklist lives here rather than only in an environment variable so it is
 * visible in review, testable, and carries the reason each entry is on it. The
 * `BLOCKED_COUNTRY_CODES` variable overrides it, so a change does not need a
 * deploy.
 *
 * **This is a starting point assembled from published sources, not legal
 * advice.** The sanctions tier is mechanical. The licensing tier is a judgement
 * about where a paid-entry prize draw needs a licence, and it is the part that
 * needs a lawyer who knows the operating jurisdiction before launch. Getting it
 * wrong in the permissive direction is the expensive mistake, so the default
 * errs toward blocking.
 *
 * Some restrictions are regions, not countries: Crimea, Donetsk and Luhansk
 * (OFAC), and the Canadian provinces of Ontario and Alberta, which license
 * online gambling themselves. Blocking `UA` or `CA` outright would overshoot,
 * so regions are matched on the sub-division the IP provider returns — by
 * ISO 3166-2 code, and by name, since providers disagree on codes.
 */

/**
 * Comprehensively sanctioned by OFAC: effectively all transactions prohibited
 * without a licence. Verified 2026-09-22.
 *
 * @see https://ofac.treasury.gov/sanctions-programs-and-country-information
 */
export const OFAC_COMPREHENSIVE = ['CU', 'IR', 'KP', 'SY'] as const;

/**
 * FATF "high-risk jurisdictions subject to a call for action" — the blacklist.
 * Iran and North Korea already appear above; Myanmar is the addition.
 *
 * @see https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions.html
 */
export const FATF_CALL_FOR_ACTION = ['MM'] as const;

/**
 * Russia and Belarus: extensive US, UK and EU sanctions. By the platform
 * owner's decision, 2026-09-27.
 */
export const RUSSIA_BELARUS = ['RU', 'BY'] as const;

/**
 * Restricted by the platform owner's decision, 2026-09-27: the United States
 * and the United Kingdom (licensed gambling regimes; see the licensing tier
 * below) and mainland China (crypto trading and gambling prohibited).
 */
export const OWNER_RESTRICTED = ['US', 'GB', 'CN'] as const;

/**
 * Jurisdictions where a paid-entry prize draw is commonly licensed, monopolised
 * or prohibited, so operating without a licence carries real exposure.
 *
 * Every entry here costs real users, and each deserves an explicit decision
 * rather than inheriting this default:
 *
 * - `US` state lottery monopolies, plus federal wire-transmission exposure
 * - `GB` Gambling Commission licensing
 * - `AU` Interactive Gambling Act
 * - `SG` Remote Gambling Act
 * - `FR` `NL` `BE` `IT` `ES` licensed regimes with active enforcement
 *
 * The brief calls Stubby a raffle. Paid entry plus a prize decided by chance is
 * the textbook definition of a lottery in most of these places, which is a
 * licensing question rather than a geo-blocking one — see Section 11.9.
 */
export const LICENSING_RISK = ['US', 'GB', 'AU', 'SG', 'FR', 'NL', 'BE', 'IT', 'ES'] as const;

/**
 * The default blocklist: sanctions, FATF, Russia and Belarus, and the owner's
 * restrictions (US, GB, CN), as decided on 2026-09-27.
 *
 * The rest of the licensing tier is kept above but not applied, pending a
 * lawyer's reading (Section 11.9). `BLOCKED_COUNTRY_CODES` on the server
 * replaces this list, no release needed.
 */
export const DEFAULT_BLOCKED_COUNTRIES: readonly string[] = [
  ...OFAC_COMPREHENSIVE,
  ...FATF_CALL_FOR_ACTION,
  ...RUSSIA_BELARUS,
  ...OWNER_RESTRICTED,
];

/**
 * Regions blocked where their country is not: ISO 3166-2 codes, each with the
 * names a provider may give instead of (or as well as) the code.
 *
 * - `UA-43` Crimea, `UA-40` Sevastopol, `UA-14` Donetsk, `UA-09` Luhansk:
 *   OFAC sanctions (Executive Orders 13685 and 14065). An address there that
 *   geolocates to Russia is already refused as Russia.
 * - `CA-ON` Ontario, `CA-AB` Alberta: provincially licensed online gambling,
 *   by the platform owner's decision, 2026-09-27.
 */
export const BLOCKED_REGIONS: Readonly<Record<string, readonly string[]>> = {
  'UA-43': ['crimea', 'krym'],
  'UA-40': ['sevastopol'],
  'UA-14': ['donetsk'],
  'UA-09': ['luhansk', 'lugansk'],
  'CA-ON': ['ontario'],
  'CA-AB': ['alberta'],
};

/**
 * Whether a region is blocked, by code or by name. `regionCode` is the part
 * after the country ("ON", "43"); names match on a known word ("Donetsk
 * Oblast", "Autonomous Republic of Crimea").
 */
export function regionBlocked(
  countryCode: string | undefined,
  regionCode: string | undefined,
  regionName: string | undefined,
  blocked: Readonly<Record<string, readonly string[]>> = BLOCKED_REGIONS,
): boolean {
  if (!countryCode) return false;
  const country = countryCode.toUpperCase();
  const code = regionCode ? `${country}-${regionCode.toUpperCase().replace(/^.*-/, '')}` : '';
  if (code && code in blocked) return true;
  const name = (regionName ?? '').toLowerCase();
  if (!name) return false;
  return Object.entries(blocked).some(
    ([key, words]) => key.startsWith(`${country}-`) && words.some((word) => name.includes(word)),
  );
}

const ISO_3166_1_ALPHA_2 = /^[A-Z]{2}$/;

export class BlocklistError extends Error {
  override readonly name = 'BlocklistError';
}

/**
 * Parse `BLOCKED_COUNTRY_CODES` into a set.
 *
 * Throws on anything that is not a two-letter code. A typo that silently
 * becomes "not blocked" is the failure worth preventing: it looks like
 * diligence and is not.
 *
 * An empty or absent value yields an empty set, which blocks nobody. That is
 * only correct if it is deliberate, which is why the caller has to pass
 * `undefined` explicitly to get the default.
 */
export function parseBlockedCountries(value: string | undefined): ReadonlySet<string> {
  if (value === undefined) return new Set(DEFAULT_BLOCKED_COUNTRIES);

  const codes = value
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code.length > 0);

  for (const code of codes) {
    if (!ISO_3166_1_ALPHA_2.test(code)) {
      throw new BlocklistError(`Not an ISO 3166-1 alpha-2 country code: ${JSON.stringify(code)}`);
    }
  }

  return new Set(codes);
}

export interface GeoDecisionInput {
  /** `isocode` from the IP provider. Undefined when it could not be resolved. */
  countryCode?: string | undefined;
  /** Whether the provider flagged the address as a VPN, proxy, Tor or relay. */
  anonymised?: boolean;
  /** The provider's sub-division code and name, for region blocks. */
  regionCode?: string | undefined;
  regionName?: string | undefined;
  blocked: ReadonlySet<string>;
  /** Blocked regions; defaults to BLOCKED_REGIONS. */
  blockedRegions?: Readonly<Record<string, readonly string[]>>;
  /**
   * Whether an unresolvable country is refused.
   *
   * Section 11.9 checks at deposit time only, so a refusal here stops someone
   * spending money, not someone browsing. Defaults to false: refusing every
   * address the provider cannot place would turn a provider outage into a total
   * outage, and the raffle contract is permissionless anyway, so this control
   * was never a technical barrier.
   */
  refuseUnknown?: boolean;
}

export type GeoDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'blocked-country' | 'blocked-region' | 'anonymised' | 'unknown-country';
    };

/**
 * Decide whether a deposit may proceed (Section 11.9).
 *
 * Deliberately not applied to browsing: the brief rejects checking everywhere
 * as friction and false positives for little gain.
 */
export function geoDecision({
  countryCode,
  anonymised = false,
  regionCode,
  regionName,
  blocked,
  blockedRegions = BLOCKED_REGIONS,
  refuseUnknown = false,
}: GeoDecisionInput): GeoDecision {
  if (countryCode === undefined || countryCode === '') {
    return refuseUnknown ? { allowed: false, reason: 'unknown-country' } : { allowed: true };
  }
  if (blocked.has(countryCode.toUpperCase())) {
    return { allowed: false, reason: 'blocked-country' };
  }
  if (regionBlocked(countryCode, regionCode, regionName, blockedRegions)) {
    return { allowed: false, reason: 'blocked-region' };
  }
  if (anonymised) return { allowed: false, reason: 'anonymised' };
  return { allowed: true };
}
