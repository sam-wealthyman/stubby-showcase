/**
 * The mail the watcher sends, and how it is sent.
 *
 * Plain text only. These are about money: the fewer images and tracking links
 * around them, the easier they are to tell apart from the phishing that
 * imitates them. Each says what happened and links to the one screen that
 * shows it, where the chain is read afresh; the mail itself is never the proof.
 */

import { formatUsdc } from '@stubby/shared';

import { sendMail } from '../mail/smtp.js';
import type { OwnerAlert } from './alerts.js';

export interface Notice {
  to: string;
  subject: string;
  text: string;
  /** Present on mail the recipient can turn off; added to text and headers. */
  unsubscribeUrl?: string;
}

/** The footer every mail a person can turn off carries. */
export function withUnsubscribe(notice: Notice, url: string): Notice {
  return {
    ...notice,
    unsubscribeUrl: url,
    text: `${notice.text}\n\n--\nStop these emails: ${url}\n`,
  };
}

export interface Notifier {
  readonly name: string;
  /** Resolves once handed off; throwing means it was not sent. */
  send(notice: Notice): Promise<void>;
}

export function smtpNotifier(options: {
  from: string;
  host: string;
  port: number;
  clientName: string;
}): Notifier {
  return {
    name: `smtp ${options.host}:${options.port}`,
    send: ({ to, subject, text, unsubscribeUrl }) =>
      sendMail(
        {
          from: options.from,
          to,
          subject,
          text,
          ...(unsubscribeUrl === undefined ? {} : { unsubscribeUrl }),
        },
        { host: options.host, port: options.port, clientName: options.clientName },
      ),
  };
}

/** Development: print instead of sending. Refused in production by the entry point. */
export function consoleNotifier(): Notifier {
  return {
    name: 'console (development only)',
    async send({ to, subject, text }) {
      console.warn(`\n── mail to ${to}: ${subject}\n${text}\n──`);
    },
  };
}

export interface ResultInput {
  to: string;
  raffleId: bigint;
  won: boolean;
  prize: bigint;
  appOrigin: string;
}

/** A draw you entered has settled. */
export function resultNotice({ to, raffleId, won, prize, appOrigin }: ResultInput): Notice {
  const origin = appOrigin.replace(/\/$/, '');
  if (won) {
    return {
      to,
      subject: `You won ${formatUsdc(prize)} USDC in Stubby draw #${raffleId}`,
      text: [
        `Your stub won draw #${raffleId}: ${formatUsdc(prize)} USDC.`,
        '',
        'Claim it from the wallet that bought the ticket:',
        `${origin}/won/${raffleId}`,
        '',
        'There is no deadline. The prize stays yours in the contract until you claim it.',
        '',
        'Stubby will never ask for your recovery phrase or a private key.',
      ].join('\n'),
    };
  }
  return {
    to,
    subject: `Stubby draw #${raffleId} has been drawn`,
    text: [
      `Draw #${raffleId} has settled, and your stubs did not win this time.`,
      '',
      'The draw and its proof are here:',
      `${origin}/raffle/${raffleId}`,
    ].join('\n'),
  };
}

/** Everything the owner should look at, in one mail. */
export function alertNotice(to: string, alerts: readonly OwnerAlert[], appOrigin: string): Notice {
  const origin = appOrigin.replace(/\/$/, '');
  return {
    to,
    subject:
      alerts.length === 1
        ? `Stubby: ${alerts[0]!.title}`
        : `Stubby: ${alerts.length} things need a look`,
    text: [
      ...alerts.flatMap((a) => [`- ${a.title}`, `  ${a.detail}`, '']),
      `Control room: ${origin}/admin`,
    ].join('\n'),
  };
}

/** Someone you referred bought their first stubs. */
export function referralNotice(to: string, bonus: bigint, appOrigin: string): Notice {
  const origin = appOrigin.replace(/\/$/, '');
  return {
    to,
    subject: `You earned ${formatUsdc(bonus, { decimals: 2 })} USDC from a referral`,
    text: [
      `Someone you invited bought their first stubs. You earned ${formatUsdc(bonus, { decimals: 2 })} USDC.`,
      '',
      'Bonuses are paid out to your linked wallet in batches. Track them here:',
      `${origin}/account`,
    ].join('\n'),
  };
}
