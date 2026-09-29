/**
 * What the watcher reads from the chain, behind an interface so the tests can
 * hand it a chain of their own. The real one is a few viem calls.
 */

import {
  USDC_ADDRESS,
  d20RandomnessAdapterAbi,
  readAllRaffles,
  readHoldings,
  stubbyRaffleAbi,
  type RaffleState,
} from '@stubby/shared';
import { parseEventLogs, type Address, type PublicClient } from 'viem';

export interface EntryLog {
  raffleId: bigint;
  wallet: Address;
  count: number;
  paid: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
  logIndex: number;
}

/** The draw's milestones, whose transactions the proof links to. */
export const RAFFLE_EVENTS = ['DrawStarted', 'Drawn', 'PrizeClaimed'] as const;
export type RaffleEventKind = (typeof RAFFLE_EVENTS)[number];

export interface RaffleEventLog {
  raffleId: bigint;
  kind: RaffleEventKind;
  blockNumber: bigint;
  txHash: `0x${string}`;
  logIndex: number;
}

export interface ChainLogs {
  entries: EntryLog[];
  events: RaffleEventLog[];
}

export interface ChainReader {
  raffles(): Promise<RaffleState[]>;
  head(): Promise<bigint>;
  /** Everything the raffle contract logged in a range, in one request. */
  logs(fromBlock: bigint, toBlock: bigint): Promise<ChainLogs>;
  randomnessTimeoutMs(): Promise<number>;
  solvent(): Promise<boolean>;
  /** Undefined when the randomness source has no float (a mock, locally). */
  requestsAffordable(): Promise<bigint | undefined>;
  /** A scheduled randomness source, if any, and when it may take effect. */
  pendingRandomness(): Promise<{ source: Address; activatesAt: Date } | undefined>;
}

export function viemChainReader(client: PublicClient, raffle: Address): ChainReader {
  return {
    raffles: () => readAllRaffles(client, raffle),
    head: () => client.getBlockNumber(),
    async logs(fromBlock, toBlock) {
      // Filtered by address only, then decoded here. Asking for the event
      // types by topic sent all 17 of the contract's in one filter, and Arc's
      // public RPC refuses that as "requested range too large" even for 70
      // blocks; it stalled the watcher on its first deploy.
      const raw = await client.getLogs({ address: raffle, fromBlock, toBlock });
      const logs = parseEventLogs({ abi: stubbyRaffleAbi, logs: raw });
      const entries: EntryLog[] = [];
      const events: RaffleEventLog[] = [];
      for (const log of logs) {
        if (log.eventName === 'Entered') {
          entries.push({
            raffleId: log.args.raffleId!,
            wallet: log.args.wallet!,
            count: log.args.count!,
            paid: log.args.paid!,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
          });
        } else if ((RAFFLE_EVENTS as readonly string[]).includes(log.eventName)) {
          events.push({
            raffleId: (log.args as { raffleId: bigint }).raffleId,
            kind: log.eventName as RaffleEventKind,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
          });
        }
      }
      return { entries, events };
    },
    async randomnessTimeoutMs() {
      const seconds = await client.readContract({
        address: raffle,
        abi: stubbyRaffleAbi,
        functionName: 'randomnessTimeout',
      });
      return Number(seconds) * 1000;
    },
    async solvent() {
      return (await readHoldings(client, raffle, USDC_ADDRESS)).solvent;
    },
    async pendingRandomness() {
      const [source, at] = await Promise.all([
        client.readContract({
          address: raffle,
          abi: stubbyRaffleAbi,
          functionName: 'pendingRandomness',
        }),
        client.readContract({
          address: raffle,
          abi: stubbyRaffleAbi,
          functionName: 'pendingRandomnessAt',
        }),
      ]);
      if (source === '0x0000000000000000000000000000000000000000') return undefined;
      return { source, activatesAt: new Date(Number(at) * 1000) };
    },
    async requestsAffordable() {
      const source = await client.readContract({
        address: raffle,
        abi: stubbyRaffleAbi,
        functionName: 'randomness',
      });
      try {
        return await client.readContract({
          address: source,
          abi: d20RandomnessAdapterAbi,
          functionName: 'requestsAffordable',
        });
      } catch {
        return undefined;
      }
    },
  };
}
