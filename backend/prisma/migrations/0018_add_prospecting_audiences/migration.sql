-- CreateTable: prospecting_audiences
CREATE TABLE IF NOT EXISTS "prospecting_audiences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "account_id" UUID NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "keyword" TEXT,
  "location" TEXT,
  "total_leads" INTEGER NOT NULL DEFAULT 0,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "prospecting_audiences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prospecting_audiences_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "prospecting_audiences_account_id_idx"
  ON "prospecting_audiences"("account_id");

-- CreateTable: prospecting_audience_leads
CREATE TABLE IF NOT EXISTS "prospecting_audience_leads" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "audience_id" UUID NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "phone" VARCHAR(50),
  "address" TEXT,
  "rating" DECIMAL(3,1),
  "website" TEXT,
  "category" VARCHAR(255),
  "raw_data" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "prospecting_audience_leads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prospecting_audience_leads_audience_id_fkey"
    FOREIGN KEY ("audience_id") REFERENCES "prospecting_audiences"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "prospecting_audience_leads_audience_id_idx"
  ON "prospecting_audience_leads"("audience_id");
