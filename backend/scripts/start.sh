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

# ---- 2. Aplicar migrations (com auto-recovery de P3009) ----
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
