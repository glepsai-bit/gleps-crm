-- ETAPA W — aquecimento simples (07/10/2026).
--
-- O aquecimento deixa de ter pool, estratégia e IA: todos os números em
-- aquecimento da conta conversam entre si, numa rampa única de 30 dias. O que
-- muda no banco:
--
--   warmup_numbers.pool_id vira opcional — número novo nasce sem pool. O número
--   passa a apontar para a inbox do Chat (inbox_id), de onde vêm a instância e
--   o telefone. falhas_seguidas / disparos_hoje / modo / pronto_em / pausado_em
--   são o estado que a tela "Aquecimento" mostra e que o motor de Disparos lê
--   (capacidade restante do dia).
--
--   warmup_conversations ganha o agendamento da próxima resposta (quem responde,
--   quando), o roteiro sorteado e o passo em que a conversa está — é isso que
--   faz a conversa parecer gente (lê, "digita", responde depois de 1–5 min).
--   pool_id também vira opcional pelo mesmo motivo acima.
--
--   accounts.warmup_infra_pausa_ate: falha de infraestrutura (Evolution fora,
--   timeout) pausa a CONTA por 15 min, sem punir o número.
--
-- Idempotente: o start.sh reaplica este arquivo a cada boot. O backfill de
-- inbox_id só preenche quem está NULL, então rodar de novo é inofensivo.

DO $$
BEGIN
  IF to_regclass('public.warmup_numbers') IS NULL THEN
    RAISE NOTICE 'warmup_numbers ainda nao existe - nada a fazer';
    RETURN;
  END IF;

  -- ---- warmup_numbers ----
  ALTER TABLE "warmup_numbers" ALTER COLUMN "pool_id" DROP NOT NULL;
  ALTER TABLE "warmup_numbers" ADD COLUMN IF NOT EXISTS "inbox_id" UUID NULL;
  ALTER TABLE "warmup_numbers" ADD COLUMN IF NOT EXISTS "falhas_seguidas" INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE "warmup_numbers" ADD COLUMN IF NOT EXISTS "disparos_hoje" INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE "warmup_numbers" ADD COLUMN IF NOT EXISTS "modo" VARCHAR(20) NOT NULL DEFAULT 'rampa';
  ALTER TABLE "warmup_numbers" ADD COLUMN IF NOT EXISTS "pronto_em" TIMESTAMPTZ NULL;
  ALTER TABLE "warmup_numbers" ADD COLUMN IF NOT EXISTS "pausado_em" TIMESTAMPTZ NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'warmup_numbers_inbox_id_fkey'
  ) THEN
    ALTER TABLE "warmup_numbers"
      ADD CONSTRAINT "warmup_numbers_inbox_id_fkey"
      FOREIGN KEY ("inbox_id") REFERENCES "inboxes"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  CREATE INDEX IF NOT EXISTS "warmup_numbers_inbox_id_idx" ON "warmup_numbers"("inbox_id");

  -- Backfill: a inbox cuja instância Evolution é a mesma do número (mesma conta).
  UPDATE "warmup_numbers" wn
     SET "inbox_id" = i."id"
    FROM "inboxes" i
   WHERE wn."inbox_id" IS NULL
     AND i."account_id" = wn."account_id"
     AND i."evolution_instance" = wn."evolution_instance";

  -- ---- warmup_conversations ----
  ALTER TABLE "warmup_conversations" ALTER COLUMN "pool_id" DROP NOT NULL;
  ALTER TABLE "warmup_conversations" ADD COLUMN IF NOT EXISTS "proxima_resposta_em" TIMESTAMPTZ NULL;
  ALTER TABLE "warmup_conversations" ADD COLUMN IF NOT EXISTS "proximo_remetente_id" UUID NULL;
  ALTER TABLE "warmup_conversations" ADD COLUMN IF NOT EXISTS "roteiro" JSONB NULL;
  ALTER TABLE "warmup_conversations" ADD COLUMN IF NOT EXISTS "passo" INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE "warmup_conversations" ADD COLUMN IF NOT EXISTS "ultimo_msg_id" VARCHAR(255) NULL;

  CREATE INDEX IF NOT EXISTS "warmup_conversations_proxima_resposta_em_idx"
    ON "warmup_conversations"("proxima_resposta_em");

  -- ---- accounts ----
  ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "warmup_infra_pausa_ate" TIMESTAMPTZ NULL;
END $$;
