import { describe, expect, it } from 'vitest';

import {
  EmailError,
  isUsableEmail,
  maskEmail,
  normaliseEmail,
  requireEmail,
} from '../src/email.js';

describe('normaliseEmail', () => {
  it('trims and lower-cases', () => {
    expect(normaliseEmail('  Sam.Ayangbola@Example.COM \n')).toBe('sam.ayangbola@example.com');
  });

  /**
   * Deliberately not clever.
   *
   * Stripping dots and `+tags` would make `a.b+x@gmail.com` and `ab@gmail.com`
   * one account — which is Gmail's local-part semantics, not the internet's.
   * Plenty of providers treat dots as significant, and guessing wrong either
   * merges two people's accounts or splits one person's.
   */
  it('keeps dots and plus-tags, because they are not ours to reinterpret', () => {
    expect(normaliseEmail('a.b+tag@example.com')).toBe('a.b+tag@example.com');
    expect(normaliseEmail('a.b+tag@example.com')).not.toBe(normaliseEmail('ab@example.com'));
  });
});

describe('isUsableEmail', () => {
  it('accepts ordinary addresses', () => {
    for (const good of [
      'a@b.co',
      'sam@example.com',
      'sam.ayangbola+stubby@gmail.com',
      'first-last@sub.domain.example.org',
      "o'brien@example.com",
      'user_name@example.co.uk',
    ]) {
      expect(isUsableEmail(good), good).toBe(true);
    }
  });

  it('rejects what would break the system', () => {
    for (const bad of [
      '',
      '   ',
      'nope',
      '@example.com',
      'sam@',
      'sam@@example.com',
      'sam example@example.com',
      'sam@example',
      'sam@.example.com',
      'sam@example..com',
      'sam@example.c',
      'sam\n@example.com',
      'sam@exam\tple.com',
    ]) {
      expect(isUsableEmail(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects a control character, which would break header encoding', () => {
    expect(isUsableEmail('sam\u0000@example.com')).toBe(false);
    expect(isUsableEmail('sam@example.com\u007f')).toBe(false);
  });

  it('enforces the RFC length limits', () => {
    expect(isUsableEmail(`${'a'.repeat(64)}@example.com`)).toBe(true);
    expect(isUsableEmail(`${'a'.repeat(65)}@example.com`)).toBe(false);
    // 255 is the limit, so a 254-character domain is fine and 256 is not.
    expect(isUsableEmail(`a@${'b'.repeat(250)}.com`)).toBe(true);
    expect(isUsableEmail(`a@${'b'.repeat(252)}.com`)).toBe(false);
  });

  it('is case-insensitive about acceptance', () => {
    expect(isUsableEmail('SAM@EXAMPLE.COM')).toBe(true);
  });
});

describe('requireEmail', () => {
  it('returns the normalised address', () => {
    expect(requireEmail(' Sam@Example.com ')).toBe('sam@example.com');
  });

  it('throws with a reason for anything unusable', () => {
    expect(() => requireEmail('nope')).toThrow(EmailError);
  });

  it('does not echo an unbounded string back into the error', () => {
    // The message ends up in logs; an attacker controls this input.
    const long = `${'x'.repeat(500)}@example.com`;
    expect(() => requireEmail(long)).toThrow(/x{80}"/);
  });
});

describe('maskEmail', () => {
  /**
   * Section 13.6 strips identifying data from crash reports, and an address is
   * identifying. The domain survives because "these failures are all one
   * provider" is worth being able to see.
   */
  it('hides the local part and keeps the domain', () => {
    expect(maskEmail('sam.ayangbola@gmail.com')).toBe('sa***@gmail.com');
  });

  it('does not leak a short local part', () => {
    // Showing both characters of a two-character local part would reveal all of
    // it, so a short local part gets one character shown, not two.
    expect(maskEmail('ab@example.com')).toBe('a***@example.com');
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });

  it('refuses to guess at something that is not an address', () => {
    expect(maskEmail('garbage')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
  });
});
