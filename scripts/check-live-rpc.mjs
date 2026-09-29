/**
 * Make the reads the watcher and the app make, against Arc testnet's real
 * public RPC.
 *
 * The end-to-end tests run on Anvil, which accepts requests the public RPC
 * refuses. On 2026-09-26 that let a watcher change through every test and
 * then stall in production: a log filter naming all 17 of the contract's
 * event types was "requested range too large" even for 70 blocks. This runs
 * the watcher's own built code (apps/api/dist), not a copy, so a request the
 * RPC will not serve fails here first.
 *
 *   RAFFLE_CONTRACT_ADDRESS=0x… node scripts/check-live-rpc.mjs
 *
 * The public RPC also rate-limits, so each read gets a few tries before a
 * failure counts; a refusal of the request's shape does not go away on retry.
 */

import { ARC_TESTNET, createArcClient, readAllRaffles } from '@stubby/shared';

import { viemChainReader } from '../apps/api/dist/watch/chain.js';

const contract = process.env.RAFFLE_CONTRACT_ADDRESS;
if (!contract) {
  console.error('RAFFLE_CONTRACT_ADDRESS is not set');
  process.exit(1);
}

const client = createArcClient({ network: ARC_TESTNET });
const watcher = viemChainReader(client, contract);

async function tries(name, read) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const detail = await read();
      console.log(`  ok   ${name}${detail ? ` · ${detail}` : ''}`);
      return true;
    } catch (error) {
      const message = (error?.shortMessage ?? error?.message ?? String(error)).split('\n')[0];
      const shape = /range too large|too many|invalid|not supported/i.test(message);
      if (attempt >= 3 || shape) {
        console.log(`  FAIL ${name} · ${message}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
}

const head = await client.getBlockNumber();
const results = [
  await tries('app: every raffle, batched through Multicall3', async () => {
    const raffles = await readAllRaffles(client, contract);
    return `${raffles.length} raffles`;
  }),
  // The watcher's own range: tick.ts reads 2,000 blocks at a time.
  await tries('watcher: logs over 2,000 blocks', async () => {
    const { entries, events } = await watcher.logs(head - 1999n, head);
    return `${entries.length} entries, ${events.length} events`;
  }),
  await tries(
    'watcher: randomness timeout',
    async () => `${await watcher.randomnessTimeoutMs()} ms`,
  ),
  await tries('watcher: solvency', async () => `solvent: ${await watcher.solvent()}`),
  await tries(
    'watcher: randomness float',
    async () => `${await watcher.requestsAffordable()} draws`,
  ),
];

if (results.some((ok) => !ok)) process.exit(1);
