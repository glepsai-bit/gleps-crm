-- Migration: drop residual integration columns + remove 'chatwoot' enum value
-- T-FitPark Round 2: zera referencias residuais nas tabelas/enums compartilhados.

-- Drop colunas residuais em users / contacts / tags
ALTER TABLE users    DROP COLUMN IF EXISTS chatwoot_agent_id;
ALTER TABLE contacts DROP COLUMN IF EXISTS chatwoot_contact_id;
ALTER TABLE contacts DROP COLUMN IF EXISTS chatwoot_conversation_id;
ALTER TABLE tags     DROP COLUMN IF EXISTS chatwoot_label_id;

-- Normaliza linhas existentes que ainda referenciam o valor 'chatwoot' do enum
UPDATE lead_tags    SET source = 'system' WHERE source = 'chatwoot';
UPDATE tag_history  SET source = 'system' WHERE source = 'chatwoot';

-- Recria o enum LeadTagSource sem 'chatwoot' (Postgres nao permite DROP VALUE direto).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'LeadTagSource' AND e.enumlabel = 'chatwoot'
  ) THEN
    -- Cria tipo novo
    CREATE TYPE "LeadTagSource_new" AS ENUM ('kanban', 'system', 'api');

    -- Converte colunas pro tipo novo
    ALTER TABLE lead_tags   ALTER COLUMN source TYPE "LeadTagSource_new" USING source::text::"LeadTagSource_new";
    ALTER TABLE tag_history ALTER COLUMN source TYPE "LeadTagSource_new" USING source::text::"LeadTagSource_new";

    -- Substitui o tipo antigo
    DROP TYPE "LeadTagSource";
    ALTER TYPE "LeadTagSource_new" RENAME TO "LeadTagSource";
  END IF;
END$$;
