-- Add start_date to email_cadences
ALTER TABLE "email_cadences" ADD COLUMN IF NOT EXISTS "start_date" DATE DEFAULT CURRENT_DATE;
