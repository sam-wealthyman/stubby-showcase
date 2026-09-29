import { describe, expect, it } from 'vitest';

import { checkUsername } from '../src/username.js';

describe('checkUsername', () => {
  it('accepts a plain name, trimmed', () => {
    expect(checkUsername('  Jack_42 ')).toEqual({ ok: true, username: 'Jack_42' });
  });

  it('refuses names that are too short or too long', () => {
    expect(checkUsername('ab')).toMatchObject({ ok: false, reason: 'length' });
    expect(checkUsername('a'.repeat(21))).toMatchObject({ ok: false, reason: 'length' });
  });

  it('refuses spaces, symbols and look-alike characters', () => {
    for (const bad of ['jack smith', 'jack!', 'jаck', 'ja.ck']) {
      expect(checkUsername(bad), bad).toMatchObject({ ok: false, reason: 'characters' });
    }
  });

  it('must start with a letter', () => {
    expect(checkUsername('1jack')).toMatchObject({ ok: false, reason: 'start' });
    expect(checkUsername('_jack')).toMatchObject({ ok: false, reason: 'start' });
  });

  it('refuses names that pass as Stubby or its staff, however cased', () => {
    for (const bad of ['Stubby', 'ADMIN', 'Support', 'stub_by']) {
      expect(checkUsername(bad), bad).toMatchObject({ ok: false, reason: 'reserved' });
    }
  });
});
