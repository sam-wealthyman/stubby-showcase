/**
 * Sending the email.
 *
 * An interface, because Section 10 rules out an auth provider but says nothing
 * about a mail provider, and that choice has not been made. What matters is that
 * the login flow does not depend on which one it turns out to be.
 *
 * The console mailer below is not a stub for tests — it is how email login is
 * used in development, where printing the link to the API's own output is
 * strictly better than configuring a provider to deliver mail to yourself.
 */

import { maskEmail } from '@stubby/shared';

import { bareAddress, sendMail } from '../mail/smtp.js';

export interface SmtpMailerOptions {
  /** `From:` as it appears to the reader, e.g. `Stubby <noreply@example.com>`. */
  from: string;
  host: string;
  port?: number;
  /** The name given in EHLO. A hostname this machine answers to. */
  clientName: string;
  /** Used in the subject and the body. */
  appName?: string;
  timeoutMs?: number;
}

/** The four characters that could otherwise close a tag or an attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface LoginEmail {
  to: string;
  /** The full URL, token included. */
  link: string;
  expiresAt: Date;
}

export interface Mailer {
  /** Resolves once handed off. Throwing means the caller should report failure. */
  sendLoginLink(message: LoginEmail): Promise<void>;
  /** Named in logs and in `check:env`, so it is obvious which one is live. */
  readonly name: string;
}

/**
 * Prints the link instead of sending it.
 *
 * Deliberately logs the **whole link**, token and all. That is a secret in a
 * terminal, which is exactly what must never happen in production — hence the
 * warning on every send, and `createApi` refuses this mailer when
 * `NODE_ENV=production`.
 */
export function createConsoleMailer(): Mailer {
  return {
    name: 'console (development only)',
    async sendLoginLink({ to, link, expiresAt }) {
      const minutes = Math.round((expiresAt.getTime() - Date.now()) / 60_000);
      console.warn(
        `\n── login link for ${maskEmail(to)} ─────────────────────────────\n` +
          `   ${link}\n` +
          `   valid for ${minutes} minutes, once\n` +
          `   THIS IS A SECRET IN A TERMINAL. Development only.\n` +
          `────────────────────────────────────────────────────────\n`,
      );
    },
  };
}

/**
 * A mailer that always fails.
 *
 * The default when nothing is configured, so a deployment without a provider
 * reports "could not send" rather than silently accepting every sign-in request
 * and delivering nothing — which looks identical to a working system from the
 * outside and is the worse failure.
 */
export function createUnconfiguredMailer(): Mailer {
  return {
    name: 'none configured',
    async sendLoginLink() {
      throw new Error('no mail provider is configured, so no login link can be sent');
    },
  };
}

/**
 * Sends through an SMTP relay.
 *
 * In production that relay is Postfix on this machine's loopback, which already
 * holds the DKIM key and does the actual delivery. See `docs/deploying.md`.
 *
 * The message is deliberately plain. A login link is a security-relevant thing
 * to read: the fewer images, tracking pixels and unrecognised senders around
 * it, the better it can be told apart from the phishing mail that imitates it.
 * So there is one link, it is shown as its own text, and the mail says what to
 * do if it was not asked for.
 */
export function createSmtpMailer(options: SmtpMailerOptions): Mailer {
  const { from, host, port = 25, clientName, appName = 'Stubby', timeoutMs } = options;

  return {
    name: `smtp ${host}:${port} as ${bareAddress(from)}`,
    async sendLoginLink({ to, link, expiresAt }) {
      const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000));

      const text = [
        `Sign in to ${appName}`,
        '',
        'Open this link to sign in:',
        link,
        '',
        `It works once, and for ${minutes} minutes.`,
        '',
        `If you did not ask to sign in to ${appName}, ignore this — nothing has`,
        'happened to any account, and no one can use this link but you.',
      ].join('\n');

      const html = [
        '<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">',
        `<p>Open this link to sign in to ${escapeHtml(appName)}:</p>`,
        `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
        `<p>It works once, and for ${minutes} minutes.</p>`,
        `<p style="color:#666">If you did not ask to sign in to ${escapeHtml(appName)}, ignore`,
        ' this — nothing has happened to any account, and no one can use this link but you.</p>',
        '</body></html>',
      ].join('');

      await sendMail(
        { from, to, subject: `Sign in to ${appName}`, text, html },
        { host, port, clientName, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
      );
    },
  };
}
