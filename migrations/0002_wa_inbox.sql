-- Inbox durable WhatsApp : seuls les messages entrants sont stockés ici.
CREATE TABLE IF NOT EXISTS wa_inbox(
  wamid TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  claimed_at TEXT,
  reply_external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_inbox_due ON wa_inbox(status, next_attempt_at, claimed_at);
