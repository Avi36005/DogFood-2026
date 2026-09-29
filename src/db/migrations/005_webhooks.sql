-- Webhooks (T4). Deliveries are an outbox: a row is written in the same transaction as the
-- audit entry it reports, so a change that rolls back never fires, and a crash never loses one.

CREATE TABLE webhooks (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  url         TEXT NOT NULL CHECK ((url LIKE 'http://%' OR url LIKE 'https://%') AND length(url) <= 500),
  secret      TEXT NOT NULL,
  events      TEXT NOT NULL CHECK (json_valid(events) AND json_type(events) = 'array'),
  created_by  TEXT REFERENCES users (id),
  created_at  TEXT NOT NULL,
  removed_at  TEXT
);
CREATE INDEX webhooks_event ON webhooks (event_id) WHERE removed_at IS NULL;

CREATE TABLE webhook_deliveries (
  id              TEXT PRIMARY KEY,
  webhook_id      TEXT NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  audit_id        INTEGER REFERENCES audit_log (id),
  payload         TEXT NOT NULL CHECK (json_valid(payload)),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  last_status     INTEGER,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  delivered_at    TEXT,
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at);
