-- 0076 — MODELOS DE RACIOCÍNIO (ETAPA G): o esforço de raciocínio do agente.
--
-- gpt-5*, o1*, o3* e o4* aceitam `reasoning_effort` ('minimal' | 'low' |
-- 'medium' | 'high') e rejeitam `temperature`. O valor fica no agente
-- (`raciocinio` no Prisma); NULL = padrão do provider. O adapter em
-- services/ai/chat.ts só manda o campo pros modelos que o entendem.
--
-- Idempotente: o start.sh reaplica as migrations recentes a cada boot.

ALTER TABLE "ai_agents" ADD COLUMN IF NOT EXISTS "reasoning_effort" VARCHAR(10);
