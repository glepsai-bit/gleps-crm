-- Link cadence steps to templates (resolved at send time)
ALTER TABLE "email_cadence_steps"
  ADD COLUMN IF NOT EXISTS "template_id" UUID NULL;

DO $$ BEGIN
  ALTER TABLE "email_cadence_steps"
    ADD CONSTRAINT "email_cadence_steps_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "email_templates"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_email_cadence_steps_template" ON "email_cadence_steps"("template_id");
