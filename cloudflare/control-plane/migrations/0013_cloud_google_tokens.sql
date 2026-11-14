CREATE TABLE cloud_google_tokens (
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  PRIMARY KEY (account_id, day)
);
