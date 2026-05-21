-- Add user_id column (nullable first)
ALTER TABLE "google_calendar_tokens" ADD COLUMN "user_id" UUID;

-- For any existing rows, we need a value - delete orphaned tokens
DELETE FROM "google_calendar_tokens" WHERE "user_id" IS NULL;

-- Make user_id NOT NULL
ALTER TABLE "google_calendar_tokens" ALTER COLUMN "user_id" SET NOT NULL;

-- Drop old unique constraint on account_id
DROP INDEX IF EXISTS "google_calendar_tokens_account_id_key";

-- Add unique constraint on user_id
CREATE UNIQUE INDEX "google_calendar_tokens_user_id_key" ON "google_calendar_tokens"("user_id");
