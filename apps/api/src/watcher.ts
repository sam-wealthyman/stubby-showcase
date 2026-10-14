/**
 * The watcher's entry point: a second process beside the API, from the same
 * bundle and the same settings file (`stubby-watcher.service`).
 *
 * A separate process rather than a timer inside the API, so a slow RPC or a
 * stuck mail relay never shares an event loop with sign-in, and so either can
 * be restarted without the other.
 *
 * Settings, beyond the API's own:
 *   RAFFLE_CONTRACT_ADDRESS  the StubbyRaffle to watch (required)
 *   OWNER_ALERT_EMAIL        where owner alerts go; unset, they are logged
 *   WATCH_START_BLOCK        first block of the entry log on the very first
 *                            run; default the current head
 *   WATCH_INTERVAL_MS        time between passes; default 30000
 *   WINDOW_KEEPER_KEY_FILE   a file holding the window keeper's private key;
 *                            unset, it is off (watch/keeper.ts). Never the
 *                            owner's key: the watcher refuses that one.
 *   WINDOW_KEEPER_INTERVAL_MS
 *                            time between its passes; default 600000
 */

import { arcNetworkByChainId, createArcClient, readAllRaffles } from '@stubby/shared';
import { isAddress, type Address } from 'viem';

import { createPool } from './db/pool.js';
import { viemChainReader } from './watch/chain.js';
import { consoleNotifier, smtpNotifier, type Notifier } from './watch/notices.js';
import { fcmSender } from './push/fcm.js';
import { assertNotOwner, gasUsdc, loadKeeperKey, viemKeeper, type Keeper } from './watch/keeper.js';
import { tick } from './watch/tick.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return value;
}

const chainId = Number(required('ARC_CHAIN_ID'));
const network = arcNetworkByChainId(chainId);
if (network === undefined) {
  console.error(`ARC_CHAIN_ID is ${chainId}, which is not an Arc network`);
  process.exit(1);
}

const contract = required('RAFFLE_CONTRACT_ADDRESS');
if (!isAddress(contract)) {
  console.error('RAFFLE_CONTRACT_ADDRESS is not an address');
  process.exit(1);
}
// Narrowed once here; the keeper's functions below cannot see the check above.
const raffleAddress = contract as Address;

const appOrigin = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:8081').split(',')[0]!.trim();

/**
 * The same pair as the API's login mail. Production without it exits rather
 * than running quietly: a watcher that believes it tells winners and does not
 * is the failure this is meant to prevent.
 */
function chooseNotifier(): Notifier {
  const host = process.env.SMTP_HOST ?? '';
  const from = process.env.MAIL_FROM ?? '';
  if (host && from) {
    return smtpNotifier({
      from,
      host,
      port: Number(process.env.SMTP_PORT ?? 25),
      clientName: process.env.SIWE_DOMAIN ?? 'localhost',
    });
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('SMTP_HOST and MAIL_FROM are required in production; nothing could be sent');
    process.exit(1);
  }
  return consoleNotifier();
}

const pool = createPool({ max: 2 });
const client = createArcClient({
  network,
  ...(process.env.ARC_RPC_URL ? { rpcUrl: process.env.ARC_RPC_URL } : {}),
});
const chain = viemChainReader(client, contract);
const notifier = chooseNotifier();
const intervalMs = Number(process.env.WATCH_INTERVAL_MS ?? 30_000);
const startBlock = process.env.WATCH_START_BLOCK
  ? BigInt(process.env.WATCH_START_BLOCK)
  : undefined;
const ownerEmail = process.env.OWNER_ALERT_EMAIL || undefined;
// Push is optional: without Firebase's service account the watcher mails only.
const pusher = process.env.FCM_SERVICE_ACCOUNT_FILE
  ? fcmSender(process.env.FCM_SERVICE_ACCOUNT_FILE)
  : undefined;

console.log(
  `watching ${contract} on ${network.name} every ${intervalMs / 1000}s; mail via ${notifier.name}; ` +
    `owner alerts ${ownerEmail ? 'mailed' : 'logged only (OWNER_ALERT_EMAIL unset)'}; ` +
    `push ${pusher ? pusher.name : 'off (FCM_SERVICE_ACCOUNT_FILE unset)'}`,
);

let stopping = false;
let timer: NodeJS.Timeout | undefined;
let keeperTimer: NodeJS.Timeout | undefined;

async function loop() {
  const report = await tick({
    pool,
    chain,
    scope: { chainId, contract: contract.toLowerCase() },
    notifier,
    appOrigin,
    ...(ownerEmail ? { ownerEmail } : {}),
    ...(pusher ? { pusher } : {}),
    ...(startBlock === undefined ? {} : { startBlock }),
  });
  if (report.entries || report.results || report.alerts) {
    console.log(
      `watcher: ${report.raffles} raffles, ${report.entries} new entries, ` +
        `${report.results} results sent, ${report.alerts} alerts`,
    );
  }
  if (!stopping) timer = setTimeout(() => void loop(), intervalMs);
}

/**
 * The keeper, on its own slower timer: windows are days long, so ten minutes
 * late is nothing, and it keeps a slow transaction out of the mirror's pass.
 * Any failure to start it switches the keeper off and leaves the watcher be.
 */
async function startKeeper(): Promise<void> {
  const path = process.env.WINDOW_KEEPER_KEY_FILE;
  if (!path) {
    console.log('window keeper off (WINDOW_KEEPER_KEY_FILE unset)');
    return;
  }
  const key = loadKeeperKey(path);
  if (!key) return;
  const keeper = viemKeeper({
    key,
    network: network!,
    ...(process.env.ARC_RPC_URL ? { rpcUrl: process.env.ARC_RPC_URL } : {}),
    contract: raffleAddress,
    reader: client,
  });
  try {
    await assertNotOwner(client, raffleAddress, keeper.address);
  } catch (error) {
    console.error(`window keeper off: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const balance = await client.getBalance({ address: keeper.address }).catch(() => undefined);
  console.log(
    `window keeper ${keeper.address} on; gas ${balance === undefined ? 'unknown' : `${gasUsdc(balance)} USDC`}`,
  );
  const every = Number(process.env.WINDOW_KEEPER_INTERVAL_MS ?? 600_000);
  void keeperLoop(keeper, every, false);
}

async function keeperLoop(keeper: Keeper, every: number, wasLow: boolean): Promise<void> {
  let low = wasLow;
  try {
    const report = await keeper.run(await readAllRaffles(client, raffleAddress));
    if (report.extended.length > 0) {
      console.log(`window keeper: extended draw ${report.extended.join(', ')}`);
    }
    for (const error of report.errors) console.error(`window keeper: ${error}`);
    // Told once when gas runs low, not every pass, and again only after a top-up.
    if (report.lowGas && !low) {
      const text =
        `The window keeper ${keeper.address} is low on gas and has stopped extending ` +
        `draw windows. Send it about 1 USDC on Arc to start it again.`;
      console.error(`window keeper: ${text}`);
      if (ownerEmail) {
        await notifier
          .send({ to: ownerEmail, subject: 'Stubby window keeper is low on gas', text })
          .catch(() => undefined);
      }
    }
    if (report.extended.length > 0 || report.skipped.length > 0) low = false;
    else if (report.lowGas) low = true;
  } catch (error) {
    console.error(`window keeper: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stopping) keeperTimer = setTimeout(() => void keeperLoop(keeper, every, low), every);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    if (keeperTimer) clearTimeout(keeperTimer);
    void pool.end().then(() => process.exit(0));
  });
}

void loop();
void startKeeper();
