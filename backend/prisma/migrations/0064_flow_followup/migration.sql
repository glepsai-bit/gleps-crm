-- T-033 — follow-up e gatilho por webhook.
--
-- Até aqui uma execução ia do gatilho ao fim numa tacada, e o motor sempre
-- recomeçava do gatilho. Follow-up exige o oposto: dormir por dias e retomar
-- EXATAMENTE onde parou, senão o lead receberia o atendimento inteiro de novo.
--
-- resume_node_id: onde continuar ao acordar.
-- wake_count:     quantos toques já foram. É o que permite "pare no terceiro" —
--                 sem contador, a cadência não sabe onde está e insiste sempre.
-- dedupe_key:     idempotência do webhook. Sistema externo que erra reenvia, e
--                 dois "feliz aniversário" é pior que nenhum.
--
-- Idempotente: o start.sh reaplica as migrations recentes a cada boot.
ALTER TABLE "flow_runs" ADD COLUMN IF NOT EXISTS "resume_node_id" VARCHAR(80);
ALTER TABLE "flow_runs" ADD COLUMN IF NOT EXISTS "wake_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "flow_runs" ADD COLUMN IF NOT EXISTS "dedupe_key" VARCHAR(200);

-- Um evento externo só pode gerar UM run por conta. O índice é a trava real:
-- checar antes de inserir perderia a corrida entre duas entregas simultâneas.
CREATE UNIQUE INDEX IF NOT EXISTS "flow_runs_account_dedupe_key"
  ON "flow_runs"("account_id", "dedupe_key") WHERE "dedupe_key" IS NOT NULL;
