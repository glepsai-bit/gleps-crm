-- Filtros/condições por assinatura. Sem isso, message.created dispara para
-- as mensagens do proprio bot e cria loop infinito da IA respondendo a si mesma.
-- Aditiva e idempotente: assinaturas existentes ficam com '{}' (sem filtro =
-- comportamento atual preservado).
ALTER TABLE "webhook_subscriptions"
  ADD COLUMN IF NOT EXISTS "filters" JSONB NOT NULL DEFAULT '{}'::jsonb;
