-- Sign in with X (Section 4.1), over OAuth 2.0 with PKCE.
--
-- A pending X sign-in, between sending the browser to X and X sending it back.
-- The same shape as the magic link and the SIWE nonce: a single-use credential
-- keyed by its hash, spent by one DELETE .. RETURNING.
--
-- The verifier is stored as it is, because the token exchange needs it verbatim.
-- On its own it is worthless: it only turns into a sign-in together with the
-- code X hands the browser, and it lives for ten minutes.
CREATE TABLE IF NOT EXISTS x_login (
    state_hash TEXT        PRIMARY KEY,
    verifier   TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS x_login_expires_at_idx ON x_login (expires_at);

-- One X account, one Stubby account.
--
-- Keyed by X's numeric user id, never the handle: a handle can be changed or
-- given up and then taken by somebody else, and whoever took it must not
-- inherit this login. The handle is kept only to show who is signed in.
CREATE TABLE IF NOT EXISTS account_x (
    x_user_id  TEXT        PRIMARY KEY,
    username   TEXT        NOT NULL,
    account_id BIGINT      NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_x_account_idx ON account_x (account_id);
