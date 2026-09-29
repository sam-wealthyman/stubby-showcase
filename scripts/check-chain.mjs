#!/usr/bin/env node
/**
 * Read the deployed contracts and report anything that needs attention.
 *
 * This is the first half of Section 13.6's monitoring, in the form that can
 * exist before there is an API to run it in: the checks themselves, runnable by
 * hand or on a timer. Wiring them to alerts is the API's job.
 *
 * Three things are worth waking someone for:
 *
 *   - **Insolvency.** The contract holding less than it owes should be
 *     impossible; the invariant tests say so. If it ever happens, it is the
 *     most serious thing that can go wrong, so it is checked first.
 *   - **An empty fee float.** `startDraw` reverts and no raffle can be drawn.
 *     Entries and claims keep working, so nothing looks broken to a
 *     participant until a full raffle simply never draws.
 *   - **A stuck draw.** A raffle in Drawing for longer than the randomness
 *     timeout means the coordinator has not answered. Anyone can re-request,
 *     but somebody has to notice first.
 *
 *   node scripts/check-chain.mjs
 */

import { readFileSync } from 'node:fs';

import {
  createArcClient,
  formatUsdc,
  readAllRaffles,
  readFeeFloat,
  readHoldings,
  ARC_TESTNET,
  ARC_MAINNET,
} from '../packages/shared/dist/index.js';

/** Draws remaining below which the float wants topping up. */
const LOW_FLOAT_DRAWS = 5n;

/*
 * The environment wins over the `.env` file.
 *
 * This used to read the file and nothing else, which made it impossible to
 * point at another network without editing `.env` — the one thing the mainnet
 * runbook says never to do. Worse, it failed silently: given mainnet values on
 * the command line it printed "Arc Testnet" and listed the testnet raffles,
 * and because the contracts deployed to the SAME address on both chains
 * (same deployer, same nonce, same CREATE address) the output was
 * indistinguishable from a correct one.
 */
const fromFile = new Map(
  (() => {
    try {
      return readFileSync('.env', 'utf8').split('\n');
    } catch {
      return [];
    }
  })()
    .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()))
    .filter((m) => m !== null)
    .map((m) => [m[1], m[2]]),
);

const env = new Map(fromFile);
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && value !== '') env.set(key, value);
}

const need = (name) => {
  const value = env.get(name);
  if (!value) {
    console.error(`${name} is not set, in the environment or in .env`);
    process.exit(1);
  }
  return value;
};

const chainId = Number(need('ARC_CHAIN_ID'));
const network = chainId === ARC_MAINNET.chainId ? ARC_MAINNET : ARC_TESTNET;
const client = createArcClient({ network, rpcUrl: env.get('ARC_RPC_URL') });
const raffleAddress = need('RAFFLE_CONTRACT_ADDRESS');
const adapterAddress = need('ADAPTER_ADDRESS');
const usdcAddress = need('USDC_ADDRESS');

/*
 * Ask the chain who it is before believing anything it says.
 *
 * `ARC_CHAIN_ID` only picks which explorer and defaults to use; the RPC decides
 * which chain is actually read. A mismatch means every figure below is about a
 * different network from the one named at the top, which is how a healthy
 * testnet gets mistaken for a healthy mainnet.
 */
const actualChainId = await client.getChainId();
if (actualChainId !== chainId) {
  console.error(
    `\nARC_CHAIN_ID says ${chainId} but the RPC answers ${actualChainId}. ` +
      `Refusing to report on a network you did not ask for.\n`,
  );
  process.exit(1);
}

let alerts = 0;
const alert = (text) => {
  console.log(`  \u001b[31m!\u001b[0m ${text}`);
  alerts += 1;
};
const note = (text) => console.log(`  \u001b[32m✓\u001b[0m ${text}`);

console.log(`\n${network.name} (chain ${actualChainId}) · ${raffleAddress}\n`);

// 1. Solvency, first because it is the one that must never be true.
const holdings = await readHoldings(client, raffleAddress, usdcAddress);
if (holdings.solvent) {
  note(
    `solvent: holds ${formatUsdc(holdings.held)} USDC against ${formatUsdc(holdings.owed)} owed`,
  );
} else {
  alert(
    `INSOLVENT: holds ${formatUsdc(holdings.held)} USDC but owes ${formatUsdc(holdings.owed)}. ` +
      `This should be impossible.`,
  );
}

// 2. The fee float. Native 18-decimal view, since the coordinator charges msg.value.
const float = await readFeeFloat(client, adapterAddress);
const asUsdc = (native) => (Number(native) / 1e18).toFixed(3);
if (float.drawsAffordable === 0n) {
  alert(`fee float is empty (${asUsdc(float.balanceNative)} USDC) — NO RAFFLE CAN DRAW`);
} else if (float.drawsAffordable < LOW_FLOAT_DRAWS) {
  alert(
    `fee float is low: ${float.drawsAffordable} draws left (${asUsdc(float.balanceNative)} USDC)`,
  );
} else {
  note(`fee float: ${asUsdc(float.balanceNative)} USDC, ${float.drawsAffordable} draws affordable`);
}

// 3. Raffles, and anything stuck.
const raffles = await readAllRaffles(client, raffleAddress);
console.log(`\n  ${raffles.length} raffle(s)\n`);
const now = Date.now();
for (const raffle of raffles) {
  const line =
    `  #${raffle.id} ${raffle.status.padEnd(11)} ` +
    `${formatUsdc(raffle.prize)} USDC · ${raffle.entriesSold}/${raffle.totalEntries} sold`;
  console.log(line);

  if (raffle.status === 'Drawing') {
    alert(`  raffle #${raffle.id} is Drawing — if it stays here, call reRequestRandomness`);
  }
  if (raffle.status === 'ReadyToDraw') {
    alert(`  raffle #${raffle.id} is full and waiting: anyone can call startDraw`);
  }
  if (raffle.status === 'Completed' && !raffle.prizePaid) {
    console.log(
      `     prize of ${formatUsdc(raffle.prizeOwed)} USDC unclaimed by ${raffle.winner}` +
        ` — this is fine, there is no deadline`,
    );
  }
  if (raffle.status === 'Open' && raffle.windowEnds.getTime() < now) {
    console.log(`     window closed ${raffle.windowEnds.toISOString()} — anyone can extendWindow`);
  }
}

console.log(`\n${alerts} alert(s)\n`);
process.exit(alerts > 0 ? 1 : 0);
