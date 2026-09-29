import { afterEach, describe, expect, it } from 'vitest';

import { tlsConfig } from '../src/db/pool.js';

const SUPABASE = 'postgresql://u:p@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';
const LOCAL = 'postgresql://postgres:postgres@localhost:5432/stubby_test?sslmode=disable';

describe('tlsConfig', () => {
  const originalCa = process.env.DATABASE_CA_CERT;
  afterEach(() => {
    if (originalCa === undefined) delete process.env.DATABASE_CA_CERT;
    else process.env.DATABASE_CA_CERT = originalCa;
  });

  it('turns TLS off when the connection string disables it', () => {
    // pg lets an explicit ssl option override the connection string, so
    // forcing TLS here would refuse a plain local Postgres with an error that
    // mentions neither TLS nor this function.
    expect(tlsConfig(LOCAL)).toBe(false);
  });

  it('still disables TLS when a CA happens to be configured', () => {
    process.env.DATABASE_CA_CERT = '/nonexistent/ca.crt';
    // The server cannot speak TLS at all; a CA does not change that. Reading
    // the file here would also throw on a path that need not exist.
    expect(tlsConfig(LOCAL)).toBe(false);
  });

  it('encrypts without verifying when no CA is configured', () => {
    delete process.env.DATABASE_CA_CERT;
    // Encrypted but unauthenticated: fine on a laptop, not in production.
    expect(tlsConfig(SUPABASE)).toEqual({ rejectUnauthorized: false });
  });

  it('does not mistake another parameter for sslmode', () => {
    expect(tlsConfig(`${SUPABASE}?application_name=notsslmode=disable`)).not.toBe(false);
  });
});
