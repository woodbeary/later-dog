CREATE TABLE otp_recipient_rate_limits (
  recipient_key TEXT PRIMARY KEY CHECK (length(recipient_key) = 64),
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  updated_at INTEGER NOT NULL
);

CREATE INDEX otp_recipient_rate_limits_updated_idx
  ON otp_recipient_rate_limits(updated_at);

CREATE TABLE control_action_rate_limits (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, action)
);
