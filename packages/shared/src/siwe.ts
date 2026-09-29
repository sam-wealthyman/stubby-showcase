/**
 * Sign-In with Ethereum (EIP-4361), the wallet login from Section 4.1.
 *
 * Deliberately vendor-free. Wallet sign-in needs "no email, social account or
 * personal details", and it needs no auth provider either: the app builds a
 * message, the wallet signs it, the API checks the signature. That makes this
 * the one login method that can be finished before choosing between Supabase
 * Auth, Privy and Dynamic for email and X.
 *
 * This module is the message and its rules — building, parsing and validating.
 * Signature recovery needs keccak256 and lives in the API, where a crypto
 * library is already a dependency. Splitting it this way keeps the part that
 * both the app and the API must agree on free of native dependencies.
 *
 * **The validation here is a security boundary.** A SIWE message that is parsed
 * but not checked against the domain, chain and nonce the server issued is an
 * open door: an attacker replays a signature from another site, another chain or
 * another session. `validateSiweMessage` exists to make skipping that awkward.
 */

/** A parsed EIP-4361 message. */
export interface SiweMessage {
  /** RFC 3986 authority that is requesting the signing. */
  domain: string;
  /** The wallet being signed in, `0x` and 40 hex characters. */
  address: string;
  /** Human-readable assertion. One line, optional. */
  statement?: string;
  uri: string;
  version: '1';
  chainId: number;
  /** At least 8 alphanumeric characters. */
  nonce: string;
  /** ISO 8601. */
  issuedAt: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: readonly string[];
}

export class SiweParseError extends Error {
  override readonly name = 'SiweParseError';
}

