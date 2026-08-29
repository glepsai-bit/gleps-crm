#!/bin/sh
# ============================================
# GLEPS CRM - Backend Startup Script
# ============================================

echo "============================================"
echo "GLEPS CRM - Backend Starting"
echo "============================================"

# ---- 1. Aguardar banco de dados ----
echo "⏳ Aguardando banco de dados..."
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if echo "SELECT 1;" | npx prisma db execute --stdin > /dev/null 2>&1; then
        echo "✅ Banco de dados acessível"
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "   Tentativa $RETRY_COUNT/$MAX_RETRIES - aguardando..."
    sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo "❌ ERRO: Banco de dados não respondeu após $MAX_RETRIES tentativas"
    exit 1
fi

# ---- 1.5. RESET TOTAL DO BANCO ----
# DESABILITADO 2026-06-30: o reset baseado em REQUIRED_RESET_VERSION causou
# problemas em deploys de produção (perda de dados em redeploys e quando o
# marker _system_meta não conseguia ser gravado, causando reset em loop).
#
# A partir de agora o reset SÓ acontece se a env var RESET_DB_FORCE=YES estiver
# definida explicitamente. Em uso normal este bloco é noop e a inicialização
# segue direto para migrations (passo 2). O marker _system_meta continua a
# ser respeitado pelo passo 3 (skip seed legado).
#
# Para forçar um reset manual em situação extrema:
#   RESET_DB_FORCE=YES <comando de boot>
SKIP_MIGRATE=no
REQUIRED_RESET_VERSION=2

if [ "${RESET_DB_FORCE:-NO}" = "YES" ]; then
    NEEDS_RESET=YES
    echo "⚠️  RESET_DB_FORCE=YES detectado — reset MANUAL será executado."
else
    NEEDS_RESET=NO
    echo "ℹ️  Auto-reset desabilitado (RESET_DB_FORCE != YES). Seguindo direto pra migrations."
fi

if [ "$NEEDS_RESET" = "YES" ]; then
    echo ""
    echo "============================================"
    echo "⚠️  Primeira boot OU reset_version desatualizada"
    echo "    Droppando schema e re-aplicando migrations..."
    echo "    (Versao desejada: ${REQUIRED_RESET_VERSION})"
    echo "============================================"

    npx prisma migrate reset --force --skip-seed
    RESET_EXIT=$?

    if [ $RESET_EXIT -ne 0 ]; then
        echo "❌ Reset falhou. Abortando boot pra evitar estado inconsistente."
        exit 1
    fi

    echo "✅ Schema zerado e migrations re-aplicadas."
    echo "👤 Criando unico super_admin..."

    SEED_EMAIL="${SUPER_ADMIN_EMAIL:-admin@gleps.com.br}"
    SEED_PASSWORD="${SUPER_ADMIN_PASSWORD:-Admin@123}"
    SEED_NAME="${SUPER_ADMIN_NAME:-Super Admin}"

    SEED_EMAIL="$SEED_EMAIL" SEED_PASSWORD="$SEED_PASSWORD" SEED_NAME="$SEED_NAME" node -e "
      const { PrismaClient } = require('@prisma/client');
      const bcrypt = require('bcryptjs');
      (async () => {
        const prisma = new PrismaClient();
        try {
          const email = process.env.SEED_EMAIL.toLowerCase().trim();
          const password = process.env.SEED_PASSWORD;
          const nome = process.env.SEED_NAME;
          const hash = await bcrypt.hash(password, 12);
          await prisma.user.create({
            data: { email, nome, passwordHash: hash, role: 'super_admin', status: 'active', permissions: [] },
          });
          const total = await prisma.user.count();
          console.log('✅ Super admin criado:', email);
          console.log('   Senha:', password);
          console.log('   Total de users no DB:', total);
        } finally {
          await prisma.\$disconnect();
        }
      })();
    "

    SEED_EXIT=$?
    if [ $SEED_EXIT -ne 0 ]; then
        echo "❌ Criacao do super_admin falhou."
        exit 1
    fi

    # Grava marker pra nao resetar de novo em proximos boots
    REQUIRED_RESET_VERSION="$REQUIRED_RESET_VERSION" node -e "
      const { PrismaClient } = require('@prisma/client');
      (async () => {
        const prisma = new PrismaClient();
        try {
          await prisma.\$executeRawUnsafe(
            'CREATE TABLE IF NOT EXISTS public._system_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());'
          );
          await prisma.\$executeRawUnsafe(
            \"INSERT INTO public._system_meta (key, value) VALUES ('reset_version', '\" + process.env.REQUIRED_RESET_VERSION + \"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();\"
          );
          console.log('✅ Marker _system_meta.reset_version =', process.env.REQUIRED_RESET_VERSION);
        } finally {
          await prisma.\$disconnect();
        }
      })();
    "

    MARKER_EXIT=$?
    if [ $MARKER_EXIT -ne 0 ]; then
        echo "⚠️  Gravacao do marker falhou — proximo boot pode resetar de novo. Conferir DB."
    fi

    export RUN_SEED=false
    SKIP_MIGRATE=YES

    echo ""
    echo "🎉 RESET CONCLUIDO. Proximos redeploys NAO vao resetar (marker gravado)."
    echo "============================================"
    echo ""
