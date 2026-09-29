-- T-039 — agendamento pelo agente.
--
-- O Google Calendar é a agenda: o evento vive lá e, editado lá, vence. O CRM
-- entra com o que o Google não expõe por API (horário de trabalho, duração por
-- serviço), calcula os horários livres, segura o horário enquanto o lead
-- confirma e liga a reunião à conversa — é esse vínculo que faz o lembrete e o
-- "minha reunião" existirem. Quem não conecta o Google usa a agenda daqui.
--
-- Idempotente: o start.sh reaplica as migrations recentes a cada boot.

-- Reserva temporária (o agente segura o horário enquanto o lead confirma).
ALTER TYPE "CalendarEventStatus" ADD VALUE IF NOT EXISTS 'held';

-- Produto com duração = serviço agendável. NULL = venda, não serviço.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "duracao_minutos" INTEGER;

-- O evento passa a saber quem atende, o que foi marcado e em que conversa.
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "profissional_user_id" UUID;
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "product_id" UUID;
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "conversation_id" UUID;
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "hold_expires_at" TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_events_profissional_user_id_fkey') THEN
    ALTER TABLE "calendar_events"
      ADD CONSTRAINT "calendar_events_profissional_user_id_fkey"
      FOREIGN KEY ("profissional_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_events_product_id_fkey') THEN
    ALTER TABLE "calendar_events"
      ADD CONSTRAINT "calendar_events_product_id_fkey"
      FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "calendar_events_account_id_profissional_user_id_start_time_idx"
  ON "calendar_events"("account_id", "profissional_user_id", "start_time");
CREATE INDEX IF NOT EXISTS "calendar_events_account_id_contact_id_start_time_idx"
  ON "calendar_events"("account_id", "contact_id", "start_time");

-- Token do Google: o que foi concedido e se precisa reconectar.
ALTER TABLE "google_calendar_tokens" ADD COLUMN IF NOT EXISTS "scope" VARCHAR(500);
ALTER TABLE "google_calendar_tokens" ADD COLUMN IF NOT EXISTS "reauth_required_at" TIMESTAMPTZ;
ALTER TABLE "google_calendar_tokens" ADD COLUMN IF NOT EXISTS "reauth_reason" VARCHAR(200);

-- Profissionais que atendem com hora marcada e as regras de cada um.
CREATE TABLE IF NOT EXISTS "agenda_profissionais" (
  "id"                 UUID        NOT NULL DEFAULT gen_random_uuid(),
  "account_id"         UUID        NOT NULL,
  "user_id"            UUID        NOT NULL,
  "ativo"              BOOLEAN     NOT NULL DEFAULT true,
  "horarios"           JSONB       NOT NULL DEFAULT '{}',
  "intervalo_minutos"  INTEGER     NOT NULL DEFAULT 0,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agenda_profissionais_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agenda_profissionais_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agenda_profissionais_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "agenda_profissionais_user_id_key" ON "agenda_profissionais"("user_id");
CREATE INDEX IF NOT EXISTS "agenda_profissionais_account_id_ativo_idx" ON "agenda_profissionais"("account_id", "ativo");

-- Regras da conta.
CREATE TABLE IF NOT EXISTS "agenda_configuracao" (
  "account_id"                  UUID         NOT NULL,
  "antecedencia_minima_minutos" INTEGER      NOT NULL DEFAULT 120,
  "janela_maxima_dias"          INTEGER      NOT NULL DEFAULT 30,
  "passo_minutos"               INTEGER      NOT NULL DEFAULT 30,
  "hold_minutos"                INTEGER      NOT NULL DEFAULT 5,
  "etapa_ao_agendar"            VARCHAR(120),
  "updated_at"                  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agenda_configuracao_pkey" PRIMARY KEY ("account_id"),
  CONSTRAINT "agenda_configuracao_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- A agenda como habilidade do agente. NULL = desligada.
ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "agenda" JSONB;

-- O run que dorme esperando a reunião (lembrete) não morre quando o lead fala.
ALTER TABLE "flow_runs" ADD COLUMN IF NOT EXISTS "agenda_evento_id" UUID;
