-- Add monthly/daily email send limits per account
ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "monthly_email_limit" INTEGER DEFAULT 3000,
  ADD COLUMN IF NOT EXISTS "daily_email_limit"   INTEGER DEFAULT 100;

-- Backfill any existing NULLs (in case column already existed)
UPDATE "accounts" SET "monthly_email_limit" = 3000 WHERE "monthly_email_limit" IS NULL;
UPDATE "accounts" SET "daily_email_limit"   = 100  WHERE "daily_email_limit"   IS NULL;

-- Helpful indexes for quota queries on email_sends
CREATE INDEX IF NOT EXISTS "email_sends_account_created_idx"
  ON "email_sends" ("account_id", "created_at");
