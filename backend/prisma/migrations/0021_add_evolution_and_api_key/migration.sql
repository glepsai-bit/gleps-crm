-- Evolution API columns on accounts
ALTER TABLE "accounts"
  ADD COLUMN "evolution_base_url" VARCHAR(500),
  ADD COLUMN "evolution_api_key"  VARCHAR(500),
  ADD COLUMN "evolution_instance" VARCHAR(255);

-- ApiKey table
CREATE TABLE "api_keys" (
  "id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "key_prefix" VARCHAR(16) NOT NULL,
  "hashed_key" VARCHAR(255) NOT NULL,
  "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "created_by_id" UUID,
  "last_used_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "api_keys_account_id_idx" ON "api_keys"("account_id");
CREATE INDEX "api_keys_hashed_key_idx" ON "api_keys"("hashed_key");
CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys"("key_prefix");

ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
