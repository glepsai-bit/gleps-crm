-- AlterTable: WarmupTemplate ganha suporte a midia (audio | sticker | image)
-- V2: para type in (audio, sticker, image), media_path OR media_url precisa
-- estar preenchido. Validacao runtime no whatsapp-warmup.service garante
-- coerencia tipo<->mime. Para type='text' continua usando apenas `content`.
ALTER TABLE "warmup_templates"
  ADD COLUMN "media_path"        VARCHAR(500),
  ADD COLUMN "media_url"         VARCHAR(1000),
  ADD COLUMN "media_mime_type"   VARCHAR(120),
  ADD COLUMN "media_size_bytes"  INTEGER,
  ADD COLUMN "media_duration_ms" INTEGER,
  ADD COLUMN "file_name"         VARCHAR(255),
  ADD COLUMN "uploaded_by_id"    UUID;

-- Indice composto pra lookup por (accountId, type, isActive) — query principal
-- do template-picker (recordSend ja busca por type filtrado a cada tick).
CREATE INDEX "warmup_templates_account_id_type_is_active_idx"
  ON "warmup_templates" ("account_id", "type", "is_active");
