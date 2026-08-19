-- T-027 Fase 1 — Atendimento IA nativo: agentes + base de conhecimento (RAG).
--
-- Traz pra dentro do produto o que hoje mora no n8n: o prompt do agente e o
-- conhecimento do negócio viram dados da conta.
--
-- DECISÃO DE STORAGE: `embedding` é JSONB (array de floats), não `vector`.
-- O Postgres de produção é postgres:16-alpine, sem pgvector — exigir a extensão
-- obrigaria a trocar a imagem do banco em produção. A similaridade é calculada
-- no Node (knowledge-index.ts), que é a ÚNICA porta de acesso a esses chunks;
-- migrar pra pgvector depois é reimplementar aquele arquivo, sem tocar em
-- schema de chamador.
--
-- Idempotente (IF NOT EXISTS) porque start.sh roda DDL de garantia no boot
-- mesmo quando `migrate deploy` falha — mesmo padrão de 0056.

-- CreateTable
CREATE TABLE IF NOT EXISTS "knowledge_bases" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "knowledge_docs" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "base_id" UUID NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "source_type" VARCHAR(20) NOT NULL DEFAULT 'text',
    "source_ref" TEXT,
    "content" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "indexed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "knowledge_chunks" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "base_id" UUID NOT NULL,
    "doc_id" UUID NOT NULL,
    "ordem" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ai_agents" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "role" VARCHAR(20) NOT NULL DEFAULT 'responder',
    "system_prompt" TEXT NOT NULL,
    "provider" VARCHAR(20) NOT NULL DEFAULT 'openai',
    "model" VARCHAR(80),
    "temperature" DECIMAL(3,2) NOT NULL DEFAULT 0.7,
    "max_tokens" INTEGER NOT NULL DEFAULT 1024,
    "history_limit" INTEGER NOT NULL DEFAULT 20,
    "knowledge_base_id" UUID,
    "tools" JSONB DEFAULT '[]',
    "output_schema" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "knowledge_bases_account_id_idx" ON "knowledge_bases"("account_id");
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_bases_account_id_name_key" ON "knowledge_bases"("account_id", "name");

CREATE INDEX IF NOT EXISTS "knowledge_docs_base_id_status_idx" ON "knowledge_docs"("base_id", "status");
CREATE INDEX IF NOT EXISTS "knowledge_docs_account_id_idx" ON "knowledge_docs"("account_id");
-- O worker de indexação varre por status global (todas as contas) a cada tick.
CREATE INDEX IF NOT EXISTS "knowledge_docs_status_idx" ON "knowledge_docs"("status");

-- (account_id, base_id) é o caminho da busca: o filtro de multi-tenancy nunca
-- depende de join com knowledge_bases.
CREATE INDEX IF NOT EXISTS "knowledge_chunks_account_id_base_id_idx" ON "knowledge_chunks"("account_id", "base_id");
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_chunks_doc_id_ordem_key" ON "knowledge_chunks"("doc_id", "ordem");

CREATE INDEX IF NOT EXISTS "ai_agents_account_id_active_idx" ON "ai_agents"("account_id", "active");
CREATE UNIQUE INDEX IF NOT EXISTS "ai_agents_account_id_name_key" ON "ai_agents"("account_id", "name");

-- AddForeignKey
-- Postgres não tem "ADD CONSTRAINT IF NOT EXISTS"; o DO/EXCEPTION mantém o
-- script re-executável (start.sh roda de novo no boot).
DO $$ BEGIN
  ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_docs" ADD CONSTRAINT "knowledge_docs_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_docs" ADD CONSTRAINT "knowledge_docs_base_id_fkey"
    FOREIGN KEY ("base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_base_id_fkey"
    FOREIGN KEY ("base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_doc_id_fkey"
    FOREIGN KEY ("doc_id") REFERENCES "knowledge_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- SET NULL: apagar uma base não pode derrubar o agente — ele continua
-- funcionando, só sem RAG.
DO $$ BEGIN
  ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_knowledge_base_id_fkey"
    FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