/** The one piece of the platform crypto API a nonce needs. */
interface Csprng {
  getRandomValues<T extends Uint8Array>(array: T): T;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^[a-zA-Z0-9]{8,}$/;

/**
 * Generate a nonce.
 *
 * Uses the platform CSPRNG. A predictable nonce defeats the point of having
 * one, so there is no `Math.random` fallback: if no CSPRNG is available this
 * throws rather than quietly returning something guessable.
 */
export function generateNonce(length = 16): string {
  if (length < 8) throw new RangeError('a SIWE nonce must be at least 8 characters');
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  // Typed narrowly rather than pulling the whole DOM lib into a package the API
  // also consumes.
  const source = (globalThis as { crypto?: Csprng }).crypto;
  if (!source?.getRandomValues) {
    throw new Error('no CSPRNG available; refusing to generate a guessable nonce');
  }
  const bytes = source.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

/** Render a message in the exact EIP-4361 form a wallet expects to be shown. */
export function buildSiweMessage(message: SiweMessage): string {
  assertWellFormed(message);

  const lines: string[] = [
    `${message.domain} wants you to sign in with your Ethereum account:`,
    message.address,
    '',
  ];

  if (message.statement !== undefined) {
    lines.push(message.statement, '');
  }

  lines.push(
    `URI: ${message.uri}`,
    `Version: ${message.version}`,
    `Chain ID: ${message.chainId}`,
    `Nonce: ${message.nonce}`,
    `Issued At: ${message.issuedAt}`,
  );

  if (message.expirationTime !== undefined) {
    lines.push(`Expiration Time: ${message.expirationTime}`);
  }
  if (message.notBefore !== undefined) lines.push(`Not Before: ${message.notBefore}`);
  if (message.requestId !== undefined) lines.push(`Request ID: ${message.requestId}`);
  if (message.resources !== undefined && message.resources.length > 0) {
    lines.push('Resources:');
    for (const resource of message.resources) lines.push(`- ${resource}`);
  }

  return lines.join('\n');
}

/** Parse the message a wallet signed, back into its fields. */
export function parseSiweMessage(text: string): SiweMessage {
  const lines = text.split('\n');

  const header = /^(?<domain>.+) wants you to sign in with your Ethereum account:$/.exec(
    lines[0] ?? '',
  );
  if (!header?.groups?.domain) throw new SiweParseError('missing or malformed first line');

  const address = lines[1] ?? '';
  if (!ADDRESS.test(address)) throw new SiweParseError(`malformed address: ${address}`);
  if (lines[2] !== '') throw new SiweParseError('expected a blank line after the address');

  // A statement, when present, is one line followed by a blank line.
  let cursor = 3;
  let statement: string | undefined;
  if (lines[cursor] !== undefined && !lines[cursor]!.startsWith('URI: ')) {
    statement = lines[cursor];
    cursor += 1;
    if (lines[cursor] !== '') throw new SiweParseError('expected a blank line after the statement');
    cursor += 1;
  }

  const fields = new Map<string, string>();
  const resources: string[] = [];
  let inResources = false;

  for (const line of lines.slice(cursor)) {
    if (inResources) {
      if (!line.startsWith('- ')) throw new SiweParseError(`malformed resource line: ${line}`);
      resources.push(line.slice(2));
      continue;
    }
    if (line === 'Resources:') {
      inResources = true;
      continue;
    }
    const field = /^(?<key>[A-Za-z ]+): (?<value>.*)$/.exec(line);
    if (!field?.groups) throw new SiweParseError(`malformed field line: ${line}`);
    fields.set(field.groups.key!, field.groups.value!);
  }

  const required = (key: string): string => {
    const value = fields.get(key);
    if (value === undefined) throw new SiweParseError(`missing required field: ${key}`);
    return value;
  };

  const version = required('Version');
  if (version !== '1') throw new SiweParseError(`unsupported SIWE version: ${version}`);

  const chainId = Number(required('Chain ID'));
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new SiweParseError(`malformed Chain ID: ${fields.get('Chain ID')}`);
  }

  const message: SiweMessage = {
    domain: header.groups.domain,
    address,
    ...(statement === undefined ? {} : { statement }),
    uri: required('URI'),
    version: '1',
    chainId,
    nonce: required('Nonce'),
    issuedAt: required('Issued At'),
    ...(fields.has('Expiration Time') ? { expirationTime: fields.get('Expiration Time')! } : {}),
    ...(fields.has('Not Before') ? { notBefore: fields.get('Not Before')! } : {}),
    ...(fields.has('Request ID') ? { requestId: fields.get('Request ID')! } : {}),
    ...(resources.length > 0 ? { resources } : {}),
  };

  assertWellFormed(message);
  return message;
}

export type SiweFailure =
  | 'domain-mismatch'
  | 'chain-mismatch'
  | 'nonce-mismatch'
  | 'address-mismatch'
  | 'expired'
  | 'not-yet-valid'
  | 'issued-in-the-future';

export interface SiweExpectation {
  /** The domain the server actually serves. */
  domain: string;
  /** The chain the server expects, e.g. Arc testnet. */
  chainId: number;
  /** The nonce the server issued for this attempt. */
  nonce: string;
  /** The wallet the client claims, if the server already knows it. */
  address?: string;
  /** For tests, and for tolerating small clock differences. */
  now?: Date;
  /** How much clock skew to forgive. Default 60 seconds. */
  clockToleranceMs?: number;
}

/**
 * Check a parsed message against what the server expects.
 *
 * Returns the reasons it is unacceptable; an empty array means acceptable. It
 * returns every failure rather than the first, so a log line says everything
 * that was wrong with an attempt.
 *
 * A valid signature over an unchecked message proves only that *someone* signed
 * *something*. These are the checks that make it proof of signing in here, now,
 * for this session.
 */
export function validateSiweMessage(
  message: SiweMessage,
  expected: SiweExpectation,
): readonly SiweFailure[] {
  const failures: SiweFailure[] = [];
  const now = (expected.now ?? new Date()).getTime();
  const tolerance = expected.clockToleranceMs ?? 60_000;

  if (message.domain !== expected.domain) failures.push('domain-mismatch');
  if (message.chainId !== expected.chainId) failures.push('chain-mismatch');
  if (message.nonce !== expected.nonce) failures.push('nonce-mismatch');
  if (
    expected.address !== undefined &&
    message.address.toLowerCase() !== expected.address.toLowerCase()
  ) {
    failures.push('address-mismatch');
  }

  const at = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  const expiration = at(message.expirationTime);
  if (expiration !== undefined && now - tolerance > expiration) failures.push('expired');

  const notBefore = at(message.notBefore);
  if (notBefore !== undefined && now + tolerance < notBefore) failures.push('not-yet-valid');

  const issued = at(message.issuedAt);
  if (issued !== undefined && issued - tolerance > now) failures.push('issued-in-the-future');

  return failures;
}

function assertWellFormed(message: SiweMessage): void {
  if (!ADDRESS.test(message.address)) {
    throw new SiweParseError(`malformed address: ${message.address}`);
  }
  if (!NONCE.test(message.nonce)) {
    throw new SiweParseError(`nonce must be at least 8 alphanumeric characters: ${message.nonce}`);
  }
  if (message.statement?.includes('\n')) {
    throw new SiweParseError('statement must be a single line');
  }
  if (message.domain === '' || message.domain.includes('\n')) {
    throw new SiweParseError(`malformed domain: ${message.domain}`);
  }
  if (Number.isNaN(Date.parse(message.issuedAt))) {
    throw new SiweParseError(`Issued At is not a date: ${message.issuedAt}`);
  }
}
