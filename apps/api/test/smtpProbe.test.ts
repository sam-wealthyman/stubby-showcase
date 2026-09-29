import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { probeSmtp } from '../src/mail/probe.js';

let server: Server | undefined;
afterEach(() => server?.close());

function relay(greeting: string): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((socket) => socket.write(greeting));
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port));
  });
}

describe('probeSmtp', () => {
  it('passes when the relay greets with 220', async () => {
    await expect(
      probeSmtp('127.0.0.1', await relay('220 mail ESMTP\r\n')),
    ).resolves.toBeUndefined();
  });

  it('fails when the relay refuses service', async () => {
    await expect(probeSmtp('127.0.0.1', await relay('554 no\r\n'))).rejects.toThrow('554');
  });

  it('fails when nothing is listening', async () => {
    const port = await relay('');
    server!.close();
    await expect(probeSmtp('127.0.0.1', port)).rejects.toThrow();
  });
});
