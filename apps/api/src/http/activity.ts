/**
 * `GET /activity`: the newest wins and ticket purchases, for the live strip,
 * from the watcher's record, and the players row's numbers (`stats`) when the
 * server supplies them. Public, and short-cached: every open Home screen asks,
 * and a fifteen-second-old feed is still live.
 */

import { Hono } from 'hono';

import type { ActivityItem, ActivityStats } from '../watch/store.js';

export function activityRoutes(
  recent: () => Promise<ActivityItem[]>,
  stats?: () => Promise<ActivityStats>,
) {
  const app = new Hono();
  app.get('/', async (c) => {
    c.header('Cache-Control', 'public, max-age=15');
    const [items, numbers] = await Promise.all([recent(), stats?.()]);
    return c.json(numbers ? { items, stats: numbers } : { items });
  });
  return app;
}
