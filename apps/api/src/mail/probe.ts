/**
 * Is the mail relay accepting connections? Connect, wait for its 220
 * greeting, say QUIT. Sends nothing and needs no credentials, so it is safe
 * to run as often as monitoring likes.
 */

import { createConnection } from 'node:net';

export function probeSmtp(host: string, port: number, timeoutMs = 4_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let greeting = '';
    const done = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new Error('no greeting from the relay')));
    socket.on('error', (error) => done(error));
    socket.on('data', (chunk) => {
      greeting += chunk.toString('utf8');
      if (!greeting.includes('\n')) return;
      if (greeting.startsWith('220')) {
        socket.write('QUIT\r\n');
        done();
      } else {
        done(new Error(`relay greeted with ${greeting.slice(0, 3)}`));
      }
    });
  });
}
