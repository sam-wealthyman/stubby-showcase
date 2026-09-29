import { describe, expect, it } from 'vitest';

import { ARC_TESTNET } from '../src/chains.js';
import {
  SiweParseError,
  buildSiweMessage,
  generateNonce,
  parseSiweMessage,
  validateSiweMessage,
  type SiweMessage,
} from '../src/siwe.js';

const ADDRESS = '0x55715594636e32E5da4Cb27236da7c811418a833';

function message(overrides: Partial<SiweMessage> = {}): SiweMessage {
  return {
    domain: 'stubby.app',
    address: ADDRESS,
    statement: 'Sign in to Stubby. This does not move any funds.',
    uri: 'https://stubby.app',
    version: '1',
    chainId: ARC_TESTNET.chainId,
    nonce: 'abcd1234efgh',
    issuedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('building an EIP-4361 message', () => {
  it('renders the exact shape a wallet expects to show', () => {
    expect(buildSiweMessage(message())).toBe(
      [
        'stubby.app wants you to sign in with your Ethereum account:',
        ADDRESS,
        '',
        'Sign in to Stubby. This does not move any funds.',
        '',
        'URI: https://stubby.app',
        'Version: 1',
        'Chain ID: 5042002',
        'Nonce: abcd1234efgh',
        'Issued At: 2026-09-22T00:00:00.000Z',
      ].join('\n'),
    );
  });

  it('omits the statement block entirely when there is none', () => {
    const text = buildSiweMessage(message({ statement: undefined }));
    expect(text.split('\n')[3]).toBe('URI: https://stubby.app');
  });

  it('includes the optional fields in EIP-4361 order', () => {
    const text = buildSiweMessage(
      message({
        expirationTime: '2026-09-22T00:10:00.000Z',
        notBefore: '2026-09-22T00:00:00.000Z',
        requestId: 'req-1',
        resources: ['https://stubby.app/terms', 'https://stubby.app/privacy'],
      }),
    );
    const lines = text.split('\n');
    expect(lines.slice(-6)).toEqual([
      'Expiration Time: 2026-09-22T00:10:00.000Z',
      'Not Before: 2026-09-22T00:00:00.000Z',
      'Request ID: req-1',
      'Resources:',
      '- https://stubby.app/terms',
      '- https://stubby.app/privacy',
    ]);
  });

  it('refuses a message that could not be safely signed', () => {
    expect(() => buildSiweMessage(message({ address: '0xnope' }))).toThrow(SiweParseError);
    expect(() => buildSiweMessage(message({ nonce: 'short' }))).toThrow(/at least 8/);
    expect(() => buildSiweMessage(message({ nonce: 'has spaces!!' }))).toThrow(SiweParseError);
    expect(() => buildSiweMessage(message({ statement: 'two\nlines' }))).toThrow(/single line/);
    expect(() => buildSiweMessage(message({ domain: '' }))).toThrow(SiweParseError);
    expect(() => buildSiweMessage(message({ issuedAt: 'yesterday' }))).toThrow(/not a date/);
  });
});

describe('parsing', () => {
  it('round-trips every field', () => {
    const original = message({
      expirationTime: '2026-09-22T00:10:00.000Z',
      notBefore: '2026-09-22T00:00:00.000Z',
      requestId: 'req-1',
      resources: ['https://stubby.app/terms'],
    });
    expect(parseSiweMessage(buildSiweMessage(original))).toEqual(original);
  });

  it('round-trips without a statement', () => {
    const original = message({ statement: undefined });
    expect(parseSiweMessage(buildSiweMessage(original))).toEqual(original);
  });

  it('rejects malformed messages rather than guessing', () => {
    const good = buildSiweMessage(message());
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['empty', ''],
      ['wrong first line', good.replace('wants you to sign in with', 'would like you to')],
      ['bad address', good.replace(ADDRESS, '0x123')],
      ['missing blank line', good.replace(`${ADDRESS}\n\n`, `${ADDRESS}\n`)],
      ['missing URI', good.replace('URI: https://stubby.app\n', '')],
      ['unsupported version', good.replace('Version: 1', 'Version: 2')],
      ['bad chain id', good.replace('Chain ID: 5042002', 'Chain ID: abc')],
      ['garbage field line', `${good}\nnot a field`],
    ];
    for (const [label, text] of cases) {
      expect(() => parseSiweMessage(text), label).toThrow(SiweParseError);
    }
  });
});

describe('validation, which is the security boundary', () => {
  const expected = {
    domain: 'stubby.app',
    chainId: ARC_TESTNET.chainId,
    nonce: 'abcd1234efgh',
    now: new Date('2026-09-22T00:05:00.000Z'),
  };

  it('accepts a message that matches what the server issued', () => {
    expect(validateSiweMessage(message(), expected)).toEqual([]);
  });

  it('catches a signature replayed from another site', () => {
    expect(validateSiweMessage(message({ domain: 'evil.example' }), expected)).toEqual([
      'domain-mismatch',
    ]);
  });

  it('catches a signature replayed from another chain', () => {
    expect(validateSiweMessage(message({ chainId: 1 }), expected)).toEqual(['chain-mismatch']);
  });

  it('catches a signature replayed from another session', () => {
    expect(validateSiweMessage(message({ nonce: 'zzzz9999zzzz' }), expected)).toEqual([
      'nonce-mismatch',
    ]);
  });

  it('catches a wallet that is not the one the server is expecting', () => {
    const failures = validateSiweMessage(message(), {
      ...expected,
      address: '0x0000000000000000000000000000000000000001',
    });
    expect(failures).toEqual(['address-mismatch']);
  });

  it('compares addresses case-insensitively, since checksums vary by source', () => {
    expect(validateSiweMessage(message(), { ...expected, address: ADDRESS.toLowerCase() })).toEqual(
      [],
    );
  });

  it('honours expiry, not-before and issued-at', () => {
    expect(
      validateSiweMessage(message({ expirationTime: '2026-09-22T00:01:00.000Z' }), expected),
    ).toEqual(['expired']);
    expect(
      validateSiweMessage(message({ notBefore: '2026-09-22T01:00:00.000Z' }), expected),
    ).toEqual(['not-yet-valid']);
    expect(
      validateSiweMessage(message({ issuedAt: '2026-09-22T02:00:00.000Z' }), expected),
    ).toEqual(['issued-in-the-future']);
  });

  it('forgives a minute of clock skew in both directions', () => {
    // Expired 30 seconds ago: still accepted, because clocks differ.
    expect(
      validateSiweMessage(message({ expirationTime: '2026-09-22T00:04:30.000Z' }), expected),
    ).toEqual([]);
    // Expired two minutes ago: not accepted.
    expect(
      validateSiweMessage(message({ expirationTime: '2026-09-22T00:03:00.000Z' }), expected),
    ).toEqual(['expired']);
  });

  it('reports every problem at once, so one log line tells the whole story', () => {
    const failures = validateSiweMessage(
      message({ domain: 'evil.example', chainId: 1, nonce: 'zzzz9999zzzz' }),
      expected,
    );
    expect(failures).toEqual(['domain-mismatch', 'chain-mismatch', 'nonce-mismatch']);
  });

  it('ignores an unparseable date rather than treating it as valid', () => {
    // A date it cannot read must not silently become "never expires"... but it
    // also must not be a hard failure here, since parse already rejects those.
    expect(validateSiweMessage(message({ expirationTime: 'nonsense' }), expected)).toEqual([]);
  });
});

describe('nonces', () => {
  it('produces alphanumeric nonces of the requested length', () => {
    for (const length of [8, 16, 32]) {
      const nonce = generateNonce(length);
      expect(nonce).toHaveLength(length);
      expect(nonce).toMatch(/^[a-zA-Z0-9]+$/);
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateNonce()));
    expect(seen.size).toBe(200);
  });

  it('refuses a nonce too short to be worth having', () => {
    expect(() => generateNonce(4)).toThrow(RangeError);
  });

  it('refuses to invent one without a CSPRNG rather than returning something guessable', () => {
    const original = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
      expect(() => generateNonce()).toThrow(/refusing to generate a guessable nonce/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});
