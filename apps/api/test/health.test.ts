import { describe, expect, it, vi } from 'vitest';

import { healthRoutes } from '../src/http/health.js';

describe('health', () => {
  it('is ready when the check passes', async () => {
    const res = await healthRoutes(async () => {}).request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('answers 503, and names nothing, when the check fails', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await healthRoutes(async () => {
      throw new Error('password authentication failed for user "stubby"');
    }).request('/');
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('stubby');
    quiet.mockRestore();
  });
});

describe('health/all', () => {
  it('names each check and is ready only when all pass', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = healthRoutes(async () => {}, {
      mail: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:25');
      },
      watcher: async () => {},
    });
    const res = await app.request('/all');
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({
      ok: false,
      checks: { database: true, mail: false, watcher: true },
    });
    expect(body).not.toContain('ECONNREFUSED');
    quiet.mockRestore();
  });

  it('leaves /health to the database alone, so the deploy is not held hostage by mail', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = healthRoutes(async () => {}, {
      mail: async () => {
        throw new Error('down');
      },
    });
    expect((await app.request('/')).status).toBe(200);
    quiet.mockRestore();
  });
});
