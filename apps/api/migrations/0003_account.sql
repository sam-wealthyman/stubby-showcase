-- Accounts, so a login is not the same thing as a wallet (Section 4).
--
-- Until now a session WAS a wallet: the table held an address and a chain id and
-- nothing else. That works for SIWE and cannot express the other two login
-- methods Section 4.1 promises, because an email login has no address.
--
-- Section 4.3 is the reason the split matters rather than being tidy: losing
-- access to a login must never lose funds. Entries and prizes belong to the
-- wallet and the chain is the source of truth (4.2), so everything in here is
-- recoverable by signing a message. Nothing below holds money or can move it.

CREATE TABLE IF NOT EXISTS account (
    id         BIGSERIAL   PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One email, one account. Section 4.1: a handle, never verified against
-- identity, so there is nothing here but the address and when it was first used.
CREATE TABLE IF NOT EXISTS account_email (
    -- Normalised by `normaliseEmail` in @stubby/shared before it reaches here.
    -- Both sides must agree, or a user creates an account they cannot return to.
    email      TEXT        PRIMARY KEY,
    account_id BIGINT      NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_email_account_idx ON account_email (account_id);

-- Section 4.2: a user may link more than one wallet, and entries belong to the
-- wallet rather than the account. The primary key is the wallet, not the pair
-- with the account, so one address cannot be claimed by two logins.
CREATE TABLE IF NOT EXISTS wallet_link (
    address    TEXT        NOT NULL,   -- lower-case hex
    chain_id   BIGINT      NOT NULL,
    account_id BIGINT      NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (address, chain_id)
);

CREATE INDEX IF NOT EXISTS wallet_link_account_idx ON wallet_link (account_id);

-- A magic link, and the same shape as the SIWE nonce for the same reasons.
--
-- Only the HASH is stored: the token in a link is a bearer credential, and a
-- dump of this table would otherwise be a dump of every pending sign-in.
-- Single use is enforced by one DELETE .. RETURNING, which is atomic in a way
-- read-then-delete is not.
CREATE TABLE IF NOT EXISTS email_login (
    token_hash TEXT        PRIMARY KEY,
    email      TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_login_expires_at_idx ON email_login (expires_at);
-- Rate limiting per address will want this, and so does invalidating older
-- links when a new one is requested.
CREATE INDEX IF NOT EXISTS email_login_email_idx ON email_login (email);

-- Sessions now belong to an account.
--
-- `address` and `chain_id` become NULLABLE and change meaning: they record the
-- wallet this particular session signed in WITH, which an email session does
-- not have. They are no longer the identity — `account_id` is.
ALTER TABLE session ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES account (id) ON DELETE CASCADE;

-- Existing sessions are wallet sessions. Give each address an account and link
-- it, so nobody is signed out by this migration.
DO $$
DECLARE
    row RECORD;
    new_account BIGINT;
BEGIN
    FOR row IN SELECT DISTINCT address, chain_id FROM session WHERE account_id IS NULL LOOP
        SELECT account_id INTO new_account FROM wallet_link
            WHERE address = row.address AND chain_id = row.chain_id;
        IF new_account IS NULL THEN
            INSERT INTO account DEFAULT VALUES RETURNING id INTO new_account;
            INSERT INTO wallet_link (address, chain_id, account_id)
                VALUES (row.address, row.chain_id, new_account);
        END IF;
        UPDATE session SET account_id = new_account
            WHERE address = row.address AND chain_id = row.chain_id AND account_id IS NULL;
    END LOOP;
END $$;

ALTER TABLE session ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE session ALTER COLUMN address  DROP NOT NULL;
ALTER TABLE session ALTER COLUMN chain_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS session_account_idx ON session (account_id);