fi

# ---- 2. Aplicar migrations (com auto-recovery de P3009) ----
if [ "$SKIP_MIGRATE" = "YES" ]; then
    echo ""
    echo "⏭️  Migrations puladas (ja aplicadas pelo RESET_DB_ON_BOOT)"
    MIGRATE_EXIT=0
else
echo ""
echo "🔄 Aplicando migrations..."

MIGRATE_OUTPUT=$(npx prisma migrate deploy 2>&1)
MIGRATE_EXIT=$?

if [ $MIGRATE_EXIT -ne 0 ]; then
    echo "⚠️  Primeira tentativa de migration falhou (exit=$MIGRATE_EXIT)"

    if echo "$MIGRATE_OUTPUT" | grep -q "P3009\|P3018"; then
        echo "🔧 Detectado P3009/P3018 — tentando resolver migration falhada..."

        for MIGRATION_NAME in "0007_google_token_user_isolation" "0003_add_resolution_unique" "0002_add_resolution_logs"; do
            echo "   Resolvendo $MIGRATION_NAME como rolled-back..."
            npx prisma migrate resolve --rolled-back "$MIGRATION_NAME" 2>/dev/null || true
        done

        echo "🔄 Re-aplicando migrations..."
        MIGRATE_OUTPUT=$(npx prisma migrate deploy 2>&1)
        MIGRATE_EXIT=$?

        if [ $MIGRATE_EXIT -ne 0 ]; then
            echo "❌ Migration falhou mesmo após recovery:"
            echo "$MIGRATE_OUTPUT"
            echo ""
            echo "⚠️  Iniciando servidor mesmo assim (funcionalidade parcial)..."
        else
            echo "✅ Migrations aplicadas com sucesso após recovery"
        fi
    else
        echo "❌ Erro de migration (não é P3009):"
        echo "$MIGRATE_OUTPUT"
        echo ""
        echo "⚠️  Iniciando servidor mesmo assim (funcionalidade parcial)..."
    fi
else
    echo "✅ Migrations aplicadas"
fi
fi

# ---- 2.5. Rede de seguranca do schema de tracking ----
# O passo 2 tolera falha de migration e sobe o servidor mesmo assim
# ("funcionalidade parcial"). Isso e aceitavel pra features antigas, mas o
# modulo de Tracking LE source_type/source_id em toda query: sem as colunas o
# Prisma quebra em runtime na pagina inteira, nao so numa parte.
#
# Este bloco garante as colunas de forma idempotente, independente do
# resultado do migrate deploy. Tudo e IF NOT EXISTS; rodar N vezes e inofensivo.
echo ""
echo "🛡️  Garantindo schema do modulo de tracking..."

TRACKING_DDL=$(cat <<'SQL'
DO $$
BEGIN
  IF to_regclass('public.tracking_events') IS NULL THEN
    RAISE NOTICE 'tracking_events ainda nao existe - nada a garantir';
    RETURN;
  END IF;

  ALTER TABLE tracking_events ADD COLUMN IF NOT EXISTS source_type VARCHAR(24);
  ALTER TABLE tracking_events ADD COLUMN IF NOT EXISTS source_id   UUID;

  -- Lead e 1:1 com a conversa, entao da pra inferir a origem com seguranca.
  -- DISTINCT ON garante uma linha por (conta, conversa): se o historico tiver
  -- Leads duplicados, so o mais antigo recebe a origem e o indice unico abaixo
  -- nao quebra. Reuniao e venda nao sao inferiveis - ficam NULL.
  UPDATE tracking_events te
     SET source_type = 'conversation',
         source_id   = te.conversation_id
    FROM (
      SELECT DISTINCT ON (account_id, conversation_id) id
        FROM tracking_events
       WHERE event_name = 'Lead'
         AND source_id IS NULL
         AND conversation_id IS NOT NULL
       ORDER BY account_id, conversation_id, created_at ASC
    ) primeiros
   WHERE te.id = primeiros.id
     -- Guarda contra colisao com linha que JA tem essa origem (a migration
     -- 0056 faz o mesmo backfill; um dos dois roda primeiro). Sem isso o
     -- UPDATE violaria o indice unico.
     AND NOT EXISTS (
       SELECT 1 FROM tracking_events x
        WHERE x.account_id = te.account_id
          AND x.event_name = te.event_name
          AND x.source_id  = te.conversation_id
     );

  CREATE UNIQUE INDEX IF NOT EXISTS tracking_events_account_event_source_key
    ON tracking_events (account_id, event_name, source_id);
  CREATE INDEX IF NOT EXISTS tracking_events_status_idx
    ON tracking_events (status);
END $$;
SQL
)

