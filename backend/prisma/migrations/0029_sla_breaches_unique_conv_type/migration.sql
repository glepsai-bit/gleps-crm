-- CRON-002: previne duplicacao de SLABreach em multi-replica.
-- Antes do unique, o cron usava check-then-act (findFirst + create),
-- o que permitia race condition entre instancias.
--
-- Limpa duplicatas existentes (mantem o breach mais antigo por
-- conversation+breach_type) antes de aplicar o unique constraint.
DELETE FROM "sla_breaches" a
USING "sla_breaches" b
WHERE a.ctid < b.ctid
  AND a."conversation_id" = b."conversation_id"
  AND a."breach_type"     = b."breach_type";

CREATE UNIQUE INDEX "sla_breaches_conversation_type_unique"
  ON "sla_breaches" ("conversation_id", "breach_type");
