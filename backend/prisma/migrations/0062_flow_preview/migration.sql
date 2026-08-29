-- T-031 — simulador de atendimento.
--
-- O simulador roda o fluxo de verdade, então cada teste vira um FlowRun. Sem
-- distinguir, a tela de Execuções — que existe pra comparar o modo sombra com
-- o atendimento real — encheria de conversa de teste e perderia a serventia.
--
-- Idempotente: o start.sh reaplica as migrations recentes a cada boot.
ALTER TABLE "flow_runs" ADD COLUMN IF NOT EXISTS "simulador" BOOLEAN NOT NULL DEFAULT false;

-- A tela de Execuções filtra por conta + data e agora exclui o simulador.
CREATE INDEX IF NOT EXISTS "flow_runs_simulador_idx" ON "flow_runs"("account_id", "simulador");
