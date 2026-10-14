/**
 * The window keeper: restarts the clock on open draws whose window has passed.
 *
 * The window is a target, not a deadline. `enter` checks only that a draw is
 * Open, so a draw past its window still sells, and the app says "Until
 * filled". `extendWindow` restarts the seven days and is permissionless on
 * purpose (StubbyRaffle, Section 11.5), so the countdown need not wait on the
 * owner remembering to send it by hand, which is what happened through
 * October 2026.
 *
 * **Its key is a hot key, so it is a different key.** A fresh wallet that owns
 * nothing and holds a little USDC for gas: losing it costs that gas and
 * nothing else. The watcher refuses to run the keeper with the owner's key
 * (`assertNotOwner`), because an owner key on a server is the one thing this
 * project has rules against (CLAUDE.md, docs/key-management.md).
 *
 * The key is read from its own file (`WINDOW_KEEPER_KEY_FILE`), never from the
 * settings file the API also loads, and it is never logged: only its address.
 */

import { readFileSync } from 'node:fs';

import {
  formatUsdc,
  nativeToUsdc,
  stubbyRaffleAbi,
  toViemChain,
  usdcToNative,
  type ArcNetwork,
  type RaffleState,
} from '@stubby/shared';
import { createWalletClient, http, type Address, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Below this, the keeper stops sending and says so. Gas is paid in Arc's
 * native view of USDC (18 decimals; see `units.ts`), and one `extendWindow`
 * costs a small fraction of a cent, so this is well over a hundred calls.
 */
export const LOW_GAS = usdcToNative(50_000n); // 0.05 USDC

/** Open draws whose window has passed, oldest window first. */
export function expiredOpen(raffles: readonly RaffleState[], now: Date = new Date()): bigint[] {
  return raffles
    .filter((r) => r.status === 'Open' && r.windowEnds.getTime() <= now.getTime())
    .sort((a, b) => a.windowEnds.getTime() - b.windowEnds.getTime())
    .map((r) => r.id);
}

/**
 * Read the key from its file. Null, with the reason logged, when the file is
 * missing or holds anything but one private key, so a bad file switches the
 * keeper off rather than taking the watcher down with it.
 */
export function loadKeeperKey(path: string): `0x${string}` | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    console.error(`window keeper: cannot read WINDOW_KEEPER_KEY_FILE (${path}); keeper off`);
    return null;
  }
  const key = text.startsWith('0x') ? text : `0x${text}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    // Says what is wrong with the file, never what is in it.
    console.error(
      'window keeper: WINDOW_KEEPER_KEY_FILE does not hold one private key; keeper off',
    );
    return null;
  }
  return key as `0x${string}`;
}

export interface KeeperReport {
  extended: bigint[];
  /** Skipped because someone else extended it first, or it filled meanwhile. */
  skipped: bigint[];
  errors: string[];
  lowGas: boolean;
}

export interface Keeper {
  address: Address;
  run(raffles: readonly RaffleState[], now?: Date): Promise<KeeperReport>;
}

export function viemKeeper(options: {
  key: `0x${string}`;
  network: ArcNetwork;
  rpcUrl?: string;
  contract: Address;
  reader: PublicClient;
}): Keeper {
  const account = privateKeyToAccount(options.key);
  const wallet = createWalletClient({
    account,
    chain: toViemChain(options.network),
    transport: http(options.rpcUrl ?? options.network.rpcUrl),
  });
  const { reader, contract } = options;

  return {
    address: account.address,
    async run(raffles, now = new Date()) {
      const report: KeeperReport = { extended: [], skipped: [], errors: [], lowGas: false };
      const due = expiredOpen(raffles, now);
      if (due.length === 0) return report;

      const balance = await reader.getBalance({ address: account.address });
      if (balance < LOW_GAS) {
        report.lowGas = true;
        return report;
      }

      for (const id of due) {
        try {
          // Simulated first: a draw someone else extended, or that filled
          // since it was read, reverts here for free instead of on chain.
          const { request } = await reader.simulateContract({
            account,
            address: contract,
            abi: stubbyRaffleAbi,
            functionName: 'extendWindow',
            args: [id],
          });
          const hash = await wallet.writeContract(request);
          const receipt = await reader.waitForTransactionReceipt({ hash });
          if (receipt.status === 'success') report.extended.push(id);
          else report.errors.push(`draw ${id}: extendWindow reverted in ${hash}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/WindowStillOpen|NotOpen/.test(message)) report.skipped.push(id);
          else report.errors.push(`draw ${id}: ${message.split('\n')[0]}`);
        }
      }
      return report;
    },
  };
}

/**
 * Refuse the owner's key. The keeper needs no authority, and an owner key on a
 * server would put every owner power one compromised process away.
 */
export async function assertNotOwner(
  reader: PublicClient,
  contract: Address,
  keeper: Address,
): Promise<void> {
  const owner = await reader.readContract({
    address: contract,
    abi: stubbyRaffleAbi,
    functionName: 'owner',
  });
  if (owner.toLowerCase() === keeper.toLowerCase()) {
    throw new Error('WINDOW_KEEPER_KEY_FILE holds the contract owner key; use a fresh wallet');
  }
}

/** For the log line: a native gas balance, shown in the 6-decimal USDC view. */
export function gasUsdc(balance: bigint): string {
  return formatUsdc(nativeToUsdc(balance), { decimals: 4 });
}
