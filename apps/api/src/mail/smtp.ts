/**
 * A small SMTP client, for handing a message to a relay on this machine.
 *
 * Deliberately not a general SMTP library. It speaks the one conversation this
 * project needs — greet, envelope, data, quit — to a submission agent on
 * loopback that requires no authentication and offers no TLS, because there is
 * no network between us and it. It does not do AUTH, STARTTLS, pipelining,
 * connection reuse or delivery to a remote MX. Postfix does all of that; the
 * point of a local relay is that the hard parts of sending mail are its job.
 *
 * That narrowness is what makes writing it reasonable rather than reckless.
 * Widen the target — a hosted provider, credentials, a public port — and this
 * file stops being the right answer: write a different `Mailer` against that
 * provider's API instead, which is what the interface exists for. See ADR 0010.
 *
 * The parts that are not optional, because getting them wrong is a security
 * bug rather than a bounce:
 *
 *   - **No bare CR or LF in a header value.** A newline smuggled into a header
 *     ends it and begins another, which turns a recipient address into a `Bcc:`
 *     of the attacker's choosing. Checked here even though `isUsableEmail`
 *     already rejects control characters, because this function is reachable
 *     from anywhere and the check costs nothing.
 *   - **Dot-stuffing.** A line consisting of a single `.` ends the DATA phase.
 *     A body line that starts with `.` must be doubled or the message is
 *     truncated there and the rest is read as commands.
 *   - **CRLF, always.** Bare LF is accepted by some servers and mangles the
 *     message on others.
 */

import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

/** One reply from the server, with its multi-line continuations joined. */
interface Reply {
  code: number;
  text: string;
}

export interface SmtpMessage {
  /** `From:` as it appears in the header — may carry a display name. */
  from: string;
  /** Exactly one recipient. Bare address, no display name. */
  to: string;
  subject: string;
  text: string;
  /** Sent alongside `text` as `multipart/alternative` when present. */
  html?: string;
  /**
   * A one-click unsubscribe link (RFC 8058), sent as `List-Unsubscribe` so a
   * mail client can offer its own button. Only on mail a person can turn off.
   */
  unsubscribeUrl?: string;
  /**
   * The envelope sender, which is where bounces go.
   *
   * Separate from `from` on purpose: the header is what a person reads, the
   * envelope is what the mail system acts on. Defaults to the address inside
   * `from`.
   */
  returnPath?: string;
}

export interface SmtpOptions {
  host: string;
  port: number;
  /** The name given in EHLO. Should be a hostname this machine answers to. */
  clientName: string;
  /**
   * How long to wait on the socket.
   *
   * A relay that accepts the connection and then says nothing would otherwise
   * hold the request open until the client gives up, and the caller reports
   * "could not send" either way — so it may as well be quick about it.
   */
  timeoutMs?: number;
}

export class SmtpError extends Error {
  override readonly name = 'SmtpError';
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

const CRLF = '\r\n';

/** Reject anything that could end a header line early. */
function assertHeaderSafe(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new SmtpError(`${field} contains a line break, which would inject a header`);
  }
}

/**
 * Only the address, without any display name.
 *
 * The envelope wants `<user@host>` and nothing else; `Stubby <a@b>` in a
 * `MAIL FROM` is a syntax error on a strict server.
 */
export function bareAddress(value: string): string {
  const angled = /<([^>]*)>/.exec(value);
  return (angled?.[1] ?? value).trim();
}

/**
 * Split the socket's bytes into replies.
 *
 * A reply is one or more lines; the last has a space after the code and the
 * continuations have a hyphen (`250-PIPELINING` … `250 HELP`). Reading only
 * the first line works right up until the server advertises extensions, and
 * then it desynchronises every later exchange by one reply.
 */
