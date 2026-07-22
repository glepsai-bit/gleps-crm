-- Visibilidade do time: compartilhada (todos os membros veem as conversas do
-- time) vs carteira individual (cada agente só vê as atribuídas a ele).
-- Aditiva/idempotente. Default TRUE = comportamento atual preservado (times
-- hoje são compartilhados). Comercial marca FALSE = carteira individual,
-- funcionando junto com round-robin sem vazar leads entre consultoras.
ALTER TABLE "teams"
  ADD COLUMN IF NOT EXISTS "shared_visibility" BOOLEAN NOT NULL DEFAULT TRUE;
