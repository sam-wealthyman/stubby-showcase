/**
 * Arc network configuration.
 *
 * One source of truth for the app, the API and the deploy scripts, so a chain
 * id or a coordinator address is never retyped.
 *
 * Every value here was read from an authoritative source on 2026-09-21:
 * network details from Circle's docs, and the VRF coordinator addresses from
 * D20DAO's own deployment manifests. D20DAO's guidance is that the manifest is
 * authoritative and addresses should be checked against it rather than
 * hard-coded, so `manifestUrl` is kept alongside each address and
 * `packages/shared/test/chains.test.ts` is where a drift check would go.
 *
 * @see https://docs.arc.io/arc/references/connect-to-arc
 * @see https://docs.arc.io/arc/references/contract-addresses
 */

export type Address = `0x${string}`;

export interface ArcNetwork {
  readonly name: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  /** Where to get test USDC. Testnet only. */
  readonly faucetUrl?: string;
  /**
   * USDC. The same address serves the native gas token and the ERC-20
   * interface, which share one balance but differ by 10^12 — see `units.ts`.
   */
  readonly usdc: Address;
  /** D20DAO VRF coordinator proxy. Call this, not the implementation. */
  readonly vrfCoordinator: Address;
  /** D20DAO's deployment manifest, which is authoritative for the above. */
  readonly vrfManifestUrl: string;
  /**
   * Minimum base fee in Gwei. Arc's mempool silently drops transactions whose
   * `maxFeePerGas` is below this, so a client that ignores it sees a
   * transaction simply vanish.
   */
  readonly minBaseFeeGwei: number;
  readonly isTestnet: boolean;
}

/** USDC lives at the same address on both networks. */
export const USDC_ADDRESS: Address = '0x3600000000000000000000000000000000000000';

/** Arc's mempool floor. Below this, transactions are dropped without an error. */
export const MIN_BASE_FEE_GWEI = 20;

export const ARC_TESTNET: ArcNetwork = {
  name: 'Arc Testnet',
  chainId: 5_042_002,
  rpcUrl: 'https://rpc.testnet.arc.io',
  explorerUrl: 'https://explorer.testnet.arc.io',
  faucetUrl: 'https://faucet.circle.com',
  usdc: USDC_ADDRESS,
  vrfCoordinator: '0xd20DA0FF9087d053f0291524Eac12abA1ADBd945',
  vrfManifestUrl: 'https://d20dao.org/deployments/arc-testnet.json',
  minBaseFeeGwei: MIN_BASE_FEE_GWEI,
  isTestnet: true,
};

export const ARC_MAINNET: ArcNetwork = {
  name: 'Arc',
  chainId: 5_042,
  rpcUrl: 'https://rpc.mainnet.arc.io',
  explorerUrl: 'https://explorer.arc.io',
  usdc: USDC_ADDRESS,
  vrfCoordinator: '0xd20da057469C45928912d983F45790C41e290571',
  vrfManifestUrl: 'https://d20dao.org/deployments/arc-mainnet.json',
  minBaseFeeGwei: MIN_BASE_FEE_GWEI,
  isTestnet: false,
};

export const ARC_NETWORKS: readonly ArcNetwork[] = [ARC_TESTNET, ARC_MAINNET];

/** Local Anvil, where the mock USDC and dev randomness are deployed fresh. */
export const LOCAL_CHAIN_IDS: readonly number[] = [31_337, 1_337];

export function isLocalChain(chainId: number): boolean {
  return LOCAL_CHAIN_IDS.includes(chainId);
}

/** Look a network up by chain id. Returns undefined for anything else. */
export function arcNetworkByChainId(chainId: number): ArcNetwork | undefined {
  return ARC_NETWORKS.find((network) => network.chainId === chainId);
}

/** A link to a transaction on the right explorer. */
export function txUrl(network: ArcNetwork, txHash: string): string {
  return `${network.explorerUrl}/tx/${txHash}`;
}

/** A link to an address on the right explorer. */
export function addressUrl(network: ArcNetwork, address: string): string {
  return `${network.explorerUrl}/address/${address}`;
}
