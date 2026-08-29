-- T-029 — Discador (telefonia ativa).
--
-- Credenciais da operadora por conta (multi-tenant, mesmo padrão das chaves de
-- IA) + registro de ligações.
--
-- Idempotente (IF NOT EXISTS) porque start.sh roda DDL de garantia no boot
-- mesmo quando `migrate deploy` falha — mesmo padrão de 0056, 0057 e 0058.

-- AlterTable: credenciais Twilio por conta
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "twilio_account_sid"     VARCHAR(120);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "twilio_auth_token"      VARCHAR(200);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "twilio_api_key_sid"     VARCHAR(120);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "twilio_api_key_secret"  VARCHAR(200);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "twiml_app_sid"          VARCHAR(120);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "twilio_caller_id"       VARCHAR(30);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "voice_recording"        BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE IF NOT EXISTS "calls" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "user_id" UUID,
    "contact_id" UUID,
    "direction" VARCHAR(12) NOT NULL DEFAULT 'outbound',
    "to_number" VARCHAR(30) NOT NULL,
    "from_number" VARCHAR(30),
    "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "provider_call_sid" VARCHAR(80),
    "duration_sec" INTEGER,
    "price_usd" DECIMAL(10,5),
    "recording_url" TEXT,
    "disposition" VARCHAR(40),
    "notes" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- O SID do provedor é a chave de correlação dos webhooks de status: cada
-- callback da operadora chega com ele e precisa achar a ligação certa.
CREATE UNIQUE INDEX IF NOT EXISTS "calls_provider_call_sid_key" ON "calls"("provider_call_sid");
CREATE INDEX IF NOT EXISTS "calls_account_id_created_at_idx" ON "calls"("account_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "calls_account_id_status_idx" ON "calls"("account_id", "status");
CREATE INDEX IF NOT EXISTS "calls_contact_id_idx" ON "calls"("contact_id");
CREATE INDEX IF NOT EXISTS "calls_user_id_idx" ON "calls"("user_id");

-- AddForeignKey
-- Postgres não tem "ADD CONSTRAINT IF NOT EXISTS"; o DO/EXCEPTION mantém o
-- script re-executável (start.sh roda de novo no boot).
DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- SET NULL: apagar o usuário não pode apagar o histórico da ligação.
DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "calls" ADD CONSTRAINT "calls_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
