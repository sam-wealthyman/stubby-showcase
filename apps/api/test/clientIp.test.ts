import { describe, expect, it } from 'vitest';

import { clientFromChain } from '../src/http/clientIp.js';

const SOCKET = '10.0.0.1';

describe('clientFromChain', () => {
  /**
   * The bug that makes a rate limiter decorative.
   *
   * `X-Forwarded-For` is a client-supplied string. Trusting it when nothing
   * appends it means anyone sends a different value per request and gets a fresh
   * bucket every time — so the limit stops exactly nobody.
   */
  it('ignores the header entirely when no proxy is trusted', () => {
    expect(clientFromChain('1.2.3.4', SOCKET, 0)).toBe(SOCKET);
    expect(clientFromChain('1.2.3.4, 5.6.7.8', SOCKET, 0)).toBe(SOCKET);
  });

  it('reads the last entry behind one proxy', () => {
    // The rightmost entry was added by the closest proxy and is the only one it
    // actually observed.
    expect(clientFromChain('203.0.113.9', SOCKET, 1)).toBe('203.0.113.9');
  });

  /**
   * Counting from the left is the off-by-one that reopens the hole.
   *
   * A client that sends its own `X-Forwarded-For` prepends to the chain, so the
   * leftmost entry is attacker-controlled. Counting from the right means a
   * forged prefix cannot shift which entry is read.
   */
  it('cannot be shifted by a forged prefix', () => {
    const forged = 'evil-1, evil-2, evil-3, 203.0.113.9';
    expect(clientFromChain(forged, SOCKET, 1)).toBe('203.0.113.9');

    // However many entries the client invents, the answer does not move.
    const longer = `${'x, '.repeat(50)}203.0.113.9`;
    expect(clientFromChain(longer, SOCKET, 1)).toBe('203.0.113.9');
  });

  it('steps back one more entry for each additional trusted proxy', () => {
    const chain = 'client, proxy-a, proxy-b';
    expect(clientFromChain(chain, SOCKET, 1)).toBe('proxy-b');
    expect(clientFromChain(chain, SOCKET, 2)).toBe('proxy-a');
    expect(clientFromChain(chain, SOCKET, 3)).toBe('client');
  });

  it('does not run off the front of a chain shorter than expected', () => {
    // Misconfiguration, or a request that skipped a proxy. Falls back to the
    // leftmost entry rather than returning undefined.
    expect(clientFromChain('only-one', SOCKET, 3)).toBe('only-one');
  });

  it('tolerates whitespace and empty entries', () => {
    expect(clientFromChain('  , 203.0.113.9 ,  ', SOCKET, 1)).toBe('203.0.113.9');
  });

  it('falls back to the socket when the header is absent or empty', () => {
    expect(clientFromChain(undefined, SOCKET, 1)).toBe(SOCKET);
    expect(clientFromChain('', SOCKET, 1)).toBe(SOCKET);
    expect(clientFromChain('   ', SOCKET, 1)).toBe(SOCKET);
  });

  it('says unknown rather than throwing when there is no socket either', () => {
    // One bucket for everyone is the safe failure: it limits too much, not too
    // little.
    expect(clientFromChain(undefined, undefined, 0)).toBe('unknown');
  });
});
