-- =====================================================================
-- PERF-AUDIT Round 1 — indices compostos para os hot paths do chat.
-- =====================================================================
-- Todos os CREATE INDEX usam IF NOT EXISTS para serem idempotentes
-- (permite rodar em ambientes onde indices avulsos ja foram criados
-- manualmente antes desta migration).
--
-- Nao usamos CONCURRENTLY porque migrations do Prisma rodam dentro de
-- uma transacao — CONCURRENTLY nao pode. Em bases maiores, criar
-- manualmente via psql fora da migration com CONCURRENTLY e depois
-- marcar a migration como aplicada (prisma migrate resolve --applied)
-- e uma opcao. Como as tabelas hoje sao pequenas/moderadas, criar
-- inline atende sem downtime perceptivel.

-- ---------------------------------------------------------------------
-- Conversation: lista da inbox por accountId + updatedAt DESC (hot path).
-- Cobre tambem o @@index([accountId]) avulso via prefix da chave.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "conversations_account_updated_desc_idx"
  ON "conversations" ("account_id", "updated_at" DESC);

-- ---------------------------------------------------------------------
-- Conversation: lista filtrada por status (open/pending/etc) + sort.
-- Substitui o @@index([status]) avulso (baixa cardinalidade, quase
-- inutil sem accountId como prefixo).
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "conversations_account_status_updated_desc_idx"
  ON "conversations" ("account_id", "status", "updated_at" DESC);

-- ---------------------------------------------------------------------
-- Conversation: dashboard chat-metrics filtra por accountId + resolvedAt
-- range. Sem indice o Postgres faz seq scan da conta inteira.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "conversations_account_resolved_idx"
  ON "conversations" ("account_id", "resolved_at");

-- ---------------------------------------------------------------------
-- Message: paginacao da thread por conversationId + createdAt DESC.
-- Endpoint MAIS quente do produto. Sem esse composto o filtro casava
-- @@index([conversationId]) e o sort era in-memory.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "messages_conversation_created_desc_idx"
  ON "messages" ("conversation_id", "created_at" DESC);

-- ---------------------------------------------------------------------
-- Cleanup: os indices avulsos abaixo foram substituidos por compostos
-- que os cobrem como prefixo (Postgres usa o composto para queries que
-- filtram so pela primeira coluna). DROP IF EXISTS e no-op quando o
-- indice ja foi removido em rebuild anterior.
-- ---------------------------------------------------------------------
DROP INDEX IF EXISTS "conversations_account_id_idx";
DROP INDEX IF EXISTS "conversations_status_idx";
DROP INDEX IF EXISTS "messages_conversation_id_idx";
DROP INDEX IF EXISTS "messages_created_at_idx";
