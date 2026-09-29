import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';

import { sessionTokenFrom } from '../auth/bearer.js';
import type { SessionStore } from '../auth/sessionStore.js';
import { SESSION_COOKIE } from '../auth/siweRoutes.js';
import type { Curation } from '../curation/store.js';

export interface CurationRouteOptions {
  sessions: SessionStore;
  read(): Promise<Curation>;
  write(next: Curation): Promise<Curation>;
  /** Whether this address owns the raffle contract. */
  isOwner(address: string): Promise<boolean>;
}

/** A draw id as the contract numbers them: a positive integer, as text. */
const ID = /^[1-9][0-9]{0,18}$/;
/** More than any home page will show; a bound on what one request can write. */
const MAX_ORDER = 500;

/**
 * The owner's featured draw and draw order: anyone may read it (the home page
 * does), only the contract's owner may change it, from the control room.
 */
export function curationRoutes(options: CurationRouteOptions) {
  const owner = async (c: Context): Promise<boolean> => {
    const token = sessionTokenFrom({
      authorization: c.req.header('authorization'),
      cookie: getCookie(c, SESSION_COOKIE),
    });
    if (token === undefined) return false;
    const s = await options.sessions.resolve(token);
    return s?.address ? options.isOwner(s.address) : false;
  };

  return new Hono()
    .get('/draws/curation', async (c) => {
      c.header('cache-control', 'no-store');
      return c.json(await options.read());
    })
    .post('/admin/draws/curation', async (c) => {
      if (!(await owner(c))) return c.json({ reason: 'not-owner' }, 403);
      const body = (await c.req.json().catch(() => ({}))) as {
        featured?: unknown;
        order?: unknown;
      };
      const featured = body.featured ?? null;
      const order = body.order;
      if (
        (featured !== null && (typeof featured !== 'string' || !ID.test(featured))) ||
        !Array.isArray(order) ||
        order.length > MAX_ORDER ||
        !order.every((id) => typeof id === 'string' && ID.test(id))
      ) {
        return c.json({ reason: 'malformed' }, 400);
      }
      return c.json(await options.write({ featured, order: order as string[] }));
    });
}
