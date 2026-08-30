-- T-032 — orientação da base de conhecimento.
--
-- Até aqui o agente recebia 6 trechos escolhidos por similaridade, ou nada. Ele
-- nunca sabia O QUE a base cobre, então não distinguia "isso não existe" de
-- "formulei mal a busca" — e dizia que ia confirmar sobre coisa que estava lá.
--
-- business_context: quem é o negócio. Fica na BASE e não no prompt de cada
--   agente porque, com vários agentes, a descrição seria copiada e divergiria.
-- summary: uma linha do que o documento cobre, gerada na indexação. A soma dos
--   summaries é o índice que vai sempre no prompt (~200 tokens), transformando
--   busca cega em busca dirigida.
--
-- Idempotente: o start.sh reaplica as migrations recentes a cada boot.
ALTER TABLE "knowledge_bases" ADD COLUMN IF NOT EXISTS "business_context" TEXT;
ALTER TABLE "knowledge_docs" ADD COLUMN IF NOT EXISTS "summary" TEXT;
