-- Single-use nonces for Sign-In with Ethereum (brief Section 4.1).
--
-- A nonce is only worth having if it can be used exactly once, which needs
-- state the server controls. This is that state.
--
-- Deliberately plain SQL against plain Postgres: no Supabase extensions, no Row
-- Level Security. ADR 0007 keeps the database portable so moving to a VPS is a
-- pg_dump, a restore and one environment variable, and RLS would tie
-- authorisation to Supabase's own auth.

CREATE TABLE IF NOT EXISTS siwe_nonce (
    nonce      TEXT        PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL,
    issued_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sweeping deletes by expiry, so that is what needs the index. Lookups by
-- nonce already use the primary key.
CREATE INDEX IF NOT EXISTS siwe_nonce_expires_at_idx ON siwe_nonce (expires_at);

COMMENT ON TABLE siwe_nonce IS
    'Issued SIWE nonces. Rows are deleted on use: presence means unspent.';