if echo "$TRACKING_DDL" | npx prisma db execute --stdin > /dev/null 2>&1; then
    echo "✅ Schema de tracking garantido"
else
    echo "⚠️  Nao foi possivel garantir o schema de tracking — a pagina de"
    echo "    Tracking de Anuncios pode falhar. Demais modulos seguem normais."
fi

# ---- 2.6. Rede de seguranca do schema de Atendimento IA (T-027 / T-028) ----
# Mesma razao do bloco de tracking acima: o passo 2 tolera falha de migration e
# sobe o servidor assim mesmo. Se estas migrations nao aplicarem, as telas de
# Agentes IA, Conhecimento, Fluxos e Execucoes quebram inteiras (o Prisma nao
# acha as tabelas) — e, pior, o gatilho do atendimento IA falha em toda
# mensagem recebida.
#
# O auto-recovery de P3009 do passo 2 so resolve tres migrations antigas
# HARDCODED — uma migration falhada em qualquer outro ponto do historico passa
# batido e bloqueia TODAS as posteriores, inclusive estas.
#
# Ambas foram escritas idempotentes de proposito (CREATE ... IF NOT EXISTS e
# DO/EXCEPTION nas FKs), entao re-executar e inofensivo. `COPY prisma ./prisma/`
# no Dockerfile garante os arquivos na imagem.
echo ""
echo "🛡️  Garantindo schema dos modulos de IA..."

for MIG in 0057_ai_core 0058_flow_engine 0059_dialer 0060_sip_dialer 0061_multi_agent 0062_flow_preview; do
    ARQ="prisma/migrations/$MIG/migration.sql"
    if [ -f "$ARQ" ]; then
        if npx prisma db execute --file "$ARQ" > /dev/null 2>&1; then
            echo "✅ Schema garantido: $MIG"
        else
            echo "⚠️  Nao foi possivel garantir $MIG — as telas do modulo podem falhar."
        fi
    else
        echo "ℹ️  $MIG nao encontrada na imagem — pulando (build antigo?)"
    fi
done

# ---- 3. Executar seed (se habilitado) ----
# Se ja temos marker de reset gravado, NUNCA rodamos o seed legado (que
# cria 3 super_admins + Account demo "Clinica Vida Plena" e contamina o
# banco apos o reset). O marker eh prova de que o reset oficial cuidou
# da criacao do super_admin unico.
HAS_RESET_MARKER=$(node -e "
  const { PrismaClient } = require('@prisma/client');
  (async () => {
    const prisma = new PrismaClient();
    try {
      const rows = await prisma.\$queryRawUnsafe(
        \"SELECT value FROM public._system_meta WHERE key = 'reset_version' LIMIT 1;\"
      );
      console.log(Array.isArray(rows) && rows.length > 0 ? 'YES' : 'NO');
    } catch (e) {
      console.log('NO');
    } finally {
      await prisma.\$disconnect();
    }
  })();
" 2>/dev/null | tail -1)

if [ "$HAS_RESET_MARKER" = "YES" ]; then
    echo ""
    echo "⏭️  Seed legado pulado (marker _system_meta detectado — super_admin ja criado pelo reset)"
elif [ "${RUN_SEED:-true}" = "true" ]; then
    echo ""
    echo "🌱 Executando seed..."
    node dist/prisma/seed.js || echo "⚠️ Seed falhou (pode já ter sido executado)"
    echo "✅ Seed concluído"
else
    echo ""
    echo "⏭️  Seed desabilitado (RUN_SEED=false)"
fi

# ---- 4. Diagnóstico ----
echo ""
echo "🔍 Diagnóstico:"

if [ -n "$GOOGLE_CLIENT_ID" ]; then
    echo "   📅 Google Calendar: env vars detectadas (fallback ativo) — client_id=${GOOGLE_CLIENT_ID:0:8}..."
else
    echo "   📅 Google Calendar: env vars NÃO detectadas — depende de credenciais no DB (por conta)"
fi

echo "   💬 Chatwoot: credenciais armazenadas no banco de dados (por conta)"

# ---- 5. Iniciar servidor ----
echo ""
echo "🚀 Iniciando servidor..."
exec node dist/server.js
