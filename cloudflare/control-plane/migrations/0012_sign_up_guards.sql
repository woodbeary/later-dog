ALTER TABLE cloud_homes ADD COLUMN used_at INTEGER;

ALTER TABLE cloud_homes ADD COLUMN released_at INTEGER;

UPDATE cloud_homes SET used_at = created_at WHERE used_at IS NULL;

CREATE INDEX cloud_homes_unused_idx ON cloud_homes (created_at) WHERE used_at IS NULL AND released_at IS NULL;

CREATE TABLE otp_new_email_days (
  day INTEGER PRIMARY KEY,
  sent INTEGER NOT NULL CHECK (sent >= 0),
  unverified INTEGER NOT NULL CHECK (unverified >= 0)
);
