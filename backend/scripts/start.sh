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

# ---- 1.5. RESET TOTAL DO BANCO (uma vez, automatico) ----
# Heuristica: detecta se a tabela `_system_meta` existe E tem entry
# `reset_version` = REQUIRED_RESET_VERSION. Se NAO tiver, dropa schema,
# re-aplica migrations, cria UM super_admin e grava a versao. Proximo
# redeploy: tabela ja tem a entry, pula tudo e segue boot normal.
#
# Pra forcar novo reset em futuro: incrementar REQUIRED_RESET_VERSION abaixo.
# Customizar super_admin via SUPER_ADMIN_EMAIL/PASSWORD/NAME (defaults
# admin@gleps.com.br / Admin@123 / Super Admin).
REQUIRED_RESET_VERSION=1
SKIP_MIGRATE=no

NEEDS_RESET=$(node -e "
  const { PrismaClient } = require('@prisma/client');
  (async () => {
    const prisma = new PrismaClient();
    try {
      const tableExists = await prisma.\$queryRawUnsafe(
        \"SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_system_meta' LIMIT 1;\"
      );
      if (!Array.isArray(tableExists) || tableExists.length === 0) {
        console.log('YES'); return;
      }
      const rows = await prisma.\$queryRawUnsafe(
        \"SELECT value FROM _system_meta WHERE key = 'reset_version' LIMIT 1;\"
      );
      const current = Array.isArray(rows) && rows[0] ? String(rows[0].value) : '';
      console.log(current === '${REQUIRED_RESET_VERSION}' ? 'NO' : 'YES');
    } catch (e) {
      console.log('YES');
    } finally {
      await prisma.\$disconnect();
    }
  })();
" 2>/dev/null | tail -1)

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

# ---- 3. Executar seed (se habilitado) ----
if [ "${RUN_SEED:-true}" = "true" ]; then
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
