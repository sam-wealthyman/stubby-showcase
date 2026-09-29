/**
 * Readiness: whether this process can actually serve a request.
 *
 * `/` answers as long as Node is running, which is what a process supervisor
 * wants to know. A deploy wants more: a new build that starts but cannot reach
 * Postgres (a wrong certificate, a migration that locked a table) answers `/`
 * perfectly and fails every sign-in. So the deploy's install script waits on
 * `/health`, which checks the database, and rolls back when it does not come
 * good.
 *
 * `/health/all` is for monitoring, and checks everything the product needs
 * besides: the mail relay and the watcher. It is kept apart from `/health` on
 * purpose. A mail outage is not the new build's fault, and must not make a
 * good deploy roll itself back. The mail relay being stopped for 23 hours
 * after a reboot (2026-09-25) is why it exists: nothing noticed until a
 * deploy's smoke test tried to send a login link.
 *
 * Neither says why a check failed. The reason is in the service's own log;
 * on the public origin it would describe the machine to anyone.
 */

import { Hono } from 'hono';

export type Check = () => Promise<void>;

/** A check that has not answered in this long has failed. */
export const CHECK_TIMEOUT_MS = 5_000;

async function passes(name: string, check: Check): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (error) {
    console.error(`health check ${name} failed:`, error instanceof Error ? error.message : error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function healthRoutes(database: Check, more: Record<string, Check> = {}) {
  const app = new Hono();
  app.get('/', async (c) =>
    (await passes('database', database)) ? c.json({ ok: true }) : c.json({ ok: false }, 503),
  );
  app.get('/all', async (c) => {
    const all: Record<string, Check> = { database, ...more };
    const names = Object.keys(all);
    const results = await Promise.all(names.map((name) => passes(name, all[name]!)));
    const checks = Object.fromEntries(names.map((name, i) => [name, results[i]!]));
    const ok = results.every(Boolean);
    return c.json({ ok, checks }, ok ? 200 : 503);
  });
  return app;
}
