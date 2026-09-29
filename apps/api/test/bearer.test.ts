import { describe, expect, it } from 'vitest';

import { sessionTokenFrom, tokenFromAuthorization } from '../src/auth/bearer.js';

const TOKEN = '2DtuQ8LikrNIxcIqwADrSfu7XSKw5Qj8EORLVJ4qb78';

describe('tokenFromAuthorization', () => {
  it('reads a bearer token', () => {
    expect(tokenFromAuthorization(`Bearer ${TOKEN}`)).toBe(TOKEN);
  });

  /**
   * RFC 7235 makes the scheme case-insensitive, and clients vary.
   *
   * Matching it case-sensitively fails by rejecting a valid session, which is
   * harder to notice than accepting an invalid one — it looks like the user was
   * signed out.
   */
  it('accepts any casing of the scheme', () => {
    for (const scheme of ['Bearer', 'bearer', 'BEARER', 'BeArEr']) {
      expect(tokenFromAuthorization(`${scheme} ${TOKEN}`), scheme).toBe(TOKEN);
    }
  });

  it('tolerates extra whitespace', () => {
    expect(tokenFromAuthorization(`  Bearer   ${TOKEN}  `)).toBe(TOKEN);
  });

  it('ignores another scheme', () => {
    expect(tokenFromAuthorization(`Basic ${TOKEN}`)).toBeUndefined();
    expect(tokenFromAuthorization(TOKEN)).toBeUndefined();
  });

  it('ignores an empty or missing header', () => {
    expect(tokenFromAuthorization(undefined)).toBeUndefined();
    expect(tokenFromAuthorization('')).toBeUndefined();
    expect(tokenFromAuthorization('Bearer')).toBeUndefined();
    expect(tokenFromAuthorization('Bearer   ')).toBeUndefined();
  });
});

describe('sessionTokenFrom', () => {
  it('uses the cookie when that is all there is', () => {
    expect(sessionTokenFrom({ cookie: TOKEN })).toBe(TOKEN);
  });

  it('uses the header when that is all there is', () => {
    expect(sessionTokenFrom({ authorization: `Bearer ${TOKEN}` })).toBe(TOKEN);
  });

  /**
   * A caller that sent `Authorization` meant it.
   *
   * Preferring the cookie would make a native client's explicit choice depend
   * on whatever a browser once stored for the same origin.
   */
  it('prefers the explicit header when both are present', () => {
    expect(sessionTokenFrom({ authorization: `Bearer ${TOKEN}`, cookie: 'stale' })).toBe(TOKEN);
  });

  it('falls back to the cookie when the header is not a bearer', () => {
    expect(sessionTokenFrom({ authorization: 'Basic xyz', cookie: TOKEN })).toBe(TOKEN);
  });

  it('is undefined when there is nothing', () => {
    expect(sessionTokenFrom({})).toBeUndefined();
  });
});
