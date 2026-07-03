-- Migration: 0045_add_message_delete_reactions_mentions
-- ADITIVA — sem drops, sem alters destrutivos. Segura pra prod.
--
-- Cobre 3 features do pacote Reply/Edit/Delete/Reactions/Mic/Mentions:
--   * DELETE MSG (soft-delete): messages.deleted_at
--   * REACTIONS: nova tabela message_reactions
--   * MENTIONS HISTORY: tabela mentions JA EXISTE (migration 0032+),
--     nada a criar aqui — apenas consumir via GET /api/mentions.

-- ============================================================
-- 1) Soft-delete de Message (feature: Delete Msg outbound)
-- ============================================================
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "messages_deleted_at_idx"
  ON "messages" ("deleted_at");

-- ============================================================
-- 2) MessageReaction (feature: Reactions)
--    user_id NULLABLE pra suportar reactions vindas do cliente
--    (via webhook Evolution). external_contact_id guarda o
--    remoteJid nesse caso.
-- ============================================================
CREATE TABLE IF NOT EXISTS "message_reactions" (
  "id"                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "message_id"          UUID        NOT NULL,
  "user_id"             UUID,
  "external_contact_id" VARCHAR(120),
  "emoji"               VARCHAR(20) NOT NULL,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "message_reactions_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "messages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "message_reactions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "message_reactions_message_id_idx"
  ON "message_reactions" ("message_id");

CREATE INDEX IF NOT EXISTS "message_reactions_user_id_idx"
  ON "message_reactions" ("user_id");

-- Match do @@unique([messageId, userId, emoji]) do schema Prisma.
-- Postgres permite múltiplos NULLs num UNIQUE comum, então reactions
-- de cliente (user_id NULL) não colidem entre si por este índice.
CREATE UNIQUE INDEX IF NOT EXISTS "message_reactions_message_id_user_id_emoji_key"
  ON "message_reactions" ("message_id", "user_id", "emoji");

-- Unicidade extra pra reactions do cliente (sem user_id):
-- 1 emoji por (msg, external_contact_id) — evita duplicata de webhook.
--
-- NOTA DE DRIFT (INTENCIONAL):
-- Este índice é um UNIQUE PARCIAL (com cláusula WHERE) e NÃO está declarado
-- em backend/prisma/schema.prisma. Motivo: o Prisma (versão atual do projeto)
-- não suporta partial indexes no schema.prisma sem habilitar previewFeatures
-- experimentais (`extendedIndexes` / equivalente), e não queremos ligar preview
-- só por isso. A regra vive apenas no SQL desta migration.
--
-- Consequência prática:
--   * `prisma migrate diff` / `prisma db pull` pode reportar este índice como
--     "extra" no banco — é esperado, NÃO recriar via `prisma migrate reset`
--     nem "corrigir" removendo daqui.
--   * A unicidade "1 emoji do mesmo contato externo por mensagem" é garantida
--     em runtime SOMENTE por este índice (o @@unique([messageId, userId, emoji])
--     do schema permite múltiplos NULLs em user_id no Postgres, então reactions
--     de cliente colidiriam sem esta linha).
--   * Se um dia migrarmos pra Prisma com partial index nativo, mover pra schema
--     e remover este comentário.
CREATE UNIQUE INDEX IF NOT EXISTS "message_reactions_message_external_emoji_customer_unique"
  ON "message_reactions" ("message_id", "external_contact_id", "emoji")
  WHERE "user_id" IS NULL AND "external_contact_id" IS NOT NULL;

-- ============================================================
-- 3) Mentions: modelo já existe em migrations anteriores.
--    Colunas: id, conversation_id, user_id, message_id, read, created_at.
--    Índices: (user_id, read), (conversation_id).
--    Nada a fazer aqui.
-- ============================================================
