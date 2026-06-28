-- SLA v2: outcome obrigatorio + avaliacao interna + CSAT cliente + horario comercial + pausa quando aguarda cliente
-- Apenas ALTER TABLE ADD COLUMN — sem mudar tipos existentes, sem dropar nada.

-- AlterTable: conversation_cycles — outcome, internal_rating, resolve_reason, customer_csat, csat_sent_at, csat_requested
ALTER TABLE "conversation_cycles"
  ADD COLUMN "outcome" VARCHAR(30),
  ADD COLUMN "internal_rating" INTEGER,
  ADD COLUMN "resolve_reason" TEXT,
  ADD COLUMN "customer_csat" INTEGER,
  ADD COLUMN "customer_csat_at" TIMESTAMPTZ,
  ADD COLUMN "csat_sent_at" TIMESTAMPTZ,
  ADD COLUMN "csat_requested" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: sla_policies — pause_when_waiting_customer, business_hours_start/end, business_days, timezone
ALTER TABLE "sla_policies"
  ADD COLUMN "pause_when_waiting_customer" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "business_hours_start" VARCHAR(5),
  ADD COLUMN "business_hours_end" VARCHAR(5),
  ADD COLUMN "business_days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
  ADD COLUMN "timezone" VARCHAR(60) NOT NULL DEFAULT 'America/Sao_Paulo';

-- CreateIndex: filtro de dashboard por outcome
CREATE INDEX "conversation_cycles_account_id_outcome_idx" ON "conversation_cycles"("account_id", "outcome");
