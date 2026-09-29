-- A public username an account may choose (optional), shown in place of its
-- wallets' addresses in the live activity feed.
--
-- Unique regardless of case: "Jack" and "jack" side by side in a feed would be
-- two people who look like one. The rule for what a name may contain is
-- checkUsername in @stubby/shared; the database only guarantees uniqueness.
ALTER TABLE account ADD COLUMN IF NOT EXISTS username TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS account_username_lower_idx ON account (lower(username));
