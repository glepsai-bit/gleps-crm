-- BUG A (T-022): áudio/mídia da Evolution não tocava no browser porque o frontend
-- recebia URL interna da Evolution (precisa header apikey + CORS bloqueia). Solução:
-- backend baixa a mídia no recebimento do webhook, grava em disco local
-- (uploads/<accountId>/<attachmentId>.<ext>) e o frontend consome via endpoint
-- proxy autenticado GET /api/attachments/:id.
--
-- Para attachments legados (criados antes desse fix), storage_path é NULL e o
-- endpoint cai pra fallback: baixa on-demand da Evolution + grava em disco.

ALTER TABLE "attachments"
  ADD COLUMN "storage_path"   VARCHAR(500),
  ADD COLUMN "storage_status" VARCHAR(20) DEFAULT 'pending',
  ADD COLUMN "source_url"     VARCHAR(2000);

-- Backfill: pra rows existentes, copia fileUrl pra source_url (URL original Evolution)
-- e mantém storage_status pending — primeira leitura GET /api/attachments/:id
-- vai tentar baixar e materializar localmente.
UPDATE "attachments"
SET "source_url" = "file_url"
WHERE "source_url" IS NULL;

CREATE INDEX "idx_attachments_storage_status" ON "attachments"("storage_status");
