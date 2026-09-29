/**
 * GET /geo: may this visitor buy tickets from here? (Section 11.9)
 *
 * Asked by the app before it offers the buy slider, not while browsing, and
 * never for claiming: a prize already won is owed wherever its winner is.
 * The answer names the reason, so the app can say what to do (turn off a VPN)
 * or that buying is not offered in their country.
 */

import { Hono } from 'hono';

import { geoDecision } from '@stubby/shared';

import { isPrivateAddress, type GeoLookup } from '../geo/lookup.js';
import { clientIp } from './clientIp.js';

export function geoRoutes(lookup: GeoLookup, blocked: ReadonlySet<string>) {
  return new Hono().get('/', async (c) => {
    const ip = clientIp(c);
    if (isPrivateAddress(ip)) return c.json({ allowed: true as const });
    const facts = await lookup(ip);
    const decision = geoDecision({
      countryCode: facts?.countryCode,
      regionCode: facts?.regionCode,
      regionName: facts?.regionName,
      anonymised: facts?.anonymised ?? false,
      blocked,
    });
    c.header('Cache-Control', 'private, max-age=600');
    return c.json(
      decision.allowed
        ? { allowed: true as const }
        : { allowed: false as const, reason: decision.reason, country: facts?.countryCode ?? null },
    );
  });
}
