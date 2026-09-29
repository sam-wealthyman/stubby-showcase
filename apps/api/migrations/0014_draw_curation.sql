-- The owner's say over how draws are shown: which one leads the home page,
-- and the order of the rest. Display only: the contract knows nothing of it,
-- and nothing here can change what a draw is or who wins it.
--
-- One row per draw that has a position. Draws without a row follow in the
-- app's own order. At most one draw per contract is featured.

CREATE TABLE IF NOT EXISTS draw_curation (
    chain_id   BIGINT      NOT NULL,
    contract   TEXT        NOT NULL,
    raffle_id  BIGINT      NOT NULL,
    position   INTEGER     NOT NULL,
    featured   BOOLEAN     NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract, raffle_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS draw_curation_one_featured
    ON draw_curation (chain_id, contract) WHERE featured;
