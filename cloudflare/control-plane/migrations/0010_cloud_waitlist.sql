CREATE TABLE cloud_waitlist (
  account_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  invited_at INTEGER
);

CREATE INDEX cloud_waitlist_waiting_idx ON cloud_waitlist(invited_at, created_at);
