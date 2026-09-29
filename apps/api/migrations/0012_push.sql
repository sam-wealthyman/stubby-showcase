-- Push notifications (Android, through Firebase Cloud Messaging).
--
-- A device's FCM token belongs to whichever account last registered it: a
-- phone signed into a second account moves over, rather than telling both.
-- Tokens the FCM API reports as gone are deleted when a send finds out.
CREATE TABLE IF NOT EXISTS push_device (
    token      TEXT        PRIMARY KEY,
    account_id BIGINT      NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    platform   TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_device_account_idx ON push_device (account_id);

-- Off switch, separate from mail's: someone may want one and not the other.
ALTER TABLE account ADD COLUMN IF NOT EXISTS push_opt_out_at TIMESTAMPTZ;
