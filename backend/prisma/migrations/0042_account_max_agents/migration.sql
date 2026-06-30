-- T-024: gerenciamento de agentes por admin de conta
-- Adiciona limite especifico de agents (separado do teto total de users).
-- Default 5 alinhado com tier basico (Chatwoot/Pipedrive starter).

ALTER TABLE "accounts"
  ADD COLUMN "max_agents" INTEGER NOT NULL DEFAULT 5;

-- Backfill: respeita teto existente para evitar contas legadas em violacao instantanea
UPDATE "accounts" SET "max_agents" = LEAST(5, "limite_usuarios");

-- Index parcial para acelerar count(role='agent') por account no limit check
CREATE INDEX IF NOT EXISTS "users_account_role_agent_idx"
  ON "users" ("account_id")
  WHERE "role" = 'agent';
