CREATE TABLE "system_settings" (
  "id" VARCHAR(40) NOT NULL DEFAULT 'singleton',
  "evolution_base_url" VARCHAR(500),
  "evolution_api_key" VARCHAR(500),
  "evolution_webhook_url" VARCHAR(500),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- Seed do row singleton + migra valores per-account (se único)
INSERT INTO "system_settings" ("id", "evolution_base_url", "evolution_api_key")
SELECT 'singleton',
       MAX("evolution_base_url"),
       MAX("evolution_api_key")
FROM "accounts"
WHERE "evolution_base_url" IS NOT NULL
LIMIT 1
ON CONFLICT ("id") DO NOTHING;

-- Garante row singleton mesmo se não houver dados pra migrar
INSERT INTO "system_settings" ("id") VALUES ('singleton') ON CONFLICT DO NOTHING;

-- Per-account uniqueness do evolution_instance no Inbox (espelha @@unique do schema).
-- Garante que duas Inboxes da mesma conta não possam compartilhar a mesma instance Evolution.
CREATE UNIQUE INDEX IF NOT EXISTS "inboxes_account_id_evolution_instance_key"
  ON "inboxes" ("account_id", "evolution_instance");
