-- Sign in with X from the Android app. The OAuth callback lands in the browser,
-- which the app cannot read a cookie from, so the callback hands the app a
-- one-time code instead (through the /login App Link), and the app spends it
-- for a session of its own.
--
-- Only the code's hash is stored, it lives five minutes, and spending it is one
-- DELETE .. RETURNING: the same shape as the magic link.
CREATE TABLE IF NOT EXISTS x_app_handoff (
    code_hash  TEXT        PRIMARY KEY,
    account_id BIGINT      NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS x_app_handoff_expires_at_idx ON x_app_handoff (expires_at);
