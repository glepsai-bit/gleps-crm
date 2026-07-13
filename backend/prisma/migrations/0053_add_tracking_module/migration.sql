-- TRACKING (Meta Ads / CTWA): módulo de inteligência de rastreamento.
-- 1) Origem da conversa: anúncio Click-to-WhatsApp (ctwa) vs orgânico.
--    ctwa_clid é o "código do clique" da Meta — chave da atribuição e do
--    envio de conversões via Conversions API (action_source=business_messaging).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS source_type   VARCHAR(20),
  ADD COLUMN IF NOT EXISTS ctwa_clid     TEXT,
  ADD COLUMN IF NOT EXISTS ad_source_id  VARCHAR(120),
  ADD COLUMN IF NOT EXISTS ad_source_url TEXT,
  ADD COLUMN IF NOT EXISTS ad_headline   TEXT;

CREATE INDEX IF NOT EXISTS "conversations_account_id_source_type_idx"
  ON conversations (account_id, source_type);

-- 2) Conexão Meta por conta (token + pixel/dataset + conta de anúncios)
CREATE TABLE IF NOT EXISTS tracking_configs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  access_token  TEXT,
  pixel_id      VARCHAR(64),
  ad_account_id VARCHAR(64),
  active        BOOLEAN NOT NULL DEFAULT FALSE,
  send_lead     BOOLEAN NOT NULL DEFAULT TRUE,
  send_schedule BOOLEAN NOT NULL DEFAULT TRUE,
  send_purchase BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3) Log dos eventos de conversão enviados (funil + auditoria/retry)
CREATE TABLE IF NOT EXISTS tracking_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID,
  contact_id      UUID,
  event_name      VARCHAR(40) NOT NULL,
  ctwa_clid       TEXT NOT NULL,
  value           DECIMAL(12,2),
  currency        VARCHAR(8),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  error           TEXT,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "tracking_events_account_id_created_at_idx"
  ON tracking_events (account_id, created_at);
CREATE INDEX IF NOT EXISTS "tracking_events_account_id_event_name_idx"
  ON tracking_events (account_id, event_name);
CREATE INDEX IF NOT EXISTS "tracking_events_conversation_id_idx"
  ON tracking_events (conversation_id);
