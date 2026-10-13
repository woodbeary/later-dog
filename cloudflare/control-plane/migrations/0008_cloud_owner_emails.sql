CREATE TABLE cloud_owner_emails (
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  sent INTEGER NOT NULL,
  PRIMARY KEY (account_id, day)
);
