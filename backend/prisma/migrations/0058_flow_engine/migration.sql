-- T-028 Fase 2 — Motor de fluxo de atendimento.
--
-- O workflow de 62 nós que hoje roda no n8n vira dado da conta: um grafo
-- versionado que o motor interpreta, com log por passo.
--
-- Idempotente (IF NOT EXISTS) porque start.sh roda DDL de garantia no boot
-- mesmo quando `migrate deploy` falha — mesmo padrão de 0056 e 0057.

-- CreateTable
CREATE TABLE IF NOT EXISTS "flows" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "graph" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "inbox_ids" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "flow_runs" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "flow_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'buffering',
    "run_after" TIMESTAMPTZ,
    "context" JSONB NOT NULL DEFAULT '{}',
    "shadow" BOOLEAN NOT NULL DEFAULT false,
    "stop_reason" VARCHAR(80),
    "error" TEXT,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "flow_run_steps" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "node_id" VARCHAR(80) NOT NULL,
    "node_type" VARCHAR(60) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "ms" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "ordem" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flow_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "flows_account_id_status_idx" ON "flows"("account_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "flows_account_id_name_key" ON "flows"("account_id", "name");

-- O worker varre por (status, run_after) a cada poucos segundos.
CREATE INDEX IF NOT EXISTS "flow_runs_status_run_after_idx" ON "flow_runs"("status", "run_after");
CREATE INDEX IF NOT EXISTS "flow_runs_account_id_created_at_idx" ON "flow_runs"("account_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "flow_runs_conversation_id_idx" ON "flow_runs"("conversation_id");

CREATE INDEX IF NOT EXISTS "flow_run_steps_run_id_ordem_idx" ON "flow_run_steps"("run_id", "ordem");

-- DEBOUNCE: no máximo UM run 'buffering' por conversa.
--
-- É esta trava que faz duas mensagens quase simultâneas do mesmo lead
-- AGRUPAREM num atendimento só, em vez de abrir dois. O código tenta criar o
-- run e trata P2002 como "já existe, então só empurra o run_after" — sem o
-- índice, a corrida entre dois webhooks da Evolution criaria runs duplicados e
-- a IA responderia duas vezes.
--
-- Índice PARCIAL: runs já finalizados (done/failed) não participam da restrição.
-- O Prisma não suporta partial unique no schema, então ele vive só aqui.
CREATE UNIQUE INDEX IF NOT EXISTS "flow_runs_conversation_buffering_key"
  ON "flow_runs"("conversation_id") WHERE "status" = 'buffering';

-- AddForeignKey
-- Postgres não tem "ADD CONSTRAINT IF NOT EXISTS"; o DO/EXCEPTION mantém o
-- script re-executável (start.sh roda de novo no boot).
DO $$ BEGIN
  ALTER TABLE "flows" ADD CONSTRAINT "flows_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_id_fkey"
    FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "flow_run_steps" ADD CONSTRAINT "flow_run_steps_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "flow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
