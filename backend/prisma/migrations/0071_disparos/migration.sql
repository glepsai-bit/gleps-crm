-- ETAPA D — Disparos: motor único com fila no banco.
--
-- `disparos` é a campanha (texto, variantes, anexo, lista, números, quem
-- atende). `disparo_envios` é a fila: uma linha por contato, com o número
-- (inbox) já decidido e o horário mínimo de envio (`nao_antes_de`) já
-- calculado na criação — o worker só pega o que venceu, em ordem, com
-- SKIP LOCKED. É isso que dá o ritmo de 20–60 s e a janela 08h–20h sem
-- nenhum processo ficar dormindo em memória (o motor antigo morria com o
-- restart e deixava batches órfãos).
--
-- `conversations.disparo_id` liga a conversa do Chat ao disparo que a abriu:
-- é por ela que a resposta inbound vira "respondeu" e que o agente de IA
-- recebe o bloco "CONTEXTO DO DISPARO". A flag "humano assumiu" NÃO ganha
-- coluna: já existe `custom_attributes.human_active` (live attendance,
-- circuit breaker do whatsapp-send e message.controller leem dela).
--
-- Idempotente: o start.sh reaplica este arquivo a cada boot.

CREATE TABLE IF NOT EXISTS "disparos" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "account_id"       UUID NOT NULL,
  "nome"             VARCHAR(120) NOT NULL,
  "texto"            TEXT NOT NULL,
  "variantes"        JSONB NOT NULL DEFAULT '[]',
  "anexo"            JSONB,
  "lista"            JSONB NOT NULL,
  "inbox_ids"        UUID[] NOT NULL,
  "atende_respostas" VARCHAR(10) NOT NULL DEFAULT 'agente',
  "status"           VARCHAR(20) NOT NULL,
  "pausado_motivo"   TEXT,
  -- {inboxId: n} — falhas seguidas de NÚMERO por inbox dentro deste disparo.
  -- 5 seguidas pausam só aquele número (redistribui) ou o disparo, se era o único.
  "falhas_seguidas"  JSONB NOT NULL DEFAULT '{}',
  "agendado_para"    TIMESTAMPTZ,
  "iniciado_em"      TIMESTAMPTZ,
  "concluido_em"     TIMESTAMPTZ,
  "total"            INTEGER NOT NULL DEFAULT 0,
  "enviadas"         INTEGER NOT NULL DEFAULT 0,
  "falhas"           INTEGER NOT NULL DEFAULT 0,
  "respondidas"      INTEGER NOT NULL DEFAULT 0,
  "optout"           INTEGER NOT NULL DEFAULT 0,
  "pulados"          INTEGER NOT NULL DEFAULT 0,
  "criado_por"       UUID,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "disparos_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "disparos_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "disparos_account_id_status_idx" ON "disparos"("account_id", "status");
CREATE INDEX IF NOT EXISTS "disparos_status_agendado_para_idx" ON "disparos"("status", "agendado_para");

CREATE TABLE IF NOT EXISTS "disparo_envios" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "disparo_id"       UUID NOT NULL,
  "account_id"       UUID NOT NULL,
  "contact_id"       UUID,
  -- E.164 sem "+", sempre com 55 (utils/telefone.ts).
  "telefone"         VARCHAR(20) NOT NULL,
  "nome"             VARCHAR(255),
  "variaveis"        JSONB,
  "inbox_id"         UUID NOT NULL,
  "variante"         INTEGER NOT NULL DEFAULT 0,
  "nao_antes_de"     TIMESTAMPTZ NOT NULL,
  "status"           VARCHAR(24) NOT NULL,
  "erro"             TEXT,
  "tentativas"       INTEGER NOT NULL DEFAULT 0,
  "evolution_msg_id" VARCHAR(255),
  "conversation_id"  UUID,
  "enviado_em"       TIMESTAMPTZ,
  "respondido_em"    TIMESTAMPTZ,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- updated_at existe pelo worker: um envio preso em 'enviando' há mais de
  -- 10 min (processo caiu no meio) volta pra fila por esta coluna.
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "disparo_envios_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "disparo_envios_disparo_id_fkey" FOREIGN KEY ("disparo_id") REFERENCES "disparos"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "disparo_envios_status_nao_antes_de_idx" ON "disparo_envios"("status", "nao_antes_de");
CREATE INDEX IF NOT EXISTS "disparo_envios_disparo_id_status_idx" ON "disparo_envios"("disparo_id", "status");
CREATE INDEX IF NOT EXISTS "disparo_envios_evolution_msg_id_idx" ON "disparo_envios"("evolution_msg_id");
CREATE INDEX IF NOT EXISTS "disparo_envios_conversation_id_idx" ON "disparo_envios"("conversation_id");
-- "contato preso ao número": na criação, quem já conversou por um dos
-- números escolhidos continua nele. A busca é por conta + telefone.
CREATE INDEX IF NOT EXISTS "disparo_envios_account_id_telefone_idx" ON "disparo_envios"("account_id", "telefone");

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "disparo_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_disparo_id_fkey') THEN
    ALTER TABLE "conversations"
      ADD CONSTRAINT "conversations_disparo_id_fkey"
      FOREIGN KEY ("disparo_id") REFERENCES "disparos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "conversations_disparo_id_idx" ON "conversations"("disparo_id");
