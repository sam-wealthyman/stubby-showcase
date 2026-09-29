import { describe, expect, it } from 'vitest';

import { decideLink, linkMessage } from '../src/auth/walletLink.js';

describe('decideLink', () => {
  it('links a wallet nobody holds', () => {
    expect(decideLink({ accountId: '7', currentOwner: null })).toEqual({ kind: 'link' });
  });

  /** Pressing the button twice is not an error. */
  it('is a success when the wallet is already yours', () => {
    expect(decideLink({ accountId: '7', currentOwner: '7' })).toEqual({ kind: 'already-yours' });
  });

  /**
   * The case that matters.
   *
   * Entries and prizes belong to the wallet (Section 4.2), so reassigning one
   * moves who can see them — a link that silently took over would be a way to
   * claim somebody else's history.
   */
  it('refuses a wallet another account holds', () => {
    expect(decideLink({ accountId: '7', currentOwner: '8' })).toEqual({ kind: 'taken' });
  });

  it('compares ids as strings, not numbers', () => {
    // BIGSERIAL outruns what a JS number holds exactly, which is why pg returns
    // it as text. Number('9007199254740993') === Number('9007199254740992').
    const a = '9007199254740993';
    const b = '9007199254740992';
    expect(decideLink({ accountId: a, currentOwner: b })).toEqual({ kind: 'taken' });
    expect(decideLink({ accountId: a, currentOwner: a })).toEqual({ kind: 'already-yours' });
  });
});

describe('linkMessage', () => {
  it('tells a refused caller what they can actually do', () => {
    const text = linkMessage({ kind: 'taken' });
    expect(text).toMatch(/sign in with that account|remove the wallet/i);
  });

  it('does not treat an existing link as a problem', () => {
    expect(linkMessage({ kind: 'already-yours' })).not.toMatch(/error|cannot|refus/i);
  });
});
