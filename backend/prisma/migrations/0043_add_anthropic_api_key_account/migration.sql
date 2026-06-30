-- T-025: permite admin de conta configurar chave Anthropic alem de OpenAI
-- (self-service em /admin/integracoes — antes era so super_admin).

ALTER TABLE "accounts"
  ADD COLUMN "anthropic_api_key" VARCHAR(500);
