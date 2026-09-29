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
 */

import { arcNetworkByChainId, createArcClient } from '@stubby/shared';
import { isAddress } from 'viem';

import { createPool } from './db/pool.js';
import { viemChainReader } from './watch/chain.js';
import { consoleNotifier, smtpNotifier, type Notifier } from './watch/notices.js';
import { fcmSender } from './push/fcm.js';
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
const chain = viemChainReader(
  createArcClient({
    network,
    ...(process.env.ARC_RPC_URL ? { rpcUrl: process.env.ARC_RPC_URL } : {}),
  }),
  contract,
);
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

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    void pool.end().then(() => process.exit(0));
  });
}

void loop();
