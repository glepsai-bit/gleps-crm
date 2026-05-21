-- Email Module: Add fields to accounts + new tables

-- 1. New fields in accounts
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "openai_api_key" VARCHAR(500);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "sendgrid_api_key" VARCHAR(500);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "sendgrid_from_email" VARCHAR(255);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "sendgrid_from_name" VARCHAR(255);

-- 2. Enums
DO $$ BEGIN
  CREATE TYPE "email_enrollment_status" AS ENUM ('active', 'paused', 'completed', 'unsubscribed', 'bounced');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "email_send_status" AS ENUM ('queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'failed', 'spam');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. email_cadences
CREATE TABLE IF NOT EXISTS "email_cadences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "account_id" UUID NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "target_stage_ids" UUID[] DEFAULT '{}',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "email_cadences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_cadences_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE
);

-- 4. email_cadence_steps
CREATE TABLE IF NOT EXISTS "email_cadence_steps" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "cadence_id" UUID NOT NULL,
  "day_number" INT NOT NULL DEFAULT 1,
  "subject" VARCHAR(500) NOT NULL,
  "body_html" TEXT NOT NULL,
  "body_text" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "ordem" INT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "email_cadence_steps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_cadence_steps_cadence_id_fkey" FOREIGN KEY ("cadence_id") REFERENCES "email_cadences"("id") ON DELETE CASCADE
);

-- 5. email_templates
CREATE TABLE IF NOT EXISTS "email_templates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "account_id" UUID NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "subject" VARCHAR(500) NOT NULL,
  "body_html" TEXT NOT NULL,
  "body_text" TEXT,
  "category" VARCHAR(100),
  "created_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_templates_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE
);

-- 6. email_enrollments
CREATE TABLE IF NOT EXISTS "email_enrollments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "account_id" UUID NOT NULL,
  "cadence_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "current_step" INT NOT NULL DEFAULT 0,
  "status" "email_enrollment_status" NOT NULL DEFAULT 'active',
  "enrolled_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "next_send_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "email_enrollments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_enrollments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE,
  CONSTRAINT "email_enrollments_cadence_id_fkey" FOREIGN KEY ("cadence_id") REFERENCES "email_cadences"("id") ON DELETE CASCADE,
  CONSTRAINT "email_enrollments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE
);

-- 7. email_sends
CREATE TABLE IF NOT EXISTS "email_sends" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "account_id" UUID NOT NULL,
  "enrollment_id" UUID,
  "step_id" UUID,
  "contact_id" UUID NOT NULL,
  "to_email" VARCHAR(255) NOT NULL,
  "subject" VARCHAR(500) NOT NULL,
  "sendgrid_message_id" VARCHAR(255),
  "status" "email_send_status" NOT NULL DEFAULT 'queued',
  "opened_at" TIMESTAMPTZ,
  "clicked_at" TIMESTAMPTZ,
  "bounced_at" TIMESTAMPTZ,
  "error_message" TEXT,
  "sent_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "email_sends_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_sends_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE,
  CONSTRAINT "email_sends_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "email_enrollments"("id") ON DELETE SET NULL,
  CONSTRAINT "email_sends_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "email_cadence_steps"("id") ON DELETE SET NULL,
  CONSTRAINT "email_sends_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS "idx_email_cadences_account" ON "email_cadences"("account_id");
CREATE INDEX IF NOT EXISTS "idx_email_cadence_steps_cadence" ON "email_cadence_steps"("cadence_id");
CREATE INDEX IF NOT EXISTS "idx_email_templates_account" ON "email_templates"("account_id");
CREATE INDEX IF NOT EXISTS "idx_email_enrollments_account" ON "email_enrollments"("account_id");
CREATE INDEX IF NOT EXISTS "idx_email_enrollments_cadence" ON "email_enrollments"("cadence_id");
CREATE INDEX IF NOT EXISTS "idx_email_enrollments_status" ON "email_enrollments"("status");
CREATE INDEX IF NOT EXISTS "idx_email_sends_account" ON "email_sends"("account_id");
CREATE INDEX IF NOT EXISTS "idx_email_sends_enrollment" ON "email_sends"("enrollment_id");
CREATE INDEX IF NOT EXISTS "idx_email_sends_status" ON "email_sends"("status");
