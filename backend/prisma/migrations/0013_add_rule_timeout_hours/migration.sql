-- Add timeout_hours to email_cadence_rules for not_opened logic
ALTER TABLE "email_cadence_rules" ADD COLUMN IF NOT EXISTS "timeout_hours" INTEGER DEFAULT 48;
