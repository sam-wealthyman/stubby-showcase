import { describe, expect, it } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

import { ARC_TESTNET } from '../src/chains.js';
import { buildSiweMessage, generateNonce, type SiweMessage } from '../src/siwe.js';
import { createMemoryNonceStore, verifySiweSignature } from '../src/siweVerify.js';

const account = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());

const NOW = new Date('2026-09-22T12:00:00.000Z');

function message(overrides: Partial<SiweMessage> = {}): SiweMessage {
  return {
    domain: 'stubby.app',
    address: account.address,
    statement: 'Sign in to Stubby. This does not move any funds.',
    uri: 'https://stubby.app',
    version: '1',
    chainId: ARC_TESTNET.chainId,
    nonce: 'abcd1234efgh',
    issuedAt: NOW.toISOString(),
    expirationTime: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

const expected = {
  domain: 'stubby.app',
  chainId: ARC_TESTNET.chainId,
  nonce: 'abcd1234efgh',
  now: NOW,
};

describe('a genuine sign-in', () => {
  it('verifies a real signature from the wallet that claims it', async () => {
    const text = buildSiweMessage(message());
    const signature = await account.signMessage({ message: text });

    const result = await verifySiweSignature({ message: text, signature, expected });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.address).toBe(account.address);
      expect(result.message.nonce).toBe('abcd1234efgh');
    }
  });

  it('binds the session to the wallet, not to whoever posted it', async () => {
    const text = buildSiweMessage(message());
    const signature = await account.signMessage({ message: text });
    const result = await verifySiweSignature({
      message: text,
      signature,
      expected: { ...expected, address: account.address },
    });
    expect(result.valid).toBe(true);
  });
});

describe('the attacks this exists to stop', () => {
  it('rejects a signature from a different wallet', async () => {
    // The attacker signs a message claiming to be someone else.
    const text = buildSiweMessage(message());
    const signature = await other.signMessage({ message: text });

    const result = await verifySiweSignature({ message: text, signature, expected });
    expect(result).toEqual({ valid: false, reason: 'bad-signature' });
  });

  it('rejects a message altered after signing', async () => {
    const text = buildSiweMessage(message());
    const signature = await account.signMessage({ message: text });
    const tampered = text.replace('stubby.app wants', 'evil.example wants');

    const result = await verifySiweSignature({
      message: tampered,
      signature,
      expected: { ...expected, domain: 'evil.example' },
    });
    // The domain now matches what the attacker claims to expect, so the message
    // passes validation — and the signature is what catches it.
    expect(result).toEqual({ valid: false, reason: 'bad-signature' });
  });

  it('rejects a signature replayed against another site', async () => {
    const text = buildSiweMessage(message({ domain: 'someone-else.example' }));
    const signature = await account.signMessage({ message: text });

    const result = await verifySiweSignature({ message: text, signature, expected });
    expect(result.valid).toBe(false);
    if (!result.valid && result.reason === 'message-rejected') {
      expect(result.failures).toContain('domain-mismatch');
    }
  });

  it('rejects a signature replayed from another session', async () => {
    const text = buildSiweMessage(message({ nonce: 'zzzz9999zzzz' }));
    const signature = await account.signMessage({ message: text });

    const result = await verifySiweSignature({ message: text, signature, expected });
    expect(result.valid).toBe(false);
    if (!result.valid && result.reason === 'message-rejected') {
      expect(result.failures).toContain('nonce-mismatch');
    }
  });

  it('rejects an expired sign-in even though the signature is perfect', async () => {
    const text = buildSiweMessage(message());
    const signature = await account.signMessage({ message: text });

    const result = await verifySiweSignature({
      message: text,
      signature,
      expected: { ...expected, now: new Date(NOW.getTime() + 60 * 60_000) },
    });
    expect(result.valid).toBe(false);
    if (!result.valid && result.reason === 'message-rejected') {
      expect(result.failures).toContain('expired');
    }
  });

  it('rejects a wallet other than the one the server is expecting', async () => {
    const text = buildSiweMessage(message());
    const signature = await account.signMessage({ message: text });

    const result = await verifySiweSignature({
      message: text,
      signature,
      expected: { ...expected, address: other.address },
    });
    expect(result.valid).toBe(false);
    if (!result.valid && result.reason === 'message-rejected') {
      expect(result.failures).toContain('address-mismatch');
    }
  });
});

describe('malformed input', () => {
  it('reports a malformed message without attempting recovery', async () => {
    const result = await verifySiweSignature({
      message: 'this is not a SIWE message',
      signature: '0xdeadbeef',
      expected,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('malformed');
  });

  it('returns a result for a malformed signature rather than throwing', async () => {
    // A caller that handles failure with try/catch tends to treat an unexpected
    // error as a success, so this must never throw.
    const text = buildSiweMessage(message());
    const result = await verifySiweSignature({
      message: text,
      signature: '0xnotasignature',
      expected,
    });
    expect(result).toEqual({ valid: false, reason: 'bad-signature' });
  });
});

describe('nonces are single use, which is the point of having them', () => {
  it('accepts a nonce once and never again', async () => {
    const store = createMemoryNonceStore();
    const nonce = generateNonce();
    await store.issue(nonce, new Date(NOW.getTime() + 300_000));

    expect(await store.consume(nonce, NOW)).toBe(true);
    // The replay.
    expect(await store.consume(nonce, NOW)).toBe(false);
  });

  it('rejects a nonce it never issued', async () => {
    const store = createMemoryNonceStore();
    expect(await store.consume('neverissued1', NOW)).toBe(false);
  });

  it('rejects an expired nonce', async () => {
    const store = createMemoryNonceStore();
    const nonce = generateNonce();
    await store.issue(nonce, new Date(NOW.getTime() + 1000));
    expect(await store.consume(nonce, new Date(NOW.getTime() + 60_000))).toBe(false);
  });

  it('does not grow without bound', async () => {
    const store = createMemoryNonceStore();
    for (let i = 0; i < 50; i += 1) {
      await store.issue(generateNonce(), new Date(NOW.getTime() + 1000));
    }
    expect(store.size()).toBe(50);
    // Sweeping happens on use, so one consume clears everything expired.
    await store.consume('anything', new Date(NOW.getTime() + 60_000));
    expect(store.size()).toBe(0);
  });

  it('survives the full flow: issue, sign, verify, consume, replay', async () => {
    const store = createMemoryNonceStore();
    const nonce = generateNonce();
    await store.issue(nonce, new Date(NOW.getTime() + 300_000));

    const text = buildSiweMessage(message({ nonce }));
    const signature = await account.signMessage({ message: text });

    const result = await verifySiweSignature({
      message: text,
      signature,
      expected: { ...expected, nonce },
    });
    expect(result.valid).toBe(true);
    expect(await store.consume(nonce, NOW)).toBe(true);

    // The same signature posted again: still cryptographically valid, and still
    // refused, because the nonce is spent. This is why the store exists.
    const replay = await verifySiweSignature({
      message: text,
      signature,
      expected: { ...expected, nonce },
    });
    expect(replay.valid).toBe(true);
    expect(await store.consume(nonce, NOW)).toBe(false);
  });
});
