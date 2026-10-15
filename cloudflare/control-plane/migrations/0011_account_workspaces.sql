CREATE TABLE account_workspaces (
  account_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL UNIQUE REFERENCES installations(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES cloud_devices(id) ON DELETE CASCADE,
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE workspace_pairings (
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  credential TEXT,
  credential_expires_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, request_id)
);

CREATE INDEX workspace_pairings_expiry ON workspace_pairings(expires_at);
