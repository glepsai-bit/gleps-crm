-- SE-H1: dedupe de conversa por (account_id, inbox_id, external_id) com índice
-- ÚNICO PARCIAL, ativo apenas quando external_id IS NOT NULL. Mantém compatibilidade
-- com conversas criadas manualmente sem remoteJid (Postgres trataria múltiplos NULL
-- como distintos num UNIQUE comum, mas o parcial deixa o contrato explícito).
-- Usado pelo findOrCreateForCustomer no fluxo de webhook Evolution (retry agressivo
-- causava conversations duplicadas em P95 antes desse índice).

CREATE UNIQUE INDEX IF NOT EXISTS "conversations_account_inbox_external_unique"
  ON "conversations"("account_id", "inbox_id", "external_id")
  WHERE "external_id" IS NOT NULL;
