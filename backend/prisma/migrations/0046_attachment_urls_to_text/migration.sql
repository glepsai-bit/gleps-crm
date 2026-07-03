-- BUG-ATTACH-500 (2026-07-03): converter URLs de attachment de VARCHAR(2000)
-- para TEXT. Data URLs base64 (usadas quando frontend envia anexo inline sem
-- upload dedicado) estouram 2000 chars com qualquer PNG >2KB, causando 500
-- INTERNAL_ERROR silencioso. Rows legadas continuam válidas — Postgres faz
-- upcast lossless de VARCHAR pra TEXT (mesma família character types).
--
-- Operação atômica, não bloqueia leituras: ALTER COLUMN TYPE preserva dados.
ALTER TABLE "attachments"
  ALTER COLUMN "file_url" TYPE TEXT,
  ALTER COLUMN "source_url" TYPE TEXT,
  ALTER COLUMN "thumbnail_url" TYPE TEXT;
