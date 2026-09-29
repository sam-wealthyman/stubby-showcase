/**
 * Reading raffle state from the chain.
 *
 * One module, used by both the app and the API, because Section 4.2 makes the
 * chain the source of truth and there is no second opinion to reconcile. The
 * API mirrors what this returns; it never invents it.
 *
 * Reads only. Anything that spends money needs a wallet, which belongs in the
 * app where the user is, not in a shared library.
 */

import { createPublicClient, defineChain, http, type Address, type PublicClient } from 'viem';

import { stubbyRaffleAbi } from './abi/stubbyRaffle.js';
import { d20RandomnessAdapterAbi } from './abi/d20RandomnessAdapter.js';
import { ARC_MAINNET, ARC_TESTNET, type ArcNetwork } from './chains.js';

/**
 * Arc as viem describes a chain.
 *
 * `nativeCurrency.decimals` is 18 because that is the *native* view — the gas
 * denomination. Token amounts in this project are the 6-decimal ERC-20 view,
 * and mixing them is a 10^12 error (see `units.ts`). viem only uses this figure
 * for formatting gas, so it is correct here and must not be copied elsewhere.
 */
export function toViemChain(network: ArcNetwork) {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [network.rpcUrl] } },
    blockExplorers: { default: { name: 'Arc Explorer', url: network.explorerUrl } },
    // The standard Multicall3, deployed on both Arc networks (checked
    // 2026-09-26 with eth_getCode). Naming it lets viem answer many reads with
    // one request, which matters because the public RPC rate-limits.
    contracts: { multicall3: { address: MULTICALL3 } },
    testnet: network.isTestnet,
  });
}

/** Multicall3's address, the same on every chain it is deployed to. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export const arcTestnet = toViemChain(ARC_TESTNET);
export const arcMainnet = toViemChain(ARC_MAINNET);

export interface ClientOptions {
  network?: ArcNetwork;
  /** Override the RPC, e.g. a paid endpoint or a local fork. */
  rpcUrl?: string;
}

/**
 * A read-only client for Arc.
 *
 * The return type is annotated rather than inferred: viem's inferred client
 * type cannot be named portably across package boundaries, and this package
 * emits declarations for the app and the API to consume.
 */
export function createArcClient({
  network = ARC_TESTNET,
  rpcUrl,
}: ClientOptions = {}): PublicClient {
  return createPublicClient({
    chain: toViemChain(network),
    transport: http(rpcUrl ?? network.rpcUrl),
    /*
     * Reads made together go out as one Multicall3 call. Reading every raffle
     * was three requests per raffle plus one; the public Arc RPC answered a
     * visitor with "rate limit exceeded" on 2026-09-26. Now it is one or two.
     */
    batch: { multicall: true },
  });
}

/** Status values as the contract orders them. Do not reorder. */
export const RAFFLE_STATUS = [
  'None',
  'Open',
  'ReadyToDraw',
  'Drawing',
  'Completed',
  'Cancelled',
] as const;
export type RaffleStatus = (typeof RAFFLE_STATUS)[number];

/**
 * A raffle as the app and the API want it.
 *
 * Amounts stay `bigint` in the 6-decimal ERC-20 view, matching `units.ts` and
 * the contract. Nothing here converts to a number: a prize that has passed
 * through a float is a prize that can be wrong.
 */
