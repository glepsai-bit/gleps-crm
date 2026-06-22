-- T-021: Webhook Chatwoot por-conta. Substitui CHATWOOT_WEBHOOK_SECRET global
-- pelo campo chatwoot_webhook_secret na tabela accounts. O env permanece como
-- fallback opcional (retrocompat) ate que todas as contas tenham secret proprio.

ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "chatwoot_webhook_secret" VARCHAR(500);
