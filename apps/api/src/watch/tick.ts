/**
 * One pass of the watcher: mirror the chain, tell entrants their results,
 * tell the owner what needs a look. In that order, because a result can only
 * be sent to an entrant the mirror has already recorded.
 *
 * Each part catches its own failure. A mail relay that is down must not stop
 * the mirror, and an RPC that is flaky (brief, 14: it is) must not stop mail
 * for what was already read.
 */

import type pg from 'pg';

import { formatUsdc } from '@stubby/shared';

import { isDue, ownerAlerts } from './alerts.js';
import type { ChainReader } from './chain.js';
import {
  alertNotice,
  referralNotice,
  resultNotice,
  type Notifier,
  withUnsubscribe,
} from './notices.js';
import { mailOptedOut, mailTokenFor, unsubscribeUrl } from '../mail/prefs.js';
import type { PushSender } from '../push/fcm.js';
import { pendingPushResults, pushToAccount } from '../push/store.js';
import { awardBonuses } from '../referral/store.js';
import {
  claimNotice,
  getCursor,
  markAlertsSent,
  pendingResults,
  recordEntries,
  recordEvents,
  releaseNotice,
  setCursor,
  syncAlerts,
  upsertRaffles,
  type Scope,
} from './store.js';

export interface WatchOptions {
  pool: pg.Pool;
  chain: ChainReader;
  scope: Scope;
  notifier: Notifier;
  appOrigin: string;
  /** Where owner alerts go. Unset, they are logged and not mailed. */
  ownerEmail?: string;
  /** Push to phones (FCM). Unset, nothing is pushed. */
  pusher?: PushSender;
  /** Where the entry log starts on the very first run. Default: the head. */
  startBlock?: bigint;
  /** Blocks per log query; the public Arc RPC caps ranges (brief, 14). */
  chunk?: bigint;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface TickReport {
  raffles: number;
  entries: number;
  results: number;
  alerts: number;
  errors: string[];
}

export async function tick(options: WatchOptions): Promise<TickReport> {
  const { pool, chain, scope, notifier, appOrigin } = options;
  const now = options.now?.() ?? new Date();
  const log = options.log ?? ((m: string) => console.warn(m));
  const report: TickReport = { raffles: 0, entries: 0, results: 0, alerts: 0, errors: [] };
  const fail = (part: string, error: unknown) => {
    const message = `${part}: ${error instanceof Error ? error.message : String(error)}`;
    report.errors.push(message);
    log(`watcher ${message}`);
  };

  let raffles: Awaited<ReturnType<ChainReader['raffles']>> = [];
  try {
    raffles = await chain.raffles();
    await upsertRaffles(pool, scope, raffles);
    report.raffles = raffles.length;
  } catch (error) {
    fail('raffles', error);
  }

  try {
    const cursorName = `${scope.chainId}:${scope.contract}:entered`;
    const head = await chain.head();
    let from = (await getCursor(pool, cursorName)) ?? options.startBlock ?? head;
    const chunk = options.chunk ?? 2000n;
    while (from <= head) {
      const to = from + chunk - 1n < head ? from + chunk - 1n : head;
      const { entries, events } = await chain.logs(from, to);
      await recordEntries(pool, scope, entries);
      await recordEvents(pool, scope, events);
      report.entries += entries.length;
      from = to + 1n;
      // Saved per chunk, so a failure part-way keeps what was read.
      await setCursor(pool, cursorName, from);
    }
  } catch (error) {
    fail('entries', error);
  }

  // Referral bonuses, now that this pass's purchases are recorded. Each is
  // awarded once (keyed by the referred account); the email is a courtesy.
  try {
    for (const award of await awardBonuses(pool, scope)) {
      const { rows } = await pool.query<{ email: string }>(
        'SELECT email FROM account_email WHERE account_id = $1 LIMIT 1',
        [award.referrerAccountId],
      );
      if (options.pusher) {
        await pushToAccount(pool, options.pusher, award.referrerAccountId, {
          title: `You earned ${formatUsdc(award.bonus, { decimals: 2 })} USDC`,
          body: 'A friend you invited bought their first ticket.',
          href: '/account',
        }).catch((error) => fail('referral push', error));
      }
      if (rows[0] && !(await mailOptedOut(pool, award.referrerAccountId))) {
        const url = unsubscribeUrl(appOrigin, await mailTokenFor(pool, award.referrerAccountId));
        await notifier
          .send(withUnsubscribe(referralNotice(rows[0].email, award.bonus, appOrigin), url))
          .catch((error) => fail('referral email', error));
      }
    }
  } catch (error) {
    fail('referrals', error);
  }

  try {
    for (const pending of await pendingResults(pool, scope)) {
      if (!(await claimNotice(pool, scope, 'result', pending.raffleId, pending.accountId)))
        continue;
      // Claimed but not sent: turning mail back on later must not deliver a
      // backlog of old results.
      if (await mailOptedOut(pool, pending.accountId)) continue;
      try {
        const url = unsubscribeUrl(appOrigin, await mailTokenFor(pool, pending.accountId));
        await notifier.send(
          withUnsubscribe(
            resultNotice({
              to: pending.email,
              raffleId: pending.raffleId,
              won: pending.won,
              prize: pending.prize,
              appOrigin,
            }),
            url,
          ),
        );
        report.results += 1;
      } catch (error) {
        await releaseNotice(pool, scope, 'result', pending.raffleId, pending.accountId);
        fail(`result for draw #${pending.raffleId}`, error);
      }
    }
  } catch (error) {
    fail('results', error);
  }

  // The same results, to phones. Claimed first, as for mail, so a crash
  // between claim and send costs one push rather than sending two.
  if (options.pusher) {
    try {
      for (const pending of await pendingPushResults(pool, scope)) {
        if (!(await claimNotice(pool, scope, 'push-result', pending.raffleId, pending.accountId)))
          continue;
        const prize = formatUsdc(pending.prize);
        await pushToAccount(
          pool,
          options.pusher,
          pending.accountId,
          pending.won
            ? {
                title: `You won ${prize} USDC!`,
                body: `Draw #${pending.raffleId}. Tap to claim it; it stays yours.`,
                href: `/won/${pending.raffleId}`,
              }
            : {
                title: `Draw #${pending.raffleId} has been drawn`,
                body: `Not this time. Someone won ${prize} USDC.`,
                href: `/raffle/${pending.raffleId}`,
              },
        ).catch(async (error) => {
          await releaseNotice(pool, scope, 'push-result', pending.raffleId, pending.accountId);
          fail(`push for draw #${pending.raffleId}`, error);
        });
      }
    } catch (error) {
      fail('push results', error);
    }
  }

  try {
    const [randomnessTimeoutMs, solvent, requestsAffordable, pendingRandomness] = await Promise.all(
      [
        chain.randomnessTimeoutMs(),
        chain.solvent(),
        chain.requestsAffordable(),
        chain.pendingRandomness().catch(() => undefined),
      ],
    );
    const alerts = ownerAlerts({
      raffles,
      now,
      randomnessTimeoutMs,
      solvent,
      ...(requestsAffordable === undefined ? {} : { requestsAffordable }),
      ...(pendingRandomness === undefined ? {} : { pendingRandomness }),
    });
    const states = await syncAlerts(
      pool,
      alerts.map((a) => a.key),
    );
    const due = alerts.filter((a) => {
      const state = states.get(a.key);
      return state !== undefined && isDue(a, state, now);
    });
    if (due.length > 0) {
      if (options.ownerEmail) {
        await notifier.send(alertNotice(options.ownerEmail, due, appOrigin));
      } else {
        log(`watcher alerts (OWNER_ALERT_EMAIL unset): ${due.map((a) => a.title).join('; ')}`);
      }
      await markAlertsSent(
        pool,
        due.map((a) => a.key),
        now,
      );
      report.alerts = due.length;
    }
  } catch (error) {
    fail('alerts', error);
  }

  return report;
}
