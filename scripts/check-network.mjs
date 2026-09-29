#!/usr/bin/env node
/**
 * Refuse a build whose network settings do not agree with each other.
 *
 * The site and the APK take their network from three repository variables:
 * the chain id, the raffle address and, optionally, an RPC. Changed by hand,
 * they can drift apart, and the result looks like a working app that reads one
 * network and asks wallets to sign for another. So before anything is built,
 * this asks the chain itself:
 *
 *   - the chain id is Arc testnet or Arc mainnet;
 *   - the RPC answers with that same chain id;
 *   - the raffle address holds contract code on that chain;
 *   - on mainnet, the raffle is the one on record below. A redeploy changes
 *     this line in a reviewed pull request, not only a variable.
 *
 * Plain JSON-RPC over fetch, so it runs before `pnpm install`.
 *
 *   EXPO_PUBLIC_ARC_CHAIN_ID=5042 EXPO_PUBLIC_RAFFLE_ADDRESS=0x… node scripts/check-network.mjs
 */

import { URL } from 'node:url';

const NETWORKS = {
  5042002: { name: 'Arc testnet', rpc: 'https://rpc.testnet.arc.io', raffle: null },
  // docs/mainnet-deploy.md: redeployed 2026-09-27 with the internal review's fixes.
  5042: {
    name: 'Arc mainnet',
    rpc: 'https://rpc.mainnet.arc.io',
    raffle: '0x7213526d82fe7e1a37a26974e343e23ef88bdfa4',
  },
};

function fail(message) {
  console.error(`check-network: ${message}`);
  process.exit(1);
}

const chainId = Number(process.env.EXPO_PUBLIC_ARC_CHAIN_ID);
const network = NETWORKS[chainId];
if (network === undefined) {
  fail(
    `EXPO_PUBLIC_ARC_CHAIN_ID is ${JSON.stringify(process.env.EXPO_PUBLIC_ARC_CHAIN_ID)}, not 5042002 or 5042`,
  );
}

const raffle = (process.env.EXPO_PUBLIC_RAFFLE_ADDRESS ?? '').toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(raffle)) fail('EXPO_PUBLIC_RAFFLE_ADDRESS is not an address');
if (network.raffle !== null && raffle !== network.raffle) {
  fail(
    `${network.name}'s raffle is ${network.raffle}, but EXPO_PUBLIC_RAFFLE_ADDRESS is ${raffle}`,
  );
}

const rpc = process.env.EXPO_PUBLIC_ARC_RPC_URL || network.rpc;

async function call(method, params) {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (body.error) fail(`${method} on ${new URL(rpc).host}: ${body.error.message}`);
  return body.result;
}

const rpcChainId = Number(await call('eth_chainId', []));
if (rpcChainId !== chainId) {
  fail(
    `the RPC ${new URL(rpc).host} is chain ${rpcChainId}, but EXPO_PUBLIC_ARC_CHAIN_ID is ${chainId}`,
  );
}

const code = await call('eth_getCode', [raffle, 'latest']);
if (!code || code === '0x') fail(`${raffle} has no contract code on ${network.name}`);

console.log(`check-network: ${network.name}, raffle ${raffle}, via ${new URL(rpc).host}`);
