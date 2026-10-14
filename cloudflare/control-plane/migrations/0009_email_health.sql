CREATE TABLE email_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  blocked_until INTEGER NOT NULL,
  reason TEXT NOT NULL
);
