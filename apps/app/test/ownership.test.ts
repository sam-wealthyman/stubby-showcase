import { describe, expect, it } from 'vitest';

import {
  addressProblemMessage,
  checkAddress,
  handoverState,
  shorten,
} from '../src/chain/ownership.js';

const OWNER = '0x55715594636e32E5da4Cb27236da7c811418a833';
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ZERO = '0x0000000000000000000000000000000000000000';

describe('checkAddress', () => {
  it('accepts an address and returns it checksummed', () => {
    // EIP-55 casing is a checksum. Normalising here means a later comparison
    // cannot miss because one side was pasted lower-case.
    expect(checkAddress(OTHER.toLowerCase()).address).toBe(OTHER);
  });

  it('tolerates surrounding whitespace, which pasting adds', () => {
    expect(checkAddress(`  ${OTHER}  `).address).toBe(OTHER);
  });

  it('asks for a value rather than complaining when empty', () => {
    expect(checkAddress('').problem).toBe('empty');
    expect(checkAddress('   ').problem).toBe('empty');
  });

  it('rejects anything that is not an address', () => {
    for (const bad of ['0x123', OTHER.slice(0, -1), `${OTHER}00', 'nope`, '55715594636e32E5']) {
      expect(checkAddress(bad).problem, bad).toBe('malformed');
    }
  });

  it('rejects the zero address', () => {
    // The contract reverts on it, and commission sent there is destroyed.
    expect(checkAddress(ZERO).problem).toBe('zero');
  });

  it('refuses a change that is not a change', () => {
    // A transaction that costs gas and alters nothing.
    expect(checkAddress(OWNER, OWNER).problem).toBe('unchanged');
  });

  it('spots an unchanged value through different casing', () => {
    expect(checkAddress(OWNER.toLowerCase(), OWNER).problem).toBe('unchanged');
    expect(checkAddress(OWNER.toUpperCase().replace('0X', '0x'), OWNER).problem).toBe('unchanged');
  });

  it('accepts a genuinely different address', () => {
    expect(checkAddress(OTHER, OWNER).address).toBe(OTHER);
  });
});

describe('addressProblemMessage', () => {
  it('says what to do, naming the field', () => {
    expect(addressProblemMessage('empty', 'treasury')).toMatch(/paste the new treasury/i);
  });

  it('explains why zero is worse than invalid', () => {
    // The distinction matters: one is a typo, the other destroys money.
    expect(addressProblemMessage('zero', 'treasury')).toMatch(/destroyed/i);
  });
});

describe('handoverState', () => {
  it('is settled when nothing is pending', () => {
    expect(handoverState(undefined, OWNER)).toEqual({ kind: 'settled' });
    // Ownable2Step leaves pendingOwner at the zero address when idle.
    expect(handoverState(ZERO, OWNER)).toEqual({ kind: 'settled' });
  });

  it('reports a nomination waiting on someone else', () => {
    expect(handoverState(OTHER, OWNER)).toEqual({
      kind: 'awaiting-acceptance',
      pending: OTHER,
    });
  });

  it('tells the nominee it is theirs to accept', () => {
    expect(handoverState(OTHER, OTHER.toLowerCase())).toEqual({
      kind: 'yours-to-accept',
      pending: OTHER,
    });
  });

  it('checksums the pending address whatever casing the chain returned', () => {
    expect(handoverState(OTHER.toLowerCase(), OWNER).kind).toBe('awaiting-acceptance');
    const state = handoverState(OTHER.toLowerCase(), OWNER);
    if (state.kind === 'settled') throw new Error('unreachable');
    expect(state.pending).toBe(OTHER);
  });

  it('does not mistake a nomination for a problem when nobody is connected', () => {
    expect(handoverState(OTHER, undefined).kind).toBe('awaiting-acceptance');
  });
});

describe('shorten', () => {
  it('keeps both ends, which are the parts people check', () => {
    expect(shorten(OWNER)).toBe('0x5571…a833');
  });
});
