/**
 * `GET /raffles/:id/events`: the transactions that started a draw, delivered
 * its random number and paid its prize, from the watcher's record
 * (migration 0007).
 *
 * The app used to find these itself by scanning the chain backwards, up to
 * 40 eth_getLogs per lookup against a public RPC that rate-limits. One request
 * here replaces that. An empty answer means the watcher has not seen them:
 * the draw has not got that far, it is seconds old, or it predates the
 * watcher. The chain stays the authority; this only says where to look.
 */

import { Hono } from 'hono';

export type EventLookup = (
  raffleId: bigint,
) => Promise<Partial<Record<string, { txHash: string; blockNumber: string }>>>;

export function raffleEventRoutes(lookup: EventLookup) {
  const app = new Hono();
  app.get('/:id/events', async (c) => {
    const raw = c.req.param('id');
    if (!/^[1-9][0-9]{0,18}$/.test(raw)) return c.json({ error: 'bad raffle id' }, 400);
    const events = await lookup(BigInt(raw));
    // Milestones change a few times per draw; ten seconds of caching is
    // plenty and spares the database a page's worth of polling.
    c.header('Cache-Control', 'public, max-age=10');
    return c.json({ events });
  });
  return app;
}
