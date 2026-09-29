-- A referral bonus is earned once per chain, not once ever.
--
-- The site moved from testnet to mainnet with one database. Keyed by the
-- referred account alone, a testnet purchase used up the bonus, so the real
-- first purchase on mainnet earned the referrer nothing, and the owner's list
-- of what is owed mixed play money with real USDC. Every query now reads one
-- chain, the one the server runs on.

ALTER TABLE referral_bonus DROP CONSTRAINT referral_bonus_pkey;
ALTER TABLE referral_bonus ADD PRIMARY KEY (referred_account_id, chain_id);
