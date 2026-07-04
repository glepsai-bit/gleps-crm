# Backup do Postgres (GLEPS CRM)

Script: `backend/scripts/backup-postgres.sh`

Faz `pg_dump` do banco apontado por `DATABASE_URL`, comprime em gzip e grava em
`./backups/gleps-YYYYMMDD-HHMMSS.sql.gz`. Mantem apenas os ultimos **14 dias**
(configuravel via `RETENTION_DAYS`).

---

## 1. Requisitos

- `pg_dump` no PATH (pacote `postgresql-client`, versao igual ou maior que a do
  servidor — hoje `postgres:16-alpine`).
- Diretorio `./backups` **persistente** (bind mount ou volume mapeado para fora
  do container efemero).

### Onde rodar o script?

Ha duas estrategias suportadas. Escolha uma:

### Opcao A — Rodar dentro do container `backend` (recomendado no EasyPanel)

A imagem do backend hoje (`node:20-alpine` production stage) **NAO** inclui
`pg_dump`. Para habilitar, edite `backend/Dockerfile` no stage de producao:

```dockerfile
# antes:
RUN apk add --no-cache openssl
# depois:
RUN apk add --no-cache openssl postgresql-client
```

Rebuild e redeploy. Depois, agende:

```sh
docker compose exec -T backend sh /app/scripts/backup-postgres.sh
```

### Opcao B — Rodar via `docker exec` no container `postgres` (sem rebuild)

A imagem `postgres:16-alpine` **ja tem** `pg_dump`. Do host:

```sh
mkdir -p ./backups
docker compose exec -T postgres \
  pg_dump --no-owner --no-acl -U "$DB_USER" "$DB_NAME" \
  | gzip -9 > "./backups/gleps-$(date +%Y%m%d-%H%M%S).sql.gz"
find ./backups -type f -name 'gleps-*.sql.gz' -mtime +14 -delete
```

Nenhuma alteracao de Dockerfile e necessaria nessa opcao.

---

## 2. Volume `./backups`

O `docker-compose.yml` ja declara o bind mount no service `backend`:

```yaml
backend:
  volumes:
    - ./backups:/app/backups
```

Isso mapeia `./backups` do host para `/app/backups` dentro do container. O
script, executado a partir de `/app`, escreve em `./backups` (= host).

### EasyPanel

O EasyPanel nao usa o `docker-compose.yml` do repo diretamente para volumes:
adicione o bind mount pela UI:

1. App > service `backend` > aba **Volumes** (ou **Storage**).
2. **Add Bind Mount**.
3. Host path: um diretorio persistente no servidor (ex.: `/var/gleps/backups`).
4. Container path: `/app/backups`.
5. Save + Restart.

Verifique que o host path esta em disco persistente (nao em armazenamento
efemero) e tem espaco para 14 dias de dumps.

---

## 3. Agendamento (cron)

No host que executa o Docker (VPS ou EasyPanel host):

```cron
# Backup diario as 03:00 (Opcao A — via container backend)
0 3 * * * cd /opt/gleps-crm && docker compose exec -T backend sh /app/scripts/backup-postgres.sh >> /var/log/gleps-backup.log 2>&1

# OU (Opcao B — via container postgres, inline, sem script separado):
0 3 * * * cd /opt/gleps-crm && mkdir -p ./backups && docker compose exec -T postgres pg_dump -U ${DB_USER:-gleps} ${DB_NAME:-gleps_crm} | gzip > ./backups/gleps-$(date +\%Y\%m\%d-\%H\%M\%S).sql.gz && find ./backups -name 'gleps-*.sql.gz' -mtime +14 -delete >> /var/log/gleps-backup.log 2>&1
```

No EasyPanel, use **Scheduled Tasks** apontando para o mesmo comando.

---

## 4. Restore

Assumindo um dump `gleps-20260704-030000.sql.gz`:

```sh
# 1) parar o backend (evita gravacoes concorrentes)
docker compose stop backend

# 2) restaurar
gunzip -c ./backups/gleps-20260704-030000.sql.gz \
  | docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME"

# 3) subir o backend
docker compose start backend
```

Para restore em um banco **novo** (nao no atual), crie o database antes:

```sh
docker compose exec -T postgres createdb -U "$DB_USER" gleps_restore
gunzip -c gleps-20260704-030000.sql.gz \
  | docker compose exec -T postgres psql -U "$DB_USER" -d gleps_restore
```

O dump usa `--no-owner --no-acl`, entao roles do host original nao precisam
existir no destino.

---

## 5. Testando recuperacao (drill)

Recomendado mensal:

1. Copie o ultimo dump para um ambiente de staging.
2. Suba um Postgres novo (`docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16-alpine`).
3. `createdb -h localhost -p 55432 -U postgres gleps_drill`.
4. `gunzip -c gleps-*.sql.gz | psql -h localhost -p 55432 -U postgres -d gleps_drill`.
5. Rode uma query de sanidade (ex.: `SELECT count(*) FROM "User";`).
6. Registre o resultado no runbook interno.

Sem o drill nao existe garantia de que o backup e restauravel.

---

## 6. Variaveis do script

| Variavel | Default | Descricao |
|---|---|---|
| `DATABASE_URL` | (obrigatoria) | URI libpq. Prisma-only params (`?schema=...`) sao removidos. |
| `BACKUP_DIR` | `./backups` | Destino dos `.sql.gz`. |
| `RETENTION_DAYS` | `14` | Dias mantidos; `find -mtime +N -delete`. |

---

## 7. Troubleshooting

- **`pg_dump: command not found`**: falta o `postgresql-client` na imagem
  (Opcao A) — instale via Dockerfile ou use Opcao B.
- **`server version mismatch`**: `pg_dump` do cliente e mais antigo que o
  servidor. Use `postgresql-client` >= 16 (ou execute pela Opcao B, que ja
  casa versoes).
- **Dumps crescendo demais**: reduza `RETENTION_DAYS` ou mova antigos para
  storage frio (S3). O gzip nivel 9 ja e o maximo.
- **Backup vazio ou truncado**: verificar espaco em disco no host path do
  bind mount; o script grava em `.partial` e faz rename atomico so em sucesso.
