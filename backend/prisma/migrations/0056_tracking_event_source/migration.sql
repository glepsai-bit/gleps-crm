-- TRACKING — origem do evento, para reconciliação idempotente.
--
-- Sem saber QUAL fato do CRM gerou cada evento, não é possível descobrir o
-- que ficou pra trás sem risco de reenviar (e contar em dobro na Meta).
-- source_type/source_id amarram o evento à conversa, à reunião ou à venda.
ALTER TABLE tracking_events
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(24),
  ADD COLUMN IF NOT EXISTS source_id   UUID;

-- Backfill do que dá para inferir com certeza: Lead é 1:1 com a conversa.
-- DISTINCT ON garante UMA linha por (conta, conversa) — se o histórico tiver
-- Leads duplicados, só o mais antigo recebe a origem e o índice único abaixo
-- não quebra. Reunião e venda não são inferíveis (várias por conversa):
-- ficam NULL e a reconciliação trata essas linhas com guarda conservadora.
UPDATE tracking_events te
   SET source_type = 'conversation',
       source_id   = te.conversation_id
  FROM (
    SELECT DISTINCT ON (account_id, conversation_id) id
      FROM tracking_events
     WHERE event_name = 'Lead'
       AND source_id IS NULL
       AND conversation_id IS NOT NULL
     ORDER BY account_id, conversation_id, created_at ASC
  ) primeiros
 WHERE te.id = primeiros.id
   -- Guarda contra colisão com linha que JÁ tem essa origem (caso o backfill
   -- rode duas vezes, ou o boot rode depois da migration). Sem isso o UPDATE
   -- violaria o índice único e derrubaria a migration.
   AND NOT EXISTS (
     SELECT 1 FROM tracking_events x
      WHERE x.account_id = te.account_id
        AND x.event_name = te.event_name
        AND x.source_id  = te.conversation_id
   );

-- Rede de segurança no banco: um evento por (conta, tipo, origem).
-- NULLs são distintos no Postgres, então as linhas legadas (source_id NULL)
-- não conflitam entre si nem bloqueiam a migration.
CREATE UNIQUE INDEX IF NOT EXISTS "tracking_events_account_event_source_key"
  ON tracking_events (account_id, event_name, source_id);

CREATE INDEX IF NOT EXISTS "tracking_events_status_idx"
  ON tracking_events (status);
