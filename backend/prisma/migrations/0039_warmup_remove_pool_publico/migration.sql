-- Remove o conceito de pool publico/compartilhado entre contas.
-- Regra: cada conta SO usa seus proprios chips no aquecimento (isolamento
-- multi-tenant estrito + conformidade LGPD).
ALTER TABLE "warmup_pools" DROP COLUMN "is_public";
