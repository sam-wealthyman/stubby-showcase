-- What the watcher needs to remember between ticks (Section 10's event
-- listeners and mirror, Section 13.6's alerts).
--
-- The chain stays the source of truth. These tables are a copy for the
-- questions the chain answers badly -- "who entered raffle 7?" is a log scan,
-- "which of them has an email?" is not on the chain at all -- and a record of
-- what has already been said, so nobody is told twice.
--
-- Every row is keyed by chain id and contract as well as raffle id. The
-- mainnet and testnet contracts share an address (brief, 13.5), so an address
-- alone would let a testnet draw be mistaken for a mainnet one.

-- How far through the chain's logs a reader has got.
CREATE TABLE IF NOT EXISTS chain_cursor (
    name       TEXT        PRIMARY KEY,
    block      BIGINT      NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each raffle as last read. Amounts are NUMERIC because they are uint256 base
-- units and must never pass through a float.
CREATE TABLE IF NOT EXISTS chain_raffle (
    chain_id        BIGINT      NOT NULL,
    contract        TEXT        NOT NULL,   -- lower-case hex
    raffle_id       BIGINT      NOT NULL,
    status          TEXT        NOT NULL,
    prize           NUMERIC     NOT NULL,
    entry_price     NUMERIC     NOT NULL,
    total_entries   INTEGER     NOT NULL,
    entries_sold    INTEGER     NOT NULL,
    window_ends     TIMESTAMPTZ NOT NULL,
    requested_at    TIMESTAMPTZ,
    winner          TEXT,                   -- lower-case hex
    prize_owed      NUMERIC     NOT NULL,
    commission_owed NUMERIC     NOT NULL,
    prize_paid      BOOLEAN     NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract, raffle_id)
);

-- One row per Entered event. The log's position is its identity, so reading
-- the same range twice (a restart mid-chunk) adds nothing.
CREATE TABLE IF NOT EXISTS chain_entry (
    chain_id     BIGINT  NOT NULL,
    contract     TEXT    NOT NULL,
    raffle_id    BIGINT  NOT NULL,
    wallet       TEXT    NOT NULL,          -- lower-case hex
    count        INTEGER NOT NULL,
    paid         NUMERIC NOT NULL,
    block_number BIGINT  NOT NULL,
    tx_hash      TEXT    NOT NULL,
    log_index    INTEGER NOT NULL,
    PRIMARY KEY (chain_id, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS chain_entry_raffle_idx ON chain_entry (chain_id, contract, raffle_id);

-- A notice sent to an account about a raffle. Claimed by INSERT before the
-- mail goes, and deleted again if sending fails, so two watchers cannot both
-- send it and a failure is retried on the next tick.
CREATE TABLE IF NOT EXISTS notice_sent (
    kind       TEXT        NOT NULL,
    chain_id   BIGINT      NOT NULL,
    contract   TEXT        NOT NULL,
    raffle_id  BIGINT      NOT NULL,
    account_id BIGINT      NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, chain_id, contract, raffle_id, account_id)
);

-- An owner alert that is currently true. `first_seen` is for alerts with a
-- grace period; `last_sent` spaces repeats. The row is deleted when the
-- condition clears, so the next occurrence alerts afresh.
CREATE TABLE IF NOT EXISTS owner_alert (
    key        TEXT        PRIMARY KEY,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_sent  TIMESTAMPTZ
);
