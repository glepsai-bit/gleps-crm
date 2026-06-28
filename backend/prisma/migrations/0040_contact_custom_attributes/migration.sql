-- T-CONTACTS-API: adiciona coluna custom_attributes (jsonb) ao Contact.
-- Permite que integrações externas (n8n / agentes IA) gravem atributos
-- arbitrários por contato (plano, data_nascimento, segmento, etc.) sem
-- precisar de migration por campo.
--
-- Default '{}'::jsonb pra simplificar leituras (sempre objeto, nunca null).
-- Index GIN pra suportar filtros do tipo ?attr.plano=Anual no
-- /api/integrations/contacts (jsonb path operators).

ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "custom_attributes" jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS "contacts_custom_attributes_gin_idx"
  ON "contacts" USING GIN ("custom_attributes");

-- Adiciona valor 'integration' ao enum ContactOrigin (usado como origem
-- default quando contato vem da API externa /api/integrations/contacts).
-- ALTER TYPE ... ADD VALUE IF NOT EXISTS é idempotente desde PG 9.6.
ALTER TYPE "ContactOrigin" ADD VALUE IF NOT EXISTS 'integration';
