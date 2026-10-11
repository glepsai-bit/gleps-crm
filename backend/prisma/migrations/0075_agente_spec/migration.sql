-- 0075 — PROVISIONAMENTO DE AGENTE: a especificação versionada.
--
-- O agente passa a poder nascer de um `spec` (briefing estruturado) que o
-- provisionamento transforma em base de conhecimento, serviços, agenda,
-- etapas, prompt por seções e fluxo em sombra. O spec fica guardado no
-- próprio agente (`spec`, `spec_versao`) e cada provisionamento grava uma
-- linha em `agent_spec_versions` — é o que permite reverter.
--
-- Idempotente: o start.sh reaplica as migrations recentes a cada boot.

ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "spec" JSONB;
ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "spec_versao" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "agent_spec_versions" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "agent_id"   UUID        NOT NULL,
  "account_id" UUID        NOT NULL,
  "versao"     INTEGER     NOT NULL,
  "spec"       JSONB       NOT NULL,
  "flow_id"    UUID,
  "criado_por" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_spec_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_spec_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_spec_versions_agent_id_versao_key"
  ON "agent_spec_versions"("agent_id", "versao");
CREATE INDEX IF NOT EXISTS "agent_spec_versions_account_id_idx"
  ON "agent_spec_versions"("account_id");
