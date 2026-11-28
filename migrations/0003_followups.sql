-- Migration 0003 : relances conversationnelles (moteur de conversation v4.1).
-- Une relance = un rappel programmé pour reprendre une discussion après une pause,
-- dans le respect de la fenêtre de 24 h de WhatsApp Cloud API.
CREATE TABLE IF NOT EXISTS followups(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  angle TEXT,                       -- service ou sujet abordé (contexte de la relance)
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','sent','cancelled','template_required','failed')),
  due_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(status, due_at);
