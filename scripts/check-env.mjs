#!/usr/bin/env node
/**
 * Check `.env` against reality, not against itself.
 *
 * Every problem this catches was found by hand first, which is the argument for
 * it existing: a missing variable, a value that looks right and points at the
 * wrong chain, a Supabase host with no IPv4 route. None of those fail at
 * startup with a message that names the cause.
 *
 * Read-only. Prints no secret, only whether one is present and whether it
 * works. Exits non-zero on an error so CI can run it.
 *
 *   node scripts/check-env.mjs           # skips anything needing the network
 *   node scripts/check-env.mjs --online  # also resolves DNS and calls the RPC
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve4, resolve6 } from 'node:dns/promises';

const ONLINE = process.argv.includes('--online');

let failures = 0;
let warnings = 0;
const ok = (name, detail) => console.log(`  \u001b[32m✓\u001b[0m ${name.padEnd(26)} ${detail}`);
const bad = (name, detail) => {
  console.log(`  \u001b[31m✗\u001b[0m ${name.padEnd(26)} ${detail}`);
  failures += 1;
};
const warn = (name, detail) => {
  console.log(`  \u001b[33m!\u001b[0m ${name.padEnd(26)} ${detail}`);
  warnings += 1;
};
const skip = (name, detail) => console.log(`  \u001b[90m·\u001b[0m ${name.padEnd(26)} ${detail}`);

/**
 * Parse `.env` ourselves rather than sourcing it.
 *
 * Sourcing makes an absent variable and an empty one indistinguishable, and
 * that difference has already hidden one real bug: two `EXPO_PUBLIC_*`
 * variables were missing from the file entirely while a check that sourced it
 * reported them as merely empty.
 */
function readEnvFile(path) {
  const present = new Map();
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) present.set(match[1], match[2]);
  }
  return present;
}

const fromFile = readEnvFile('.env');
if (fromFile === null) {
  console.log('No .env found. Copy .env.example and fill it in.');
  process.exit(1);
}

/*
 * The environment wins over the file, as in `check-chain.mjs`.
 *
 * Parsing the file is still what distinguishes "absent" from "empty" — that
 * distinction has caught a real bug and is why this does not just source it.
 * But reading *only* the file means the script cannot check the configuration a
 * process is actually running under, and silently ignores any override given on
 * the command line. That was found by passing ARC_CHAIN_ID=5042 to test the
 * mainnet escalation below and watching it do nothing.
 */
const env = new Map(fromFile);
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && value !== '') env.set(key, value);
}

const required = (name, test, detail) => {
  if (!env.has(name)) return bad(name, 'missing from .env entirely');
  const value = env.get(name);
  if (value === '') return bad(name, 'present but empty');
  if (test && !test(value)) return bad(name, `does not look like ${detail}`);
  return ok(name, detail ?? 'set');
};

