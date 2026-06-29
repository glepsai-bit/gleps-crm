# Deploy Gleps CRM no EasyPanel

> Guia completo, do zero ao primeiro login em produção. Sobrescreve qualquer
> instrução anterior da variação FitPark (`docs/fitpark/DEPLOY_EASYPANEL.md`)
> — a identidade visual e o branding voltam para **Gleps**, mas TODAS as
> features novas (warmup, 18 endpoints de Integration, SLA V2, dashboards)
> seguem ativas neste mesmo deploy.

---

## Pré-requisitos

- VPS Linux com Docker e [EasyPanel](https://easypanel.io) já instalados.
- Domínio apontado para o IP da VPS (ex.: `gleps.com.br`, `app.gleps.com.br`,
  `api.gleps.com.br`).
- Acesso SSH à VPS (para debug eventual e backups).
- Branch `Variação-FitPark` publicada no GitHub
  (`https://github.com/glepsai-bit/gleps-crm.git`).
- (Opcional) Evolution API já no ar — credenciais ficam no banco, por conta,
  não em env. Ex.: `https://autevo.gleps.com.br`.
- (Opcional) Chave OpenAI/Anthropic se quiser ativar warmup com IA.

---

## Serviços necessários (criar no EasyPanel)

1. **PostgreSQL 16** (database `gleps_crm`).
2. **Backend Node 20** (Express + Prisma, porta interna `3000`).
3. **Frontend Static / Nginx** (build Vite, porta interna `80`,
   faz proxy de `/api` → `backend:3000`).
4. **Reverse proxy + SSL automático** (já incluso no EasyPanel via Traefik
   + Let’s Encrypt — não precisa criar manualmente).

> Tudo isso já está empacotado no `docker-compose.yml` da raiz do repositório.
> No EasyPanel, basta criar **1 app do tipo "Docker Compose"** apontando para
> esse arquivo — os 3 serviços sobem juntos.

---

## Variáveis de ambiente

### Backend

```env
# --- App ---
NODE_ENV=production
PORT=3000
API_URL=https://api.gleps.com.br
FRONTEND_URL=https://app.gleps.com.br
# CORS_ORIGINS opcional (vírgula-separado). Default usa FRONTEND_URL.
CORS_ORIGINS=https://app.gleps.com.br,https://gleps.com.br

# --- Banco (Postgres) ---
DB_USER=gleps
DB_PASSWORD=GERAR_SENHA_FORTE
DB_NAME=gleps_crm
# DATABASE_URL é montada pelo compose a partir das 3 acima.
# Se for usar Postgres externo, sobrescreva DATABASE_URL diretamente:
# DATABASE_URL=postgresql://gleps:STRONG_PASS@postgres:5432/gleps_crm?schema=public

# --- JWT (mínimo 32 chars cada — gere com `openssl rand -base64 32`) ---
JWT_SECRET=COLOQUE_32+_CHARS_RANDOM
JWT_EXPIRES_IN=1h
REFRESH_TOKEN_SECRET=COLOQUE_OUTRO_32+_CHARS_RANDOM
REFRESH_TOKEN_EXPIRES_IN=7d

# --- Segurança / Rate limit ---
BCRYPT_SALT_ROUNDS=12
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=100

# --- Seed inicial (rodar UMA vez no primeiro deploy) ---
RUN_SEED=true

# --- Opcionais ---
LOG_LEVEL=info
BUILD_VERSION=2026-06-28-gleps

# Google Calendar OAuth (opcional — fallback global; preferir por conta no DB)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://api.gleps.com.br/api/calendar/google/callback

# Prospecção Google Maps (opcional)
RAPIDAPI_KEY=

# Warmup com IA (opcional — pelo menos uma se quiser usar)
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# Mídia temporária (default: /tmp dentro do container)
TEMP_MEDIA_DIR=/app/uploads/tmp

# Compat legado (não usar em produção nova)
LEGACY_API_KEY_GOD_MODE=
```

> **Evolution API e Chatwoot NÃO vão em env.** As credenciais ficam no banco
> de dados, por conta (configuráveis pela UI do Super Admin / Admin → Inboxes).
> Isso permite multi-tenant com instâncias separadas por cliente.

### Frontend (build-time, embed no bundle Vite)

```env
VITE_USE_BACKEND=true
VITE_API_URL=/api
```

> Como o frontend e o backend ficam atrás do mesmo Nginx (frontend faz
> `proxy_pass /api → backend:3000`), `VITE_API_URL=/api` é o suficiente.
> Se for separar em domínios diferentes, use `VITE_API_URL=https://api.gleps.com.br`.

---

## Passo a passo

### 1. Criar o Postgres

Opção A — **usar o serviço `postgres` do `docker-compose.yml`** (recomendado
para começar):

- Nada a fazer manualmente — o compose já sobe `postgres:16-alpine` com volume
  persistente (`pgdata_v2`).
- Senha vem das envs `DB_USER`, `DB_PASSWORD`, `DB_NAME`.

Opção B — usar **Postgres gerenciado** do EasyPanel:

1. EasyPanel → **Services** → **PostgreSQL 16**
2. Database: `gleps_crm`, User: `gleps`, senha forte
3. Volume persistente: **ativar**
4. Pegue a connection string interna (`postgres://...@postgres:5432/...`)
   e sobrescreva `DATABASE_URL` nas envs do backend.

### 2. Deploy do backend

- Source: **GitHub repo**, branch `Variação-FitPark`.
- Build path: `./backend` (já tem `Dockerfile`).
- O Dockerfile já roda:
  ```
  npm install
  npx prisma generate
  npm run build
  ```
- Run command (já está em `scripts/start.sh`, chamado pelo `CMD` do Dockerfile):
  1. Aguarda o Postgres (`pg_isready` loop, 30 tentativas).
  2. `npx prisma migrate deploy` (com auto-recovery de P3009/P3018).
  3. Se `RUN_SEED=true`, roda `node dist/prisma/seed.js`.
  4. `node dist/server.js`.
- Porta interna: `3000`.
- Healthcheck: `wget http://localhost:3000/api/health` (start_period 60s).
- Domain interno: NÃO mapear domínio público para o backend — o frontend faz
  o proxy. Se quiser um subdomínio separado (`api.gleps.com.br`), aponte o
  domínio direto para o serviço `backend:3000`.

### 3. Deploy do frontend

- Source: mesma branch.
- Build path: `./` (raiz) + `Dockerfile.frontend`.
- Build args (já embutidos no Dockerfile, podem ser sobrescritos):
  - `VITE_API_URL=/api`
  - `VITE_USE_BACKEND=true`
- Stage 1 (builder): `npm install && npm run build` → gera `dist/`.
- Stage 2 (nginx): copia `dist/` para `/usr/share/nginx/html` e usa
  `nginx/default.conf.template` (substituição de `${BACKEND_UPSTREAM}` em
  runtime via `envsubst` do nginx:alpine).
- Porta interna: `80`.
- Domain público: `app.gleps.com.br` (ou apenas `gleps.com.br`).
- Headers de segurança já estão no template Nginx:
  `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`,
  `X-XSS-Protection: 1; mode=block`, gzip ativo.

### 4. DNS

- `A` record `app.gleps.com.br` → IP da VPS.
- (opcional) `A` record `api.gleps.com.br` → IP da VPS.
- (opcional) `A` record `gleps.com.br` (apex) → IP da VPS.
- Após o DNS propagar, EasyPanel emite **Let’s Encrypt automático** ao
  habilitar HTTPS no domínio.

### 5. Migrations

A cada novo deploy do backend, o `scripts/start.sh` **já executa**
`npx prisma migrate deploy` **antes** de subir o `node dist/server.js`.
Se uma migration travar em `P3009`/`P3018`, o script tenta `prisma migrate
resolve --rolled-back` automaticamente para 3 migrations conhecidas e
re-aplica. Em última instância, sobe o servidor mesmo com migrations parciais
para não derrubar o sistema (logs ficam visíveis no painel EasyPanel).

> **Nunca rode `prisma migrate dev` em produção.** Use sempre `migrate deploy`.

### 6. Backup

- **Diário automático via cron EasyPanel** (Settings → Backups), ou script SSH:
  ```bash
  docker exec gleps-postgres-1 pg_dump -U gleps gleps_crm \
    | gzip > /backup/gleps_$(date +%F).sql.gz
  ```
- Snapshot do volume `pgdata_v2` (botão "Backup Volume" no EasyPanel).
- **Retenção sugerida**: 7 dias diários + 4 semanais + 12 mensais.
- Teste a restauração pelo menos 1x por trimestre.

### 7. Monitoring

- **Logs**: aba "Logs" do EasyPanel mostra `stdout`/`stderr` em tempo real
  para cada serviço.
- **Healthchecks**: já configurados nos 3 serviços (compose).
- **Recomendado** (backlog do projeto): adicionar **Sentry** com
  `SENTRY_DSN` no backend e frontend para captura de erros.
- **Métricas internas**: dashboard `/insights` já mostra latência por inbox,
  SLA V2, backlog, conversões.

---

## Pós-deploy

### Trocar senhas dos usuários seed

O seed cria 2 usuários:

| Email                  | Senha       | Role          |
|------------------------|-------------|---------------|
| `admin@gleps.com.br`   | `Admin@123` | `admin`       |
| `super@gleps.com.br`   | `Admin@123` | `super_admin` |

**Troque AMBAS antes de liberar o sistema.**

Pelo painel:
- Login com `admin@gleps.com.br` → **Configurações → Conta → Trocar senha**.

Via psql (caso preciso resetar):
```sql
-- via psql ou EasyPanel SQL console
UPDATE users
   SET password_hash = '<hash bcrypt gerado abaixo>'
 WHERE email = 'admin@gleps.com.br';
```

Gerar o hash bcrypt:
```bash
node -e "console.log(require('bcryptjs').hashSync('SUA_SENHA_FORTE', 12))"
```

### Criar a primeira API key pro n8n

1. Login admin no painel.
2. **Configurações → API Keys → Nova chave**.
3. **Scopes** (selecionar conforme o uso do workflow n8n):
   - `chat:write` — enviar mensagens via WhatsApp.
   - `contacts:write` — criar/atualizar contatos.
   - `kanban:write` — mover cards de funil.
   - `campaigns:write` — disparar/atualizar campanhas.
4. Clique em "Gerar" → **copie a chave plaintext** (ela é mostrada **só 1 vez**).
5. No n8n, em todo workflow que chama o CRM, configure o header
   `x-api-key: <a chave>`.

### Configurar a Evolution API

1. **Configurações → Inboxes → Nova inbox**.
2. Tipo: **Evolution API**.
3. Cole a URL (`https://autevo.gleps.com.br`) e a API key da Evolution.
4. Crie a instance no Evolution, gere o QR code e escaneie com o WhatsApp.
5. Configure o **webhook da Evolution** para apontar para:
   `https://api.gleps.com.br/api/evolution/webhook/<accountId>`
   (o `<accountId>` aparece na tela da inbox no CRM).
6. Teste enviando uma mensagem para o número de teste
   `5534993383017` (ver memória) — não use telefones aleatórios.

### Configurar SLA com horário comercial

1. **Configurações → SLA Policies → Nova policy**.
2. Horário comercial (exemplo padrão):
   - Segunda–sábado, **08:00–20:00** (ajuste para o cliente final).
3. **Pausa quando aguarda cliente**: ativar (não conta tempo enquanto o
   contato é quem deve responder).
4. Definir limites por prioridade (P1/P2/P3) — primeira resposta e
   resolução.

---

## Troubleshooting

### Backend não sobe

- Conferir logs no EasyPanel (aba "Logs" do serviço `backend`).
- Causas comuns:
  - Env var obrigatória faltando (especialmente `JWT_SECRET`,
    `REFRESH_TOKEN_SECRET`, `DB_PASSWORD`).
  - `JWT_SECRET` ou `REFRESH_TOKEN_SECRET` com menos de 32 caracteres.
  - Migration travada (logs mostrarão `P3009` — o `start.sh` tenta
    auto-recovery).
- Healthcheck manual: `curl https://api.gleps.com.br/api/health` (deve
  retornar JSON com `status: "ok"`).

### Login retorna "Erro inesperado" / tela branca após login

- Quase sempre **`VITE_USE_BACKEND` ou `VITE_API_URL` não foi setado no build
  do frontend** — o bundle ficou apontando pro Supabase em vez do backend
  Express.
- Solução: **Rebuild do frontend** garantindo que os build args
  `VITE_USE_BACKEND=true` e `VITE_API_URL=/api` estejam presentes.
- Confirme abrindo o DevTools → Network → request de login deve ir para
  `/api/auth/login` (não para um domínio supabase).

### Mensagens WhatsApp não chegam

- Verifique no painel da Evolution se a instance está com estado `open`
  (conectada). Se ficar `close`, escaneie o QR code de novo.
- Verifique se o **webhook da Evolution** aponta para
  `https://api.gleps.com.br/api/evolution/webhook/<accountId>` e está
  habilitado para os eventos `messages.upsert` e `connection.update`.
- Confirme que a inbox no CRM foi cadastrada com o **mesmo nome de instance**
  da Evolution.
- Logs do backend mostram `📨 Evolution webhook recebido` para cada evento.

### Erro CORS no login

- `FRONTEND_URL` (ou `CORS_ORIGINS`) está incorreto.
- Deve ser a URL **exata**, com `https://`, **sem barra final**.
- Errado: `http://app.gleps.com.br/` — Certo: `https://app.gleps.com.br`.

### "Service is not reachable" no EasyPanel

- O domínio público deve estar mapeado para o serviço **`frontend`** na
  porta **`80`** — não direto no backend.
- Verifique a variável `BACKEND_UPSTREAM` do frontend (default `backend:3000`).

### Backend em loop de restart

- Postgres não healthy → conferir logs do `postgres`, senhas das envs `DB_*`.
- Healthcheck timeout → aumentar `start_period` no compose
  (default `60s`, pode subir para `120s` em banco grande / VPS pequena).

> Guia detalhado de diagnóstico: [`deploy/easypanel/diagnostics.md`](../deploy/easypanel/diagnostics.md).

---

## Checklist final

- [ ] Postgres up e `healthy`.
- [ ] Backend up e `healthy` (`https://api.gleps.com.br/api/health` retorna OK).
- [ ] Frontend up e `healthy` (`https://app.gleps.com.br` carrega a tela de
      login com identidade visual **Gleps**).
- [ ] Login com `admin@gleps.com.br` funciona.
- [ ] Senhas de `admin@gleps.com.br` **e** `super@gleps.com.br` trocadas.
- [ ] Evolution API conectada, instance com estado `open`, QR code escaneado.
- [ ] Pelo menos 1 API key criada para o n8n com os scopes necessários.
- [ ] SLA Policy configurada com o horário comercial do cliente.
- [ ] DNS propagado + SSL Let’s Encrypt ativo (`https://` sem aviso).
- [ ] Backup diário do Postgres configurado (cron ou EasyPanel Backups).
- [ ] Teste de envio para `5534993383017` confirmou recebimento no WhatsApp.

---

## Features ativas neste deploy (preservadas da Variação-FitPark)

Ainda que o branding volte a ser Gleps, **tudo o que foi construído na
Variação-FitPark continua disponível** neste mesmo deploy:

- **Warmup automático** de instâncias Evolution (opcionalmente com IA via
  `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`).
- **18 endpoints de Integration** para n8n
  (chat, contacts, kanban, campaigns, calendar, leads, métricas etc.).
- **SLA V2** com pausa em "aguarda cliente" e horário comercial configurável.
- **Dashboards** com métricas Chatwoot + métricas próprias (IA vs Humano,
  backlog, atendido/não atendido).
- **Dark mode completo** (T-006/T-007/T-008).

Não há flag para "desligar FitPark e ligar Gleps" — basta sobrescrever as
strings de branding, logo e tema; o resto da aplicação é compartilhado.
