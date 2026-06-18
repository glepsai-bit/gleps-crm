-- T-019: Webhook n8n por-conta. Substitui N8N_WEBHOOK_URL global do .env
-- pelos campos n8n_webhook_url / n8n_webhook_secret na tabela accounts.
-- Secret eh opcional; quando setado o backend assina o payload com HMAC.

ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "n8n_webhook_url"    VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "n8n_webhook_secret" VARCHAR(500);
