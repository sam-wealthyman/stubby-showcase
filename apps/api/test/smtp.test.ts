/**
 * The SMTP client, driven against a real socket.
 *
 * The fake relay below is a real TCP server speaking the real protocol, not a
 * mock of the client's own calls. That distinction is the point: the bugs this
 * file exists to catch — a desynchronised reply stream, a truncated DATA phase,
 * an injected header — all live in the bytes on the wire, and a mock of
 * `sendMail`'s dependencies would reproduce whatever I believed those bytes
 * were rather than what they are.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { bareAddress, dotStuff, renderMessage, sendMail, SmtpError } from '../src/mail/smtp.js';

interface Recorded {
  commands: string[];
  data: string;
}

interface FakeRelay {
  port: number;
  recorded: Recorded;
  close(): Promise<void>;
}

/**
 * A relay that answers.
 *
 * `replies` overrides the answer for a command prefix, so a test can make any
 * single step fail without the others changing.
 */
async function startRelay(
  replies: Record<string, string> = {},
  options: { greeting?: string; silent?: boolean } = {},
): Promise<FakeRelay> {
  const recorded: Recorded = { commands: [], data: '' };
  let server: Server;

  const handle = (socket: Socket) => {
    if (options.silent) return;
    let inData = false;
    let buffer = '';
    socket.write(options.greeting ?? '220 fake ESMTP\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write(replies['.'] ?? '250 queued\r\n');
          } else {
            recorded.data += line + '\r\n';
          }
          continue;
        }

        recorded.commands.push(line);
        const key = Object.keys(replies).find((prefix) => line.startsWith(prefix));
        if (key !== undefined && key !== '.') {
          socket.write(replies[key] as string);
          continue;
        }
        if (line.startsWith('EHLO')) {
          // Multi-line on purpose: a reader that stops at the first line
          // desynchronises every later reply by one.
          socket.write('250-fake greets you\r\n250-PIPELINING\r\n250 HELP\r\n');
        } else if (line.startsWith('HELO')) socket.write('250 fake\r\n');
        else if (line.startsWith('MAIL FROM')) socket.write('250 sender ok\r\n');
        else if (line.startsWith('RCPT TO')) socket.write('250 recipient ok\r\n');
        else if (line.startsWith('DATA')) {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (line.startsWith('QUIT')) {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('500 what\r\n');
      }
    });
    socket.on('error', () => {
      /* the client destroys the socket when it is done */
    });
  };

  return new Promise((resolve) => {
    server = createServer(handle);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        recorded,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

const relays: FakeRelay[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

async function relay(...args: Parameters<typeof startRelay>): Promise<FakeRelay> {
  const started = await startRelay(...args);
  relays.push(started);
  return started;
}

const message = {
  from: 'Stubby <noreply@stubby.example>',
  to: 'player@example.com',
  subject: 'Sign in to Stubby',
  text: 'Open this link:\nhttps://stubby.example/login?token=abc',
};

const options = (port: number) => ({ host: '127.0.0.1', port, clientName: 'stubby.example' });

describe('bareAddress', () => {
  it('takes the address out of a display name', () => {
    expect(bareAddress('Stubby <noreply@stubby.example>')).toBe('noreply@stubby.example');
  });

  it('leaves a bare address alone', () => {
    expect(bareAddress('player@example.com')).toBe('player@example.com');
  });
});

describe('dotStuff', () => {
  it('doubles a leading dot so the line cannot end the DATA phase', () => {
    expect(dotStuff('a\r\n.\r\nb')).toBe('a\r\n..\r\nb');
  });

  it('leaves a dot that is not at the start of a line', () => {
    expect(dotStuff('a.b\r\nc')).toBe('a.b\r\nc');
  });
});

describe('renderMessage', () => {
  it('refuses a line break in a header', () => {
    for (const field of ['from', 'to', 'subject'] as const) {
      expect(() => renderMessage({ ...message, [field]: 'x\r\nBcc: attacker@evil.test' })).toThrow(
        /inject a header/,
      );
    }
  });

  it('offers one-click unsubscribe only when given a link', () => {
    expect(renderMessage(message)).not.toContain('List-Unsubscribe');
    const head = renderMessage({ ...message, unsubscribeUrl: 'https://s.example/u?t=abc' }).split(
      '\r\n\r\n',
    )[0];
    expect(head).toContain('List-Unsubscribe: <https://s.example/u?t=abc>');
    expect(head).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('separates headers from the body with a blank line', () => {
    const rendered = renderMessage(message);
    expect(rendered).toContain('\r\n\r\n');
    expect(rendered.split('\r\n\r\n')[0]).toContain('Subject: Sign in to Stubby');
  });

  it('marks itself auto-generated so it is not replied to', () => {
    expect(renderMessage(message)).toContain('Auto-Submitted: auto-generated');
  });

  it('builds the message id from the sender domain', () => {
    expect(renderMessage(message)).toMatch(/Message-ID: <[^>]+@stubby\.example>/);
  });

  it('encodes the body so no line can begin with a dot or run long', () => {
    const rendered = renderMessage({ ...message, text: '.hidden\n' + 'x'.repeat(5000) });
    const body = rendered.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    for (const line of body.split('\r\n')) {
      expect(line.startsWith('.')).toBe(false);
      expect(line.length).toBeLessThanOrEqual(998);
    }
  });

  it('keeps both parts when html is given, plain text first', () => {
    const rendered = renderMessage({ ...message, html: '<p>hi</p>' });
    expect(rendered).toContain('multipart/alternative');
    expect(rendered.indexOf('text/plain')).toBeLessThan(rendered.indexOf('text/html'));
    expect(rendered.trimEnd().endsWith('--')).toBe(true);
  });
});

describe('sendMail', () => {
  it('walks the whole conversation in order', async () => {
    const fake = await relay();
    await sendMail(message, options(fake.port));

    expect(fake.recorded.commands.map((c) => c.split(':')[0]?.split(' ')[0])).toEqual([
      'EHLO',
      'MAIL',
      'RCPT',
      'DATA',
      'QUIT',
    ]);
  });

  it('puts the bare addresses in the envelope, not the display name', async () => {
    const fake = await relay();
    await sendMail(message, options(fake.port));

    expect(fake.recorded.commands).toContain('MAIL FROM:<noreply@stubby.example>');
    expect(fake.recorded.commands).toContain('RCPT TO:<player@example.com>');
  });

  it('sends a body the relay can decode back to what was written', async () => {
    const fake = await relay();
    await sendMail(message, options(fake.port));

    const parts = fake.recorded.data.split('\r\n\r\n');
    const decoded = Buffer.from(parts.slice(1).join(''), 'base64').toString('utf8');
    expect(decoded).toContain('https://stubby.example/login?token=abc');
  });

  it('survives a multi-line EHLO reply', async () => {
    // The fake answers EHLO with three lines. If the reader took only the
    // first, every later reply would be read one behind and MAIL FROM would
    // see the leftovers.
    const fake = await relay();
    await sendMail(message, options(fake.port));
    expect(fake.recorded.commands).toContain('MAIL FROM:<noreply@stubby.example>');
  });

  it('falls back to HELO when EHLO is refused', async () => {
    const fake = await relay({ EHLO: '502 not implemented\r\n' });
    await sendMail(message, options(fake.port));

    expect(fake.recorded.commands.some((c) => c.startsWith('HELO'))).toBe(true);
  });

  it('reports a refused recipient with the relay’s own words', async () => {
    const fake = await relay({ 'RCPT TO': '550 no such user here\r\n' });

    await expect(sendMail(message, options(fake.port))).rejects.toThrow(/no such user here/);
  });

  it('reports a refused sender', async () => {
    const fake = await relay({ 'MAIL FROM': '553 sender rejected\r\n' });

    await expect(sendMail(message, options(fake.port))).rejects.toThrow(/sender rejected/);
  });

  it('reports a message the relay would not queue', async () => {
    const fake = await relay({ '.': '451 try later\r\n' });

    await expect(sendMail(message, options(fake.port))).rejects.toThrow(/try later/);
  });

  it('carries the reply code on the error', async () => {
    const fake = await relay({ 'RCPT TO': '550 nope\r\n' });

    await expect(sendMail(message, options(fake.port))).rejects.toMatchObject({
      name: 'SmtpError',
      code: 550,
    });
  });

  it('gives up on a relay that connects and then says nothing', async () => {
    const fake = await relay({}, { silent: true });

    await expect(sendMail(message, { ...options(fake.port), timeoutMs: 150 })).rejects.toThrow(
      SmtpError,
    );
  });

  it('fails rather than hanging when nothing is listening', async () => {
    // Port 1 on loopback: reserved, and nothing in this project binds it.
    await expect(
      sendMail(message, { host: '127.0.0.1', port: 1, clientName: 'x', timeoutMs: 500 }),
    ).rejects.toThrow(SmtpError);
  });

  it('refuses to send a header with a line break in it', async () => {
    const fake = await relay();

    await expect(
      sendMail({ ...message, to: 'a@b.test\r\nBcc: attacker@evil.test' }, options(fake.port)),
    ).rejects.toThrow(/inject a header/);
    expect(fake.recorded.commands).toHaveLength(0);
  });
});
