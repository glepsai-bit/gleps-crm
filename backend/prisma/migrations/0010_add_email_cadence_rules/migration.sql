-- Email Cadence Rules (branching) + rate limit config

-- 1. Rate limit fields on accounts
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "email_batch_size" INTEGER DEFAULT 100;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "email_delay_ms" INTEGER DEFAULT 500;

-- 2. email_cadence_rules table
CREATE TABLE IF NOT EXISTS "email_cadence_rules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "cadence_id" UUID NOT NULL,
  "trigger_event" VARCHAR(50) NOT NULL,
  "target_cadence_id" UUID NOT NULL,
  "delay_hours" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "email_cadence_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_cadence_rules_cadence_id_fkey" FOREIGN KEY ("cadence_id") REFERENCES "email_cadences"("id") ON DELETE CASCADE,
  CONSTRAINT "email_cadence_rules_target_cadence_id_fkey" FOREIGN KEY ("target_cadence_id") REFERENCES "email_cadences"("id") ON DELETE CASCADE
);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS "idx_email_cadence_rules_cadence" ON "email_cadence_rules"("cadence_id");
CREATE INDEX IF NOT EXISTS "idx_email_cadence_rules_trigger" ON "email_cadence_rules"("trigger_event");
