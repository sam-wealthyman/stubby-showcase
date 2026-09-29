-- The transactions that started a draw, delivered its random number and paid
-- its prize, as the watcher reads them (migration 0006's mirror, extended).
--
-- The app used to find these by scanning the chain backwards from the
-- browser: up to 40 eth_getLogs per lookup against a public RPC that
-- rate-limits, so the proof often said "too old to look up" for a draw
-- settled seconds earlier. The watcher already reads every block once; now it
-- keeps these too, and the app asks the API.
CREATE TABLE IF NOT EXISTS chain_event (
    chain_id     BIGINT  NOT NULL,
    contract     TEXT    NOT NULL,      -- lower-case hex
    raffle_id    BIGINT  NOT NULL,
    kind         TEXT    NOT NULL,      -- DrawStarted | Drawn | PrizeClaimed
    tx_hash      TEXT    NOT NULL,
    block_number BIGINT  NOT NULL,
    log_index    INTEGER NOT NULL,
    PRIMARY KEY (chain_id, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS chain_event_raffle_idx ON chain_event (chain_id, contract, raffle_id);
