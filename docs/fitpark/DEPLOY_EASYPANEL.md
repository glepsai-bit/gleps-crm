# T-022 FitPark — Deploy EasyPanel

## Branch
`Variação-FitPark` (27 commits, base `main@17d3beb`)

**Verify final:** prisma OK + tsc backend/frontend 0 erros + 59 BE tests + 36 FE tests + vite build 6s + chat E2E validado.

## Pré-requisitos
- EasyPanel rodando na sua VPS
- Domínio apontando pro IP da VPS (`fitpark.gleps.com.br` ou outro)
- Sua Evolution já no ar em `https://autevo.gleps.com.br` (api key `429683C4C977415CAAFCCE10F7D57E11`)

---

## Passo 1 — Push da branch no GitHub

```bash
# No seu Mac (ou onde clonou o repo)
cd /tmp/crm-fitpark
git push -u origin Variação-FitPark
```

## Passo 2 — Criar app Docker Compose no EasyPanel

1. EasyPanel → **+ New Service → App** → tipo **Docker Compose**
2. Nome: `fitpark-crm`
3. **Source:**
   - Git: `https://github.com/glepsai-bit/gleps-crm.git`
   - Branch: `Variação-FitPark`
   - Build path: `/` (raiz)
   - Compose file: `docker-compose.yml` ✅ (já existe e está correto)

## Passo 3 — Variáveis de ambiente (Environment)

Cola tudo isso de uma vez na aba **Environment**:

```env
# === Domínios ===
FRONTEND_URL=https://fitpark.gleps.com.br
API_URL=https://fitpark.gleps.com.br
CORS_ORIGINS=https://fitpark.gleps.com.br

# === Banco (gerado pelo Postgres do compose) ===
DB_USER=fitpark
DB_PASSWORD=COLOQUE_SENHA_FORTE_AQUI_32CHARS_MIN
DB_NAME=fitpark_crm

# === JWT (gerar 32+ chars aleatórios) ===
JWT_SECRET=GERE_32_CHARS_ALEATORIOS_AQUI_PROD
JWT_EXPIRES_IN=1h
REFRESH_TOKEN_SECRET=GERE_OUTROS_32_CHARS_DIFERENTES_PROD
REFRESH_TOKEN_EXPIRES_IN=7d

# === Outros ===
NODE_ENV=production
BCRYPT_SALT_ROUNDS=12
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=1000
LOG_LEVEL=info

# === Seed ===
# RUN_SEED=true cria superadmin@sistema.com / Admin@123 + contas demo
# DEPOIS de subir, troque pra false (em qualquer redeploy)
RUN_SEED=true

# === Opcionais (preencher se for usar) ===
RAPIDAPI_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://fitpark.gleps.com.br/auth/google/callback
```

**Pra gerar secrets fortes:**
```bash
openssl rand -hex 32   # roda 2x, um pra JWT_SECRET outro pra REFRESH_TOKEN_SECRET
openssl rand -hex 16   # pra DB_PASSWORD
```

## Passo 4 — Domínio

Na aba **Domains** do EasyPanel:
- Adicionar domínio: `fitpark.gleps.com.br`
- Mapear pro serviço **`frontend`** porta **`80`**
- ✅ HTTPS automático (Let's Encrypt)

## Passo 5 — Deploy

Clica **Deploy**. EasyPanel vai:
1. `git clone` da branch
2. Build dos 3 containers (`postgres`, `backend`, `frontend`)
3. Subir Postgres → backend roda migrations 0001-0028 automaticamente + seed
4. Frontend serve em `:80` com proxy `/api` pro backend

**Tempo: 3-7 min** (depende da VPS).

Logs no EasyPanel → ver "✅ Server running on port 3000" + "Migrations applied" no backend.

## Passo 6 — Login inicial

`https://fitpark.gleps.com.br/login`

Super Admin (do seed padrão):
- `superadmin@sistema.com` / `Admin@123`

Demo accounts criadas pelo seed (você pode deletar/reaproveitar):
- `admin@clinica.com` / `Admin@123`
- `joao@clinica.com` / `Agent@123`

**⚠️ TROQUE TODAS AS SENHAS** assim que logar.

## Passo 7 — Configurar Evolution global

1. Login super-admin
2. **Configurações → Configurações do Sistema** (`/super-admin/system-settings`)
3. Card "Provedor Evolution (WhatsApp)":
   - **URL Base:** `https://autevo.gleps.com.br`
   - **API Key:** `429683C4C977415CAAFCCE10F7D57E11`
   - **Webhook URL:** *(deixe vazio — derivado automaticamente de FRONTEND_URL)*
4. Clicar **"Testar Conexão"** → deve mostrar "X instâncias encontradas"
5. **Salvar**

## Passo 8 — Criar conta FitPark + admin do cliente

1. Super Admin → **Contas → + Nova Conta**
2. Nome: `FitPark Academia`
3. Plano: Premium (ou o que escolher)
4. Salvar
5. Entrar na conta → **Usuários → + Adicionar**
6. Email: `admin@fitpark.com.br` / Senha temporária / Role: `admin`

## Passo 9 — Conectar WhatsApp da academia

Cliente loga (`admin@fitpark.com.br`):
1. **Inboxes** → **+ Novo Canal**
2. Tipo: WhatsApp / Nome: `WhatsApp Atendimento` / Marca "Conectar agora"
3. Clica **Criar** → modal QR aparece
4. **WhatsApp do celular** → Configurações → Aparelhos conectados → Conectar → escaneia
5. Polling automático muda pra "Conectado" ✅

A Evolution é configurada pelo CRM automaticamente pra mandar webhook pra `https://fitpark.gleps.com.br/api/evolution/webhook/{accountId}` — tudo que chegar no WhatsApp aparece em `/admin/chat` em tempo real (Socket.IO).

---

## Pós-deploy: hardening

- [ ] Trocar senhas padrão (superadmin + admin)
- [ ] No segundo deploy, mudar `RUN_SEED=false` (não recria contas demo)
- [ ] Backup Postgres: configurar no EasyPanel (snapshots diários)
- [ ] Monitorar logs: `backend` deve mostrar webhooks chegando após scaneamento
- [ ] Se quiser HMAC strict no webhook (mais seguro): preencher `evolutionWebhookSecret` na conta + configurar Evolution pra mandar `x-crm-webhook-token` no header
- [ ] CORS_ORIGINS: validar que só domínios permitidos estão na lista

## Troubleshooting

| Sintoma | Causa provável | Fix |
|---|---|---|
| Frontend mostra "Cannot connect" | Backend ainda buildando | Aguarda mais 1-2min nos logs |
| "Invalid signature" no webhook | `evolutionWebhookSecret` preenchido + Evolution não manda HMAC | Limpa o secret OU configura Evolution pra enviar header `x-crm-webhook-token` |
| Login falha "Invalid credentials" | Seed não rodou | Verifica logs do backend; RUN_SEED=true; redeploy |
| Migration falha P3009 | Migration parcial anterior | Logs vão mostrar erro específico; `start.sh` tem auto-recovery |
| Webhook não chega | Evolution não alcança o CRM | Confirma `https://fitpark.gleps.com.br/api/health` acessível externamente |

## Endpoints úteis pra debug

```bash
# Health
curl https://fitpark.gleps.com.br/api/health

# Listar instâncias Evolution
curl -H "apikey: 429683C4C977415CAAFCCE10F7D57E11" https://autevo.gleps.com.br/instance/fetchInstances | jq '.[].name'

# Ver webhook configurado de uma instância
curl -H "apikey: 429683..." https://autevo.gleps.com.br/webhook/find/{instance-name}
```
