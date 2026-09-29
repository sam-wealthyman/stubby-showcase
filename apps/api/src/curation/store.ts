/**
 * The owner's featured draw and draw order (migration 0014). Display only:
 * read by the app to arrange the home page, written from the control room.
 */

import type pg from 'pg';

export interface Scope {
  chainId: number;
  contract: string;
}

export interface Curation {
  /** The featured draw's id, or null for the app's own choice. */
  featured: string | null;
  /** Draw ids in the owner's order. Draws not listed follow in the app's order. */
  order: string[];
}

export async function readCuration(pool: pg.Pool, scope: Scope): Promise<Curation> {
  const { rows } = await pool.query<{ raffle_id: string; featured: boolean }>(
    `SELECT raffle_id::text, featured FROM draw_curation
      WHERE chain_id = $1 AND contract = $2
      ORDER BY position`,
    [scope.chainId, scope.contract.toLowerCase()],
  );
  return {
    featured: rows.find((r) => r.featured)?.raffle_id ?? null,
    order: rows.map((r) => r.raffle_id),
  };
}

/**
 * Replace the whole arrangement in one transaction, so a reader never sees
 * half an order. A featured draw not in the order is placed first.
 */
export async function writeCuration(
  pool: pg.Pool,
  scope: Scope,
  next: Curation,
): Promise<Curation> {
  const order = [...new Set(next.order)];
  if (next.featured !== null && !order.includes(next.featured)) order.unshift(next.featured);
  const contract = scope.contract.toLowerCase();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM draw_curation WHERE chain_id = $1 AND contract = $2', [
      scope.chainId,
      contract,
    ]);
    for (const [position, id] of order.entries()) {
      await client.query(
        `INSERT INTO draw_curation (chain_id, contract, raffle_id, position, featured)
         VALUES ($1, $2, $3, $4, $5)`,
        [scope.chainId, contract, id, position, id === next.featured],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return readCuration(pool, scope);
}
