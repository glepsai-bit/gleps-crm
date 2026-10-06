-- ETAPA A — módulos opcionais por conta.
--
-- accounts.modulos guarda as chaves ligadas (ver src/config/modulos.ts).
-- Conta nova nasce com o padrão via account.service; conta que JÁ existia
-- ganha tudo aqui, no mesmo bloco da criação da coluna, pra não perder nada
-- que via antes.
--
-- Idempotente: o start.sh reaplica este arquivo a cada boot. Por isso o
-- backfill fica DENTRO do IF — fora dele, cada boot religaria todos os módulos
-- de uma conta que o super admin desligou de propósito.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'accounts'
      AND column_name = 'modulos'
  ) THEN
    ALTER TABLE "accounts" ADD COLUMN "modulos" TEXT[] NOT NULL DEFAULT '{}';
    UPDATE "accounts"
      SET "modulos" = ARRAY['extracao','disparos','emails','discador','vendas','aquecimento'];
  END IF;
END $$;
