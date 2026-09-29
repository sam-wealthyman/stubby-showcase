import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPostgresSessionStore, type SessionStore } from '../src/auth/sessionStore.js';
import { readCuration, writeCuration } from '../src/curation/store.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { curationRoutes } from '../src/http/curation.js';

const DATABASE_URL = process.env.DATABASE_URL;
const CHAIN_ID = 5042002;
const CONTRACT = '0x00000000000000000000000000000000000c0a7e';
const OWNER = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';
const scope = { chainId: CHAIN_ID, contract: CONTRACT };

describe.skipIf(!DATABASE_URL)('draw curation', () => {
  let pool: pg.Pool;
  let sessions: SessionStore;
  const accounts: string[] = [];

  beforeAll(async () => {
    pool = createPool({ max: 3 });
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
    sessions = createPostgresSessionStore(pool);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM draw_curation WHERE contract = $1', [CONTRACT]);
  });

  afterAll(async () => {
    await pool?.query('DELETE FROM draw_curation WHERE contract = $1', [CONTRACT]);
    await pool?.query('DELETE FROM account WHERE id = ANY($1)', [accounts]);
    await pool?.end();
  });

  it('starts empty, then keeps an order with one featured draw', async () => {
    expect(await readCuration(pool, scope)).toEqual({ featured: null, order: [] });
    const saved = await writeCuration(pool, scope, { featured: '3', order: ['2', '3', '5'] });
    expect(saved).toEqual({ featured: '3', order: ['2', '3', '5'] });
  });

  it('replaces the whole arrangement, and places a featured draw that was not listed first', async () => {
    await writeCuration(pool, scope, { featured: '3', order: ['2', '3', '5'] });
    const saved = await writeCuration(pool, scope, { featured: '9', order: ['5', '5', '2'] });
    expect(saved).toEqual({ featured: '9', order: ['9', '5', '2'] });
  });

  it('can clear the featured draw', async () => {
    await writeCuration(pool, scope, { featured: '3', order: ['3'] });
    expect(await writeCuration(pool, scope, { featured: null, order: ['3'] })).toEqual({
      featured: null,
      order: ['3'],
    });
  });

  it('lets anyone read, and only the owner write', async () => {
    const app = curationRoutes({
      sessions,
      read: () => readCuration(pool, scope),
      write: (next) => writeCuration(pool, scope, next),
      isOwner: async (address) => address === OWNER,
    });
    const asOwner = await sessions.issue({
      accountId: await account(),
      wallet: { address: OWNER, chainId: CHAIN_ID },
    });
    const asOther = await sessions.issue({
      accountId: await account(),
      wallet: { address: OTHER, chainId: CHAIN_ID },
    });
    const save = (token: string | undefined, body: unknown) =>
      app.request('/admin/draws/curation', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });

    expect((await save(undefined, { featured: null, order: ['1'] })).status).toBe(403);
    expect((await save(asOther.token, { featured: null, order: ['1'] })).status).toBe(403);
    expect((await save(asOwner.token, { featured: 'x', order: [] })).status).toBe(400);
    expect((await save(asOwner.token, { featured: null, order: ['0'] })).status).toBe(400);
    expect((await save(asOwner.token, { featured: null, order: 'nope' })).status).toBe(400);

    const ok = await save(asOwner.token, { featured: '4', order: ['4', '2'] });
    expect(ok.status).toBe(200);
    const read = await app.request('/draws/curation');
    expect(await read.json()).toEqual({ featured: '4', order: ['4', '2'] });
  });

  async function account(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO account DEFAULT VALUES RETURNING id',
    );
    accounts.push(rows[0]!.id);
    return rows[0]!.id;
  }
});
