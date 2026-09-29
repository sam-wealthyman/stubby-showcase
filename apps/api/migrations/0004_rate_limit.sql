-- Rate limiting, in Postgres rather than in memory.
--
-- In-memory counters are per process, so two API instances give an attacker
-- twice the allowance and a restart resets it to zero. A limit that can be
-- doubled by scaling out or cleared by a deploy is not a limit.
--
-- The window is a fixed bucket rather than a sliding log: one row per
-- (key, window) with a count, which is a single upsert and cannot grow without
-- bound. A sliding window would be fairer at the boundary and would mean storing
-- every request; for "stop someone mailing a stranger a thousand times" the
-- fixed bucket is the right trade.
CREATE TABLE IF NOT EXISTS rate_limit (
    -- What is being limited, e.g. `email-request:sam@example.com` or
    -- `email-request-ip:203.0.113.4`. Namespaced by the caller so two limits
    -- cannot collide.
    bucket      TEXT        NOT NULL,
    -- The start of the window this row counts. Part of the key, so an old window
    -- is a different row and expiry is a delete rather than an update.
    window_start TIMESTAMPTZ NOT NULL,
    count       INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, window_start)
);

-- Sweeping old windows is the only maintenance this needs.
CREATE INDEX IF NOT EXISTS rate_limit_window_idx ON rate_limit (window_start);