function createReplyReader(socket: Socket) {
  let buffer = '';
  let lines: string[] = [];
  const ready: Reply[] = [];
  let waiting: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | null = null;
  let failure: Error | null = null;

  const fail = (error: Error) => {
    failure ??= error;
    const pending = waiting;
    waiting = null;
    pending?.reject(error);
  };

  const deliver = (reply: Reply) => {
    const pending = waiting;
    waiting = null;
    if (pending) pending.resolve(reply);
    else ready.push(reply);
  };

  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let break_: number;
    while ((break_ = buffer.indexOf(CRLF)) !== -1) {
      const line = buffer.slice(0, break_);
      buffer = buffer.slice(break_ + 2);
      lines.push(line);
      // `250 text` ends the reply; `250-text` continues it.
      if (/^\d{3} /.test(line)) {
        const code = Number(line.slice(0, 3));
        deliver({ code, text: lines.join(' ') });
        lines = [];
      }
    }
  });
  socket.on('error', (error: Error) => fail(new SmtpError(`smtp socket: ${error.message}`)));
  socket.on('timeout', () => {
    socket.destroy();
    fail(new SmtpError('smtp relay did not answer in time'));
  });
  socket.on('close', () => fail(new SmtpError('smtp relay closed the connection')));

  return {
    next(): Promise<Reply> {
      const queued = ready.shift();
      if (queued) return Promise.resolve(queued);
      if (failure) return Promise.reject(failure);
      return new Promise<Reply>((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
  };
}

/**
 * Render the message.
 *
 * Bodies are base64 so that the transfer is clean whatever the content: no
 * 8-bit bytes on a connection that may not have announced `8BITMIME`, no line
 * longer than the 998 the RFC allows, and nothing that can begin with a dot.
 */
export function renderMessage(message: SmtpMessage, now = new Date()): string {
  assertHeaderSafe(message.from, 'From');
  assertHeaderSafe(message.to, 'To');
  assertHeaderSafe(message.subject, 'Subject');
  if (message.unsubscribeUrl !== undefined) {
    assertHeaderSafe(message.unsubscribeUrl, 'List-Unsubscribe');
  }

  const domain = bareAddress(message.from).split('@')[1] ?? 'localhost';
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    // Login links are not conversation and should not be bundled into one by a
    // client, nor answered by an out-of-office.
    'Auto-Submitted: auto-generated',
    ...(message.unsubscribeUrl === undefined
      ? []
      : [
          `List-Unsubscribe: <${message.unsubscribeUrl}>`,
          'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
        ]),
    'MIME-Version: 1.0',
  ];

  // Line endings inside the part are normalised to CRLF before encoding: a
  // text/plain body is a network text format whatever it was written as, and
  // base64 preserves exactly the bytes it is given.
  const encode = (body: string) => {
    const normalised = body.replace(/\r\n|\r|\n/g, CRLF);
    return (
      Buffer.from(normalised, 'utf8')
        .toString('base64')
        .match(/.{1,76}/g) ?? []
    ).join(CRLF);
  };

  if (message.html === undefined) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      encode(message.text),
    ].join(CRLF);
  }

  // Random, so it cannot collide with content that happens to look like it.
  const boundary = `=_stubby_${randomUUID()}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    // Plain text first: `multipart/alternative` is worst-to-best, and a client
    // that shows the first part it understands should show the nicer one.
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encode(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encode(message.html),
    `--${boundary}--`,
  ].join(CRLF);
}

/** Double a leading dot on any line, so no line can end the DATA phase. */
export function dotStuff(body: string): string {
  return body
    .split(CRLF)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join(CRLF);
}

/** Hand one message to the relay. Resolves once the relay has accepted it. */
export async function sendMail(message: SmtpMessage, options: SmtpOptions): Promise<void> {
  const { host, port, clientName, timeoutMs = 10_000 } = options;
  const envelopeFrom = bareAddress(message.returnPath ?? message.from);
  const envelopeTo = bareAddress(message.to);
  assertHeaderSafe(envelopeFrom, 'return path');
  assertHeaderSafe(envelopeTo, 'recipient');

  const body = renderMessage(message);
  const socket = createConnection({ host, port });
  socket.setTimeout(timeoutMs);
  const reader = createReplyReader(socket);

  const say = (line: string) => {
    socket.write(line + CRLF);
    return reader.next();
  };
  const expect = async (reply: Reply, allowed: number[], step: string) => {
    if (!allowed.includes(reply.code)) {
      throw new SmtpError(`${step} refused: ${reply.text}`, reply.code);
    }
    return reply;
  };

  try {
    await expect(await reader.next(), [220], 'greeting');

    // HELO is the fallback for a relay old enough not to know EHLO. Nothing
    // here needs an extension, so the reply is only checked, never parsed.
    const hello = await say(`EHLO ${clientName}`);
    if (hello.code >= 400) await expect(await say(`HELO ${clientName}`), [250], 'HELO');

    await expect(await say(`MAIL FROM:<${envelopeFrom}>`), [250], 'MAIL FROM');
    // 251 is "not local, will forward", which is a success.
    await expect(await say(`RCPT TO:<${envelopeTo}>`), [250, 251], 'RCPT TO');
    await expect(await say('DATA'), [354], 'DATA');

    socket.write(dotStuff(body) + CRLF + '.' + CRLF);
    await expect(await reader.next(), [250], 'message');

    // The relay has taken responsibility by now, so a QUIT that never lands is
    // not a failed send and must not be reported as one.
    try {
      await say('QUIT');
    } catch {
      /* already accepted */
    }
  } finally {
    socket.destroy();
  }
}
