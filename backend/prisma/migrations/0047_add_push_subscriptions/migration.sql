-- Migration: 0047_add_push_subscriptions
-- ADITIVA — cria a tabela push_subscriptions e um indice unico em endpoint.
-- Sem drops, sem alter em tabelas existentes. Idempotente via IF NOT EXISTS.
--
-- Cobre a feature Web Push Notifications:
--   * Registrar subscription do browser (VAPID) para notificar agente quando
--     mensagem inbound chega numa conversa atribuida a ele.
--   * Unico por endpoint (endpoint eh unico globalmente per Push API do browser).
--   * userId indexado para busca rapida no fire-and-forget do message.service.
-- ============================================================
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id"               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          UUID        NOT NULL,
  "endpoint"         TEXT        NOT NULL,
  "keys"             JSONB       NOT NULL,
  "user_agent"       TEXT,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "last_notified_at" TIMESTAMPTZ,
  CONSTRAINT "push_subscriptions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_key"
  ON "push_subscriptions" ("endpoint");

CREATE INDEX IF NOT EXISTS "push_subscriptions_user_id_idx"
  ON "push_subscriptions" ("user_id");
