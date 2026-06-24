-- BUG-2: oscilacao do Contact.nome (pushName WhatsApp x edicao manual).
-- Adiciona origem do nome ('manual' | 'inbound' | 'imported') + campos
-- de auditoria do pushName (valor cru + contador de mudancas + ultima
-- atualizacao). O webhook contacts.update so atualiza Contact.nome
-- quando name_source != 'manual'; pushName e gravado sempre pra historico.

-- 1) Enum de origem
DO $$ BEGIN
  CREATE TYPE "ContactNameSource" AS ENUM ('manual', 'inbound', 'imported');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2) Colunas novas em contacts
ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "name_source" "ContactNameSource" NOT NULL DEFAULT 'inbound',
  ADD COLUMN IF NOT EXISTS "push_name"   VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "push_name_updated_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "push_name_change_count" INTEGER NOT NULL DEFAULT 0;

-- 3) Backfill: contatos legados que ja tem nome assumem inbound (padrao seguro;
--    se o usuario quiser travar manualmente vai editar pela UI).
-- Nada a fazer alem do DEFAULT — todos os existentes ficam 'inbound'.
