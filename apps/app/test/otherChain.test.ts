import { describe, expect, it } from 'vitest';

import { otherChain } from '@/wallet/otherChain';

describe('otherChain', () => {
  it('names the chains people arrive from, with their gas token', () => {
    expect(otherChain(1)).toEqual({ name: 'Ethereum', note: 'Gas in ETH' });
    expect(otherChain(137)).toEqual({ name: 'Polygon', note: 'Gas in POL' });
  });

  it('does not guess at one it does not know', () => {
    expect(otherChain(999_999)).toEqual({ name: 'Another network', note: 'Chain 999999' });
    expect(otherChain(undefined).name).toBe('Another network');
  });
});
