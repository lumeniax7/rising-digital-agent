-- File séparée pour les réponses retardées : les entrées restent bloquées jusqu'à l'approbation explicite du modèle.
CREATE TABLE IF NOT EXISTS wa_template_queue(
  source_wamid TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting_approval'
    CHECK(status IN ('waiting_approval','processing','sent','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  last_error TEXT,
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_template_queue_due ON wa_template_queue(status, created_at, claimed_at);

-- Conserve les échecs sans réponse dans une file isolée; aucun statut wa_inbox n’est modifié.
INSERT OR IGNORE INTO wa_template_queue(source_wamid,tenant_id,status,attempts,created_at)
SELECT wamid,tenant_id,'waiting_approval',0,created_at
FROM wa_inbox
WHERE status='failed' AND reply_external_id IS NULL;
