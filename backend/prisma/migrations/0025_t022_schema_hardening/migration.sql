-- T-022 Schema Hardening (BUG-030, BUG-052, BUG-033, BUG-064, BUG-070, BUG-071)

-- BUG-030: DispatchLog.inbox_id nullable (campanhas Evolution não usam inbox)
ALTER TABLE "dispatch_logs" ALTER COLUMN "inbox_id" DROP NOT NULL;

-- BUG-052: api_keys.hashed_key unique (substitui index não-unique por unique)
DROP INDEX IF EXISTS "api_keys_hashed_key_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_hashed_key_key" ON "api_keys"("hashed_key");

-- BUG-033 / BUG-064: FKs faltantes
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_batches_template_id_fkey') THEN
    ALTER TABLE "dispatch_batches"
      ADD CONSTRAINT "dispatch_batches_template_id_fkey"
      FOREIGN KEY ("template_id") REFERENCES "whatsapp_templates"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_templates_created_by_id_fkey') THEN
    ALTER TABLE "whatsapp_templates"
      ADD CONSTRAINT "whatsapp_templates_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_consents_contact_id_fkey') THEN
    ALTER TABLE "whatsapp_consents"
      ADD CONSTRAINT "whatsapp_consents_contact_id_fkey"
      FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- BUG-070: unique (account_id, name) em whatsapp_templates
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_templates_account_id_name_key"
  ON "whatsapp_templates"("account_id", "name");

-- BUG-071: dispatch_logs.account_id (+ index + FK + backfill)
ALTER TABLE "dispatch_logs" ADD COLUMN IF NOT EXISTS "account_id" UUID;

UPDATE "dispatch_logs" dl
SET "account_id" = db."account_id"
FROM "dispatch_batches" db
WHERE dl."batch_id" = db."id"
  AND dl."account_id" IS NULL;

ALTER TABLE "dispatch_logs" ALTER COLUMN "account_id" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "dispatch_logs_account_id_idx" ON "dispatch_logs"("account_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_logs_account_id_fkey') THEN
    ALTER TABLE "dispatch_logs"
      ADD CONSTRAINT "dispatch_logs_account_id_fkey"
      FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
