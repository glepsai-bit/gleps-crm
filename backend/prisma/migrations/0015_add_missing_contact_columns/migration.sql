-- Add missing columns to contacts table (already exist in Cloud, missing in production)
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "followup_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "last_followup_at" TIMESTAMPTZ;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "first_resolved_at" TIMESTAMPTZ;