const optional = (name, note) => {
  if (!env.has(name)) return warn(name, `missing from .env — ${note}`);
  if (env.get(name) === '') return skip(name, `empty — ${note}`);
  return ok(name, 'set');
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

console.log('\nchain');
required('ARC_RPC_URL', (v) => v.startsWith('https://'), 'an https RPC URL');
required('ARC_CHAIN_ID', (v) => /^\d+$/.test(v), 'a chain id');
required('USDC_ADDRESS', (v) => ADDRESS.test(v), 'an address');
required('RAFFLE_CONTRACT_ADDRESS', (v) => ADDRESS.test(v), 'an address');
required('ADAPTER_ADDRESS', (v) => ADDRESS.test(v), 'an address');
required('VRF_COORDINATOR_ADDRESS', (v) => ADDRESS.test(v), 'an address');
required('OWNER_ADDRESS', (v) => ADDRESS.test(v), 'an address');
required('TREASURY_ADDRESS', (v) => ADDRESS.test(v), 'an address');
/*
 * A deploy key in a file is no longer required, and is now reported as a
 * problem rather than a requirement.
 *
 * Foundry reads an encrypted keystore with `--account`, so nothing needs the
 * plaintext. While it is here it is in the environment of every process started
 * after `set -a && . ./.env`, on disk in every backup, and readable by anything
 * that can read a file in this directory. See docs/key-management.md.
 */
/*
 * The day-to-day key. Disposable, owns the testnet contracts and nothing on
 * mainnet, so leaking it costs faucet money — which is the point (CLAUDE.md).
 */
const devKey = env.get('DEV_PRIVATE_KEY') ?? '';
if (!devKey) {
  warn('DEV_PRIVATE_KEY', 'unset — testnet work would need the mainnet key instead');
} else if (!/^0x[0-9a-fA-F]{64}$/.test(devKey)) {
  bad('DEV_PRIVATE_KEY', 'present but not a private key');
} else {
  ok('DEV_PRIVATE_KEY', 'set — disposable, testnet only');
}

const deployKey = env.get('DEPLOYER_PRIVATE_KEY') ?? '';
const mainnet = env.get('ARC_CHAIN_ID') === '5042';

/*
 * An accepted risk is not a warning.
 *
 * The platform owner has decided to keep the key in the file (recorded in
 * Section 13.5 with the date). Repeating the objection on every run would make
 * `check:env` noisy in the way that teaches people to skim its output, and the
 * next real problem would be skimmed with it.
 *
 * So the acknowledgement downgrades it to a note — which still prints, so a
 * fresh clone or a new machine without the variable gets the full warning, and
 * the risk never silently disappears from view.
 */
const accepted = (env.get('DEPLOYER_KEY_IN_FILE_ACCEPTED') ?? '').trim();

if (!deployKey) {
  ok('DEPLOYER_PRIVATE_KEY', 'absent — use `forge script --account <name>`');
} else if (!/^0x[0-9a-fA-F]{64}$/.test(deployKey)) {
  bad('DEPLOYER_PRIVATE_KEY', 'present but not a private key');
} else if (accepted) {
  skip('DEPLOYER_PRIVATE_KEY', `plaintext key, accepted ${accepted} (docs/key-management.md)`);
} else if (mainnet) {
  // A key in a file while pointed at mainnet is the combination worth failing
  // on, unless it has been accepted deliberately.
  bad(
    'DEPLOYER_PRIVATE_KEY',
    'a plaintext key while ARC_CHAIN_ID is mainnet — keystore it, or set DEPLOYER_KEY_IN_FILE_ACCEPTED',
  );
} else {
  warn(
    'DEPLOYER_PRIVATE_KEY',
    'plaintext key in .env — `cast wallet import` and delete the line (docs/key-management.md)',
  );
}

console.log('\ndatabase');
if (!env.has('DATABASE_URL') || env.get('DATABASE_URL') === '') {
  warn('DATABASE_URL', 'not set — the API cannot run');
} else {
  const url = env.get('DATABASE_URL');
  /*
   * What matters since the move off Supabase (ADR 0009) is no longer which
   * pooler: it is whether credentials cross a network in the clear. TLS off is
   * correct for a container on loopback and is a credential leak to anything
   * else, so the same setting is judged by where it points.
   */
  const host = /@([^/:?]+)/.exec(url)?.[1] ?? '';
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const tlsOff = /[?&]sslmode=disable(&|$)/.test(url);
  if (url.includes('PASSWORD')) bad('DATABASE_URL', 'still contains a placeholder');
  else if (tlsOff && !loopback) {
    bad('DATABASE_URL', `sslmode=disable to ${host} — credentials would cross a network in clear`);
  } else if (tlsOff) ok('DATABASE_URL', `${host}, TLS off — it never leaves the machine`);
  else ok('DATABASE_URL', `${host} over TLS`);
}

// Encrypted is not the same as verified. Without the CA the API connects with
// certificate verification off, which is survivable locally and is not
// survivable in production: nothing proves the far end is the database.
const caPath = env.get('DATABASE_CA_CERT') ?? '';
const tlsDisabled = /[?&]sslmode=disable(&|$)/.test(env.get('DATABASE_URL') ?? '');
if (!caPath && tlsDisabled) skip('DATABASE_CA_CERT', 'nothing to verify — TLS is off by choice');
else if (!caPath) {
  warn('DATABASE_CA_CERT', 'unset — TLS is unverified; fine locally, not in production');
} else if (!existsSync(caPath)) bad('DATABASE_CA_CERT', `no file at ${caPath}`);
else ok('DATABASE_CA_CERT', 'TLS verified against a pinned CA');

console.log('\nobservability');
// Expo only exposes EXPO_PUBLIC_* to the bundle, so the app half is a separate
// variable and a set API half with an unset app half means the app reports
// nothing at all.
const dsn = env.get('SENTRY_DSN') ?? '';
const publicDsn = env.get('EXPO_PUBLIC_SENTRY_DSN') ?? '';
const looksLikeDsn = (v) => /^https:\/\/[0-9a-zA-Z]+@[a-z0-9.-]+\/\d+$/.test(v);
if (dsn && !looksLikeDsn(dsn)) bad('SENTRY_DSN', 'not a DSN (expected https://KEY@HOST/ID)');
else if (dsn) ok('SENTRY_DSN', 'a Sentry DSN');
else skip('SENTRY_DSN', 'empty — the API reports nothing');
if (dsn && !publicDsn) {
  bad('EXPO_PUBLIC_SENTRY_DSN', 'empty while SENTRY_DSN is set — the APP reports nothing');
} else if (publicDsn && !looksLikeDsn(publicDsn)) {
  bad('EXPO_PUBLIC_SENTRY_DSN', 'not a DSN');
} else if (publicDsn) ok('EXPO_PUBLIC_SENTRY_DSN', 'a Sentry DSN');
else skip('EXPO_PUBLIC_SENTRY_DSN', 'empty — the app reports nothing');

// EIP-4361's `domain` is an authority, not a URL. A scheme or a path here is
// rejected by every wallet, and a mismatched port is the more common mistake:
// Expo serves web on 8081, so localhost alone does not match.
const siweDomain = env.get('SIWE_DOMAIN') ?? '';
console.log('\nauth');
if (!siweDomain) warn('SIWE_DOMAIN', 'unset — wallet login cannot build a message');
else if (/:\/\//.test(siweDomain))
  bad('SIWE_DOMAIN', 'includes a scheme; it must be host[:port] only');
else if (siweDomain.includes('/'))
  bad('SIWE_DOMAIN', 'includes a path; it must be host[:port] only');
else if (/^localhost(:\d+)?$/.test(siweDomain) && !siweDomain.includes(':')) {
  warn('SIWE_DOMAIN', 'localhost with no port — Expo web serves on 8081, so this will not match');
} else ok('SIWE_DOMAIN', siweDomain);

// The session is a cookie, and a browser will not send credentials to a
// wildcard origin — so `*` does not loosen the policy, it stops sign-in working.
const origins = env.get('ALLOWED_ORIGINS') ?? '';
if (!origins) warn('ALLOWED_ORIGINS', 'unset — defaults to http://localhost:8081');
else if (origins.includes('*')) bad('ALLOWED_ORIGINS', 'a wildcard cannot be used with cookies');
else if (!origins.split(',').every((o) => /^https?:\/\/[^/]+$/.test(o.trim()))) {
  bad('ALLOWED_ORIGINS', 'each entry must be scheme://host[:port] with no path');
} else ok('ALLOWED_ORIGINS', origins);

/*
 * Email login works without a provider in development: the API prints the link
 * to its own output, which beats configuring a provider to mail yourself. In
 * production there is no provider, so `/auth/email/request` answers 502 rather
 * than accepting every request and delivering nothing.
 */
const smtpHost = env.get('SMTP_HOST') ?? '';
const mailFrom = env.get('MAIL_FROM') ?? '';
if (!smtpHost && !mailFrom) {
  skip('SMTP_HOST', 'no relay — dev prints the link, production refuses to send');
} else if (!smtpHost || !mailFrom) {
  // Half-configured stops the API at startup, so catching it here is the
  // difference between a failed deploy and a message before one.
  bad(smtpHost ? 'MAIL_FROM' : 'SMTP_HOST', 'set without the other — the API will refuse to start');
} else if (!/@[^@\s]+\.[^@\s]+>?$/.test(mailFrom)) {
  bad('MAIL_FROM', 'does not end in an address — expected `Name <user@host>` or `user@host`');
} else ok('SMTP_HOST', `${smtpHost}:${env.get('SMTP_PORT') || '25'} as ${mailFrom}`);

console.log('\nnot yet consumed');
optional('WALLETCONNECT_PROJECT_ID', 'needed by wallet connection');
optional('IP_INTELLIGENCE_API_KEY', 'needed by the deposit-time geo check');
if (ONLINE) {
  console.log('\nonline checks');
  const dbUrl = env.get('DATABASE_URL') ?? '';
  const host = /@([^:/]+)/.exec(dbUrl)?.[1];
  if (host) {
    const v4 = await resolve4(host).catch(() => null);
    const v6 = await resolve6(host).catch(() => null);
    if (v4) ok('database host', `${host} has IPv4`);
    else if (v6) {
      bad('database host', `${host} is IPv6-only — unreachable from IPv4-only hosts`);
    } else warn('database host', `${host} does not resolve`);
  }

  const rpc = env.get('ARC_RPC_URL');
  if (rpc) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(10_000),
      });
      const { result } = await res.json();
      const actual = String(Number.parseInt(result, 16));
      if (actual === env.get('ARC_CHAIN_ID')) ok('RPC', `reachable, chain ${actual}`);
      else bad('RPC', `chain ${actual} but ARC_CHAIN_ID says ${env.get('ARC_CHAIN_ID')}`);
    } catch (error) {
      warn('RPC', `unreachable: ${error instanceof Error ? error.message : error}`);
    }
  }
}

console.log(`\n${failures} problem(s), ${warnings} warning(s)\n`);
process.exit(failures > 0 ? 1 : 0);
