-- AUDIT-PERF-PAIDAT: todos os gráficos de receita e análises temporais
-- filtram Sale por accountId + status='paid' + range de paid_at
-- (finance.getRevenueChart, insights.getTemporalAnalysis, getProductAnalysis,
-- getPaymentMethods, overview) sem índice de suporte — o Postgres usava o
-- índice de account_id/status e fazia filtro residual varrendo todas as
-- vendas da conta a cada carga de dashboard.
CREATE INDEX IF NOT EXISTS "sales_account_id_status_paid_at_idx"
ON "sales" ("account_id", "status", "paid_at");
