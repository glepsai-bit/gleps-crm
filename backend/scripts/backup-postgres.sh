#!/usr/bin/env sh
# ============================================================================
# GLEPS CRM - Backup do Postgres
# ============================================================================
# Faz pg_dump do banco apontado por DATABASE_URL, comprime em gzip e grava em
# ./backups/gleps-YYYYMMDD-HHMMSS.sql.gz. Mantem apenas os ultimos 14 dias.
#
# Uso:
#   DATABASE_URL=postgresql://user:pass@host:5432/db ./backup-postgres.sh
#
# Requisitos:
#   - pg_dump disponivel no PATH (postgresql-client). Se rodando dentro do
#     container backend, o Dockerfile precisa instalar postgresql-client via
#     `apk add --no-cache postgresql-client`. Alternativa: rodar via
#     `docker compose exec postgres pg_dump ...` (a imagem postgres:16-alpine
#     ja traz pg_dump).
#   - Diretorio de backups persistente. Ver README-backup.md.
#
# Variaveis opcionais:
#   BACKUP_DIR      diretorio de destino (default: ./backups)
#   RETENTION_DAYS  quantos dias manter (default: 14)
# ============================================================================
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[backup] ERRO: DATABASE_URL nao definida" >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "[backup] ERRO: pg_dump nao encontrado. Instale postgresql-client." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

# Prisma adiciona ?schema=public ao DATABASE_URL. libpq moderno aceita, mas
# strip por seguranca (pg_dump nao usa esse param).
PG_URL="${DATABASE_URL%%\?*}"

TS="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$BACKUP_DIR/gleps-$TS.sql.gz"
TMP_FILE="$OUT_FILE.partial"

echo "[backup] iniciando pg_dump -> $OUT_FILE"

# --no-owner / --no-acl facilitam restore em outro host (evita ROLE inexistente)
if pg_dump --no-owner --no-acl --format=plain "$PG_URL" | gzip -9 > "$TMP_FILE"; then
  mv "$TMP_FILE" "$OUT_FILE"
  SIZE="$(du -h "$OUT_FILE" | awk '{print $1}')"
  echo "[backup] OK: $OUT_FILE ($SIZE)"
else
  rm -f "$TMP_FILE"
  echo "[backup] ERRO: pg_dump falhou" >&2
  exit 2
fi

echo "[backup] aplicando retention: $RETENTION_DAYS dias"
find "$BACKUP_DIR" -type f -name 'gleps-*.sql.gz' -mtime +"$RETENTION_DAYS" -print -delete || true

echo "[backup] concluido"
