-- T-030 — arquitetura multi-agente.
--
-- `sub_agent_ids`: agentes que um agente pode consultar no meio do próprio
-- raciocínio. Um nível só — quem é consultado não consulta, senão dois agentes
-- se chamariam em laço.
--
-- Idempotente: start.sh roda no boot mesmo se `migrate deploy` falhar.
ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "sub_agent_ids" JSONB;
