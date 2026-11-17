CREATE TABLE cloud_google_refresh_tokens (
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, token_hash)
);
