-- Referrals: who brought whom, and the bonus it earned.
--
-- The referrer earns 5% of the referred account's first purchase, once. The
-- raffle contract cannot pay this (it is deployed and non-upgradeable), so
-- the bonus is a ledger here, paid by the owner from the treasury and marked
-- paid with the transfer's hash.

-- One referrer per account, set when a new account arrives through a link.
CREATE TABLE IF NOT EXISTS referral (
    referred_account_id BIGINT      PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
    referrer_account_id BIGINT      NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (referred_account_id <> referrer_account_id)
);

CREATE INDEX IF NOT EXISTS referral_referrer_idx ON referral (referrer_account_id);

-- The one bonus a referral earns: 5% of the first purchase, in USDC base
-- units. Keyed by the referred account, so it can only ever be earned once.
CREATE TABLE IF NOT EXISTS referral_bonus (
    referred_account_id BIGINT      PRIMARY KEY REFERENCES referral (referred_account_id) ON DELETE CASCADE,
    referrer_account_id BIGINT      NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    chain_id            BIGINT      NOT NULL,
    contract            TEXT        NOT NULL,
    raffle_id           BIGINT      NOT NULL,
    wallet              TEXT        NOT NULL,   -- the referred wallet that bought
    tx_hash             TEXT        NOT NULL,   -- the purchase
    purchase            NUMERIC     NOT NULL,   -- what it paid
    bonus               NUMERIC     NOT NULL,   -- 5% of that, rounded down
    earned_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at             TIMESTAMPTZ,
    paid_tx             TEXT
);

CREATE INDEX IF NOT EXISTS referral_bonus_unpaid_idx ON referral_bonus (referrer_account_id) WHERE paid_at IS NULL;
