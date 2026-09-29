import { describe, expect, it } from 'vitest';

import { raffleEventRoutes } from '../src/http/raffleEvents.js';

describe('GET /raffles/:id/events', () => {
  const app = raffleEventRoutes(async (id) =>
    id === 7n ? { Drawn: { txHash: '0xabc', blockNumber: '42' } } : {},
  );

  it('answers what the watcher recorded', async () => {
    const res = await app.request('/7/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=10');
    expect(await res.json()).toEqual({ events: { Drawn: { txHash: '0xabc', blockNumber: '42' } } });
  });

  it('answers empty for a draw it has not seen', async () => {
    expect(await (await app.request('/8/events')).json()).toEqual({ events: {} });
  });

  it('refuses an id that is not a raffle number', async () => {
    for (const bad of ['0', '-1', 'abc', '1e3', '99999999999999999999']) {
      expect((await app.request(`/${bad}/events`)).status, bad).toBe(400);
    }
  });
});
