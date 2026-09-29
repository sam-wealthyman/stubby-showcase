-- Result and referral mail can be turned off, per account (login links and
-- owner alerts cannot: one is asked for, the other is the owner's own).
--
-- `mail_token` is the key in each mail's unsubscribe link: random, one per
-- account, made the first time a mail needs it. It turns mail off and nothing
-- else, so a forwarded mail can do no more than that.
ALTER TABLE account ADD COLUMN IF NOT EXISTS mail_opt_out_at TIMESTAMPTZ;
ALTER TABLE account ADD COLUMN IF NOT EXISTS mail_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS account_mail_token_idx ON account (mail_token);
