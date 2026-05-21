-- Add send_at_time to email_cadences
ALTER TABLE "email_cadences" ADD COLUMN IF NOT EXISTS "send_at_time" VARCHAR(5) DEFAULT '09:00';
