/**
 * Email addresses as a login handle.
 *
 * Section 4.1: email is a handle and nothing more — never verified against
 * identity, never used to decide anything but "which account is this". That
 * narrows the job considerably. This does not need to know whether an address
 * can receive mail, only whether two strings mean the same account.
 *
 * Shared between the app and the API so they cannot disagree. A client that
 * normalises differently from the server creates accounts the user cannot sign
 * back into.
 */

export class EmailError extends Error {
  override readonly name = 'EmailError';
}

/** The longest address the RFCs allow: 64 local + @ + 255 domain. */
export const MAX_EMAIL_LENGTH = 320;

/**
 * Normalise an address for storage and comparison.
 *
 * Trimmed and lower-cased, and **nothing else**. It is tempting to strip dots
 * and `+tags` so that `a.b+x@gmail.com` and `ab@gmail.com` are one account, but
 * that is Gmail's local-part semantics, not the internet's: plenty of providers
 * treat dots as significant, and guessing wrong merges two people's accounts or
 * splits one person's. Lower-casing the domain is safe because DNS is
 * case-insensitive; lower-casing the local part is technically a choice, and it
 * is the one every provider in practice makes.
 */
export function normaliseEmail(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Is this usable as a login handle?
 *
 * Deliberately permissive. The famous RFC 5322 regex accepts things no provider
 * would issue and rejects things that work, and a login form that refuses a
 * valid address is worse than one that accepts an unusable one — an address that
 * cannot receive mail simply never completes the sign-in, at no cost to anyone.
 *
 * So this checks only what would break the system rather than what might bounce:
 * exactly one `@`, something on each side, no whitespace, no control characters,
 * and a domain with a dot in it.
 */
export function isUsableEmail(input: string): boolean {
  const email = normaliseEmail(input);
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false;
  // Whitespace and control characters would break header encoding and make a
  // log line unreadable. Checked by code point rather than by regex: a literal
  // control character in a pattern is almost always a mistake, `no-control-regex`
  // is right to say so, and suppressing it would be a worse signal than this.
  if (/\s/.test(email)) return false;
  for (const character of email) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
  }

  const parts = email.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || local.length > 64) return false;
  if (domain.length === 0 || domain.length > 255) return false;
  // A dot with something either side. Rules out `@localhost` and trailing dots,
  // which are valid in the RFCs and never what a person typed on purpose.
  if (!/^[^.].*\.[^.]{2,}$/.test(domain)) return false;
  if (domain.includes('..')) return false;
  return true;
}

/** Normalise, or throw with a reason worth showing. */
export function requireEmail(input: string): string {
  const email = normaliseEmail(input);
  if (!isUsableEmail(email)) {
    throw new EmailError(`Not a usable email address: ${JSON.stringify(input.slice(0, 80))}`);
  }
  return email;
}

/**
 * An address with the local part hidden, for logs and error reports.
 *
 * Section 13.6 strips identifying data from crash reports, and an email is
 * identifying. The domain is kept because "the failures are all one provider" is
 * worth being able to see.
 */
export function maskEmail(input: string): string {
  const email = normaliseEmail(input);
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${shown}***${domain}`;
}
