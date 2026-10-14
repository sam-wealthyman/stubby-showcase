/**
 * Which Arc network the app talks to.
 *
 * One decision, made once, from one variable. The alternative — each screen
 * reaching for a chain id — is how an app ends up reading testnet state while
 * asking a wallet to sign for mainnet.
 */

import { ARC_MAINNET, ARC_TESTNET, arcNetworkByChainId, type ArcNetwork } from '@stubby/shared';

/**
 * Resolve the target network from a chain id.
 *
 * Testnet is the default because the safe mistake is pointing at play money.
 * An unrecognised id throws rather than falling back: a typo that silently
 * selected testnet would look like a working app right up to the point someone
 * expected real USDC to move.
 */
export function selectNetwork(chainIdText: string | undefined): ArcNetwork {
  if (chainIdText === undefined || chainIdText === '') return ARC_TESTNET;

  const chainId = Number(chainIdText);
  if (!Number.isInteger(chainId)) {
    throw new Error(`EXPO_PUBLIC_ARC_CHAIN_ID is not a chain id: ${JSON.stringify(chainIdText)}`);
  }

  const network = arcNetworkByChainId(chainId);
  if (network === undefined) {
    throw new Error(
      `EXPO_PUBLIC_ARC_CHAIN_ID is ${chainId}, which is not an Arc network. ` +
        `Expected ${ARC_TESTNET.chainId} (testnet) or ${ARC_MAINNET.chainId} (mainnet).`,
    );
  }
  return network;
}

/**
 * The network this build targets.
 *
 * Read at module load, so a bad value fails at startup rather than when a user
 * first reaches for their wallet.
 */
export const TARGET_NETWORK = selectNetwork(process.env.EXPO_PUBLIC_ARC_CHAIN_ID);

/**
 * The RPC every read and every wallet call goes through.
 *
 * `EXPO_PUBLIC_ARC_RPC_URL` overrides the network's public endpoint: a private
 * node in production, a local chain in the end-to-end tests. One value for
 * everything, because the override was once honoured by the draw reads and not
 * by wagmi, so balances and receipts came from a different node than the
 * draws they belonged to.
 */
export const TARGET_RPC_URL = process.env.EXPO_PUBLIC_ARC_RPC_URL || TARGET_NETWORK.rpcUrl;