export interface RaffleState {
  id: bigint;
  status: RaffleStatus;
  prize: bigint;
  entryPrice: bigint;
  totalEntries: number;
  entriesSold: number;
  /** Entries plus any owner top-up, in USDC base units. */
  collected: bigint;
  /** Section 11.5: has the pot reached the prize? */
  prizeCovered: boolean;
  windowEnds: Date;
  winner: Address | null;
  winningEntry: number | null;
  prizeOwed: bigint;
  commissionOwed: bigint;
  prizePaid: boolean;
  /**
   * When randomness was last requested, while Drawing (and after). Null
   * before a draw starts. Optional so a raffle built by hand for a screen
   * need not invent one.
   */
  requestedAt?: Date | null;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Read one raffle. Returns null when the id has never been created. */
export async function readRaffle(
  client: PublicClient,
  raffle: Address,
  id: bigint,
): Promise<RaffleState | null> {
  const [state, collected, prizeCovered] = await Promise.all([
    client.readContract({
      address: raffle,
      abi: stubbyRaffleAbi,
      functionName: 'getRaffle',
      args: [id],
    }),
    client.readContract({
      address: raffle,
      abi: stubbyRaffleAbi,
      functionName: 'collected',
      args: [id],
    }),
    client.readContract({
      address: raffle,
      abi: stubbyRaffleAbi,
      functionName: 'isPrizeCovered',
      args: [id],
    }),
  ]);

  const status = RAFFLE_STATUS[state.status];
  if (status === undefined || status === 'None') return null;

  const settled = status === 'Completed';
  return {
    id,
    status,
    prize: state.prize,
    entryPrice: state.entryPrice,
    totalEntries: state.totalEntries,
    entriesSold: state.entriesSold,
    collected,
    prizeCovered,
    windowEnds: new Date(Number(state.windowEnds) * 1000),
    winner: state.winner === ZERO_ADDRESS ? null : state.winner,
    winningEntry: settled ? state.winningEntry : null,
    prizeOwed: state.prizeOwed,
    commissionOwed: state.commissionOwed,
    prizePaid: state.prizePaid,
    requestedAt: state.requestedAt > 0n ? new Date(Number(state.requestedAt) * 1000) : null,
  };
}

/** How many entries a wallet holds in a raffle. At most 5 (Section 2). */
export async function readEntriesOf(
  client: PublicClient,
  raffle: Address,
  id: bigint,
  wallet: Address,
): Promise<number> {
  return client.readContract({
    address: raffle,
    abi: stubbyRaffleAbi,
    functionName: 'entriesOf',
    args: [id, wallet],
  });
}

/** Every raffle that exists, newest first. */
export async function readAllRaffles(
  client: PublicClient,
  raffle: Address,
): Promise<RaffleState[]> {
  const next = await client.readContract({
    address: raffle,
    abi: stubbyRaffleAbi,
    functionName: 'nextRaffleId',
  });

  const ids = Array.from({ length: Number(next) - 1 }, (_, i) => BigInt(i + 1)).reverse();
  const states = await Promise.all(ids.map((id) => readRaffle(client, raffle, id)));
  return states.filter((state): state is RaffleState => state !== null);
}

/**
 * What the contract must be holding, and what it actually holds.
 *
 * Section 13.3's invariant, readable from outside. The API should alert when
 * `held` drops below `owed`, which should never happen and would mean the
 * contract cannot pay what it owes.
 */
export async function readHoldings(
  client: PublicClient,
  raffle: Address,
  usdc: Address,
): Promise<{ owed: bigint; held: bigint; solvent: boolean }> {
  const [owed, held] = await Promise.all([
    client.readContract({
      address: raffle,
      abi: stubbyRaffleAbi,
      functionName: 'requiredHoldings',
    }),
    client.readContract({
      address: usdc,
      abi: [
        {
          type: 'function',
          name: 'balanceOf',
          stateMutability: 'view',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ] as const,
      functionName: 'balanceOf',
      args: [raffle],
    }),
  ]);
  return { owed, held, solvent: held >= owed };
}

/**
 * The randomness adapter's fee float.
 *
 * Section 13.6's "low randomness-fee balance" alert reads this. An empty float
 * means `startDraw` reverts and no raffle can be drawn — entries and claims are
 * unaffected, but nothing completes. Amounts are the **native 18-decimal view**,
 * because the coordinator charges its fee as `msg.value`.
 */
export async function readFeeFloat(
  client: PublicClient,
  adapter: Address,
): Promise<{ balanceNative: bigint; feeNative: bigint; drawsAffordable: bigint }> {
  const [balanceNative, feeNative, drawsAffordable] = await Promise.all([
    client.readContract({
      address: adapter,
      abi: d20RandomnessAdapterAbi,
      functionName: 'feeBalance',
    }),
    client.readContract({
      address: adapter,
      abi: d20RandomnessAdapterAbi,
      functionName: 'requestFee',
    }),
    client.readContract({
      address: adapter,
      abi: d20RandomnessAdapterAbi,
      functionName: 'requestsAffordable',
    }),
  ]);
  return { balanceNative, feeNative, drawsAffordable };
}
