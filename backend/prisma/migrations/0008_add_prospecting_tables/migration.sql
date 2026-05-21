-- CreateTable
CREATE TABLE IF NOT EXISTS "api_usage_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "endpoint" VARCHAR(100) NOT NULL DEFAULT 'maps-data',
    "requests_count" INTEGER NOT NULL DEFAULT 1,
    "month" VARCHAR(7) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "api_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "dispatch_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "keyword" TEXT,
    "location" TEXT,
    "total_contacts" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "delay_seconds" INTEGER NOT NULL DEFAULT 30,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "dispatch_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "dispatch_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batch_id" UUID NOT NULL,
    "contact_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "inbox_id" INTEGER NOT NULL,
    "inbox_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "dispatch_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "api_usage_logs_account_id_month_idx" ON "api_usage_logs"("account_id", "month");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "dispatch_batches_account_id_idx" ON "dispatch_batches"("account_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "dispatch_logs_batch_id_idx" ON "dispatch_logs"("batch_id");

-- AddForeignKey (only if not exists)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_usage_logs_account_id_fkey') THEN
    ALTER TABLE "api_usage_logs" ADD CONSTRAINT "api_usage_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_batches_account_id_fkey') THEN
    ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_logs_batch_id_fkey') THEN
    ALTER TABLE "dispatch_logs" ADD CONSTRAINT "dispatch_logs_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "dispatch_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Add monthly_extraction_limit to accounts if not exists
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'monthly_extraction_limit') THEN
    ALTER TABLE "accounts" ADD COLUMN "monthly_extraction_limit" INTEGER DEFAULT 500;
  END IF;
END $$;
