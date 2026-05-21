-- Sprint 2: Inbox messages for reply detection
CREATE TABLE IF NOT EXISTS "email_inbox_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "account_id" UUID NOT NULL,
  "contact_id" UUID,
  "from_email" VARCHAR(255) NOT NULL,
  "to_email" VARCHAR(255) NOT NULL,
  "subject" VARCHAR(500) NOT NULL,
  "body_text" TEXT,
  "body_html" TEXT,
  "in_reply_to" VARCHAR(500),
  "enrollment_id" UUID,
  "read" BOOLEAN NOT NULL DEFAULT false,
  "replied" BOOLEAN NOT NULL DEFAULT false,
  "replied_at" TIMESTAMPTZ,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "email_inbox_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_inbox_messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE,
  CONSTRAINT "email_inbox_messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL,
  CONSTRAINT "email_inbox_messages_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "email_enrollments"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "idx_email_inbox_account" ON "email_inbox_messages"("account_id");
CREATE INDEX IF NOT EXISTS "idx_email_inbox_contact" ON "email_inbox_messages"("contact_id");
CREATE INDEX IF NOT EXISTS "idx_email_inbox_read" ON "email_inbox_messages"("read");

-- Sprint 4: Campaigns entity
CREATE TABLE IF NOT EXISTS "email_campaigns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "account_id" UUID NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "email_campaigns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_campaigns_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_email_campaigns_account" ON "email_campaigns"("account_id");

-- Add campaign_id to cadences
ALTER TABLE "email_cadences" ADD COLUMN IF NOT EXISTS "campaign_id" UUID;
ALTER TABLE "email_cadences" ADD CONSTRAINT "email_cadences_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "email_campaigns"("id") ON DELETE SET NULL;

-- Sprint 5: Segmentation fields on contacts
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "nicho" VARCHAR(255);
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "cidade" VARCHAR(255);
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "estado" VARCHAR(100);

CREATE INDEX IF NOT EXISTS "idx_contacts_nicho" ON "contacts"("nicho");
CREATE INDEX IF NOT EXISTS "idx_contacts_cidade" ON "contacts"("cidade");
CREATE INDEX IF NOT EXISTS "idx_contacts_estado" ON "contacts"("estado");
