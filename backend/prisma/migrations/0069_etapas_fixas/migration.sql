-- ETAPA B — etapas fixas do funil (Fechado / Perdido) e fechamento no Kanban.
--
-- tags.papel marca a etapa que encerra o funil: 'fechamento' (ganhou) ou
-- 'perda' (perdeu). Etapa com papel não se apaga e fica sempre no fim. É
-- entrar nela que dispara o registro da venda — por isso precisa existir em
-- TODO funil, inclusive nos que já estavam no ar.
--
-- sales.origem = 'fechamento' distingue a venda que nasceu do Kanban da venda
-- lançada à mão no Financeiro. É por ela que o Kanban mostra "Fechou R$ X" e
-- que o lead que sai e volta da etapa não ganha venda duplicada.
--
-- Idempotente: o start.sh reaplica este arquivo a cada boot. O backfill fica
-- DENTRO do IF da coluna — fora dele, cada boot voltaria a carimbar papel em
-- etapas que o cliente renomeou de propósito.

-- Venda registrada pelo Kanban não passa pelo formulário de pagamento.
-- Fora do DO/transação: ADD VALUE não pode ser usado na mesma transação em
-- que foi criado, e aqui ninguém o usa.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'nao_informado';

ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "origem" VARCHAR(20);

DO $$
DECLARE
  funil  RECORD;
  v_id   UUID;
  v_max  INT;
  v_slug TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'tags'
      AND column_name = 'papel'
  ) THEN
    RETURN;
  END IF;

  ALTER TABLE "tags" ADD COLUMN "papel" VARCHAR(20);

  FOR funil IN SELECT id, account_id, slug FROM funnels LOOP
    -- Perda primeiro: "Venda perdida" bate nas duas listas e é perda.
    v_id := NULL;
    SELECT id INTO v_id FROM tags
     WHERE funnel_id = funil.id AND type = 'stage' AND ativo = true
       AND (lower(slug) ~ '(^|-)(perdido|perdida|perdeu|perda|lost)(-|$)'
            OR lower(name) ~ '(^|[^[:alpha:]])(perdido|perdida|perdeu|perda|lost)([^[:alpha:]]|$)')
     ORDER BY ordem ASC, created_at ASC
     LIMIT 1;
    IF v_id IS NOT NULL THEN
      UPDATE tags SET papel = 'perda' WHERE id = v_id;
    END IF;

    -- Fechamento: a de menor ordem entre as que batem.
    v_id := NULL;
    SELECT id INTO v_id FROM tags
     WHERE funnel_id = funil.id AND type = 'stage' AND ativo = true AND papel IS NULL
       AND (lower(slug) ~ '(^|-)(fechado|fechamento|ganho|convertido|venda|vendido|cliente)(-|$)'
            OR lower(name) ~ '(^|[^[:alpha:]])(fechado|fechamento|ganho|convertido|venda|vendido|cliente)([^[:alpha:]]|$)')
       AND lower(slug) !~ '(perd|lost)' AND lower(name) !~ '(perd|lost)'
     ORDER BY ordem ASC, created_at ASC
     LIMIT 1;
    IF v_id IS NOT NULL THEN
      UPDATE tags SET papel = 'fechamento' WHERE id = v_id;
    END IF;

    -- Funil sem fechamento ganha "Fechado" no fim. Nenhum lead se move.
    IF NOT EXISTS (SELECT 1 FROM tags WHERE funnel_id = funil.id AND papel = 'fechamento') THEN
      SELECT COALESCE(MAX(ordem), -1) INTO v_max FROM tags WHERE funnel_id = funil.id AND type = 'stage';
      -- slug é único por conta: o segundo funil da conta leva o sufixo do funil.
      v_slug := 'fechado';
      IF EXISTS (SELECT 1 FROM tags WHERE account_id = funil.account_id AND slug = v_slug) THEN
        v_slug := 'fechado-' || funil.slug;
      END IF;
      IF EXISTS (SELECT 1 FROM tags WHERE account_id = funil.account_id AND slug = v_slug) THEN
        v_slug := v_slug || '-' || substr(replace(funil.id::text, '-', ''), 1, 8);
      END IF;
      INSERT INTO tags (id, account_id, funnel_id, name, slug, type, color, ordem, ativo, papel, created_at)
      VALUES (gen_random_uuid(), funil.account_id, funil.id, 'Fechado', v_slug, 'stage', '#F0A532', v_max + 1, true, 'fechamento', now());
    END IF;

    -- Idem "Perdido", depois de "Fechado".
    IF NOT EXISTS (SELECT 1 FROM tags WHERE funnel_id = funil.id AND papel = 'perda') THEN
      SELECT COALESCE(MAX(ordem), -1) INTO v_max FROM tags WHERE funnel_id = funil.id AND type = 'stage';
      v_slug := 'perdido';
      IF EXISTS (SELECT 1 FROM tags WHERE account_id = funil.account_id AND slug = v_slug) THEN
        v_slug := 'perdido-' || funil.slug;
      END IF;
      IF EXISTS (SELECT 1 FROM tags WHERE account_id = funil.account_id AND slug = v_slug) THEN
        v_slug := v_slug || '-' || substr(replace(funil.id::text, '-', ''), 1, 8);
      END IF;
      INSERT INTO tags (id, account_id, funnel_id, name, slug, type, color, ordem, ativo, papel, created_at)
      VALUES (gen_random_uuid(), funil.account_id, funil.id, 'Perdido', v_slug, 'stage', '#E5484D', v_max + 1, true, 'perda', now());
    END IF;
  END LOOP;
END $$;
