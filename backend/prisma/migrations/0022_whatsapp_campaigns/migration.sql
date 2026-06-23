-- DispatchBatch: novos campos pra agendamento + origem
ALTER TABLE "dispatch_batches"
  ADD COLUMN "scheduled_at"  TIMESTAMPTZ,
  ADD COLUMN "source"        VARCHAR(40) NOT NULL DEFAULT 'manual',
  ADD COLUMN "trigger_name"  VARCHAR(120),
  ADD COLUMN "metadata"      JSONB,
  ADD COLUMN "template_id"   UUID,
  ADD COLUMN "inbox_id"      INTEGER;

CREATE INDEX "dispatch_batches_scheduled_at_status_idx" ON "dispatch_batches"("scheduled_at", "status");
CREATE INDEX "dispatch_batches_source_idx" ON "dispatch_batches"("source");

-- WhatsappTemplate
CREATE TABLE "whatsapp_templates" (
  "id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "content" TEXT NOT NULL,
  "category" VARCHAR(40) NOT NULL DEFAULT 'custom',
  "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "whatsapp_templates_account_id_idx" ON "whatsapp_templates"("account_id");
CREATE INDEX "whatsapp_templates_category_idx" ON "whatsapp_templates"("category");

ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
