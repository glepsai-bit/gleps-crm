-- Create email_audiences table
CREATE TABLE IF NOT EXISTS "email_audiences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "email_audiences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "email_audiences_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "email_audiences_account_id_idx" ON "email_audiences"("account_id");

-- Create email_audience_contacts junction table
CREATE TABLE IF NOT EXISTS "email_audience_contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "audience_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "email_audience_contacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "email_audience_contacts_audience_id_fkey" FOREIGN KEY ("audience_id") REFERENCES "email_audiences"("id") ON DELETE CASCADE,
    CONSTRAINT "email_audience_contacts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE,
    CONSTRAINT "email_audience_contacts_unique" UNIQUE ("audience_id", "contact_id")
);

CREATE INDEX IF NOT EXISTS "email_audience_contacts_audience_id_idx" ON "email_audience_contacts"("audience_id");
CREATE INDEX IF NOT EXISTS "email_audience_contacts_contact_id_idx" ON "email_audience_contacts"("contact_id");

-- Add audience_id to email_campaigns
ALTER TABLE "email_campaigns" ADD COLUMN IF NOT EXISTS "audience_id" UUID;
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_audience_id_fkey" FOREIGN KEY ("audience_id") REFERENCES "email_audiences"("id") ON DELETE SET NULL;
