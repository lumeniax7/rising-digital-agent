-- Migration 0004 : état de conversation persistant (Phase 1).
-- Stocke le topic actif, les besoins en file d'attente, les préférences,
-- et le contexte conversationnel pour permettre un conseiller numérique mémoriel.

CREATE TABLE IF NOT EXISTS conversation_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  active_topic TEXT,                       -- clé du sujet actif (ex: "site_web", "formation")
  active_service TEXT,                     -- titre du service actif (ex: "Création de site et application")
  needs_queue JSON NOT NULL DEFAULT '[]',  -- besoins exprimés dans l'ordre chronologique
  preferences JSON NOT NULL DEFAULT '{}',  -- budget, délai, style ; { "budget_max_fcfa": null, "delai_semaines": null, "style": "concis" }
  last_intent TEXT,                        -- dernier intent détecté
  last_ai_provider TEXT,                   -- dernier provider IA utilisé
  turn_count INTEGER NOT NULL DEFAULT 0,   -- compteur d'échanges dans cette conversation
  last_interaction_at TEXT NOT NULL DEFAULT (datetime('now')),
  summary TEXT,                            -- résumé gratuit optionnel du fil de discussion
  UNIQUE(tenant_id, conversation_id)
);

-- Index pour accès rapide par conversation
CREATE INDEX IF NOT EXISTS idx_conversation_state_conv ON conversation_state(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_state_topic ON conversation_state(active_topic);