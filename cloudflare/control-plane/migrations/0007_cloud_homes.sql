CREATE TABLE cloud_device_authorizations (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('darwin', 'win32', 'linux')),
  app_version TEXT,
  source_hash TEXT NOT NULL,
  account_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'redeemed')),
  interval_seconds INTEGER NOT NULL,
  last_polled_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX cloud_device_authorizations_source ON cloud_device_authorizations (source_hash, created_at);
CREATE INDEX cloud_device_authorizations_expiry ON cloud_device_authorizations (expires_at);

CREATE TABLE cloud_devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX cloud_devices_account ON cloud_devices (account_id);

CREATE TABLE cloud_homes (
  account_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
