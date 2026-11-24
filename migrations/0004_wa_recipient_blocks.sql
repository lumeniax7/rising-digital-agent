CREATE TABLE IF NOT EXISTS wa_recipient_blocks (
  phone_normalized TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'owner_request',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_recipient_blocks_created ON wa_recipient_blocks(created_at);
