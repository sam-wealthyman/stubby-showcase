-- Sessions for the app account (Section 4).
--
-- The login is the app account; the wallet is where money moves. A session
-- therefore proves who is signed in, never what they may spend: entries and
-- prizes belong to the wallet and the chain is the source of truth (4.2), so
-- losing this table costs logins and nothing else.
--
-- `token_hash`, not `token`. A session token is a bearer credential, so a dump
-- of this table would otherwise be a dump of every live login. Storing only the
-- hash means a reader of the table cannot sign in as anybody.
CREATE TABLE IF NOT EXISTS session (
    token_hash TEXT        PRIMARY KEY,
    -- Lower-case hex. One wallet may have several sessions, e.g. web and phone.
    address    TEXT        NOT NULL,
    chain_id   BIGINT      NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    -- Touched on use, so an idle session can be expired separately later.
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_address_idx    ON session (address);
CREATE INDEX IF NOT EXISTS session_expires_at_idx ON session (expires_at);
