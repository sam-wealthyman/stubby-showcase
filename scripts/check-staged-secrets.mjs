#!/usr/bin/env node
/**
 * Reject a secret before it becomes a commit.
 *
 * Narrow on purpose. A rule of "no 64-hex strings" would reject every
 * transaction hash in the docs and the public test keys the contract fixtures
 * depend on, and a hook that cries wolf is a hook people pass `--no-verify` to.
 *
 * So it looks for a 64-hex value that is being *assigned* or *passed as a key*,
 * which is the shape of the actual accidents:
 *
 *   DEPLOYER_PRIVATE_KEY=0x…          pasted into .env.example
 *   --private-key 0x…                 hardcoded in a script
 *   privateKeyToAccount('0x…')        pasted into a source file
 *
 * Plus anything at all in a `.env*` file, where no 64-hex value is ever
 * legitimate.
 *
 * Known-public fixtures are allowlisted in `.secrets-allowlist`. This catches
 * carelessness, not an attacker — someone who wants to commit a secret can, and
 * the answer to that is not keeping valuable keys where this runs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const HEX64 = '[0-9a-fA-F]{64}';

/** A 64-hex value being assigned, or handed to something key-shaped. */
const SUSPICIOUS = [
  new RegExp(
    `(?:PRIVATE_KEY|PRIVATEKEY|privateKey|SECRET_KEY|secretKey)\\w*\\s*[=:]\\s*['"\`]?(?:0x)?${HEX64}`,
  ),
  new RegExp(`--private-key[= ]+['"\`]?(?:0x)?${HEX64}`),
  new RegExp(`privateKeyToAccount\\(\\s*['"\`](?:0x)?${HEX64}`),
  new RegExp(`\\bmnemonic\\w*\\s*[=:]\\s*['"\`][a-z]+(?:\\s+[a-z]+){11,}`),
];

/** In an env file, any 64-hex value is a mistake. */
const ENV_FILE = /(^|\/)\.env(\.|$)/;

const allowed = new Set(
  existsSync('.secrets-allowlist')
    ? readFileSync('.secrets-allowlist', 'utf8')
        .split('\n')
        .map((line) => line.split('#')[0].trim().toLowerCase())
        .filter((line) => line.length > 0)
    : [],
);

const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((name) => name.length > 0);

const findings = [];

for (const file of staged) {
  let content;
  try {
    // The staged version, not the working tree: those can differ, and the
    // staged one is what would be committed.
    content = execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 32e6 });
  } catch {
    continue; // binary, deleted, or otherwise not text
  }

  content.split('\n').forEach((line, index) => {
    const hits = line.match(new RegExp(`(?:0x)?${HEX64}`, 'g')) ?? [];
    const notAllowed = hits.filter(
      (hit) =>
        !allowed.has(hit.toLowerCase()) && !allowed.has(hit.toLowerCase().replace(/^0x/, '')),
    );
    if (notAllowed.length === 0) return;

    const isEnv = ENV_FILE.test(file);
    const looksAssigned = SUSPICIOUS.some((pattern) => pattern.test(line));
    if (!isEnv && !looksAssigned) return;

    findings.push({
      file,
      line: index + 1,
      why: isEnv ? 'a 64-hex value in an env file' : 'a key-shaped assignment',
    });
  });
}

if (findings.length > 0) {
  console.error('\nRefusing to commit: this looks like a secret.\n');
  for (const { file, line, why } of findings) {
    // The value itself is deliberately not printed. Printing it would put it in
    // the terminal, the shell's scrollback and any session transcript — which is
    // exactly the leak this hook exists to prevent.
    console.error(`  ${file}:${line} — ${why}`);
  }
  console.error(
    '\nIf it is a public test fixture, add it to .secrets-allowlist with a note.' +
      '\nIf it is real, remove it and read CLAUDE.md before trying again.\n',
  );
  process.exit(1);
}
