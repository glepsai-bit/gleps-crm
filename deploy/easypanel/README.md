# GLEPS CRM - Deploy no EasyPanel

> **IMPORTANTE**: O compose unificado está na **raiz do projeto** (`docker-compose.yml`).
> Este diretório contém apenas documentação de referência.

## Passo a Passo

### 1. Criar o App no EasyPanel

1. Acesse o painel do EasyPanel
2. Clique em **"Create App"** → **"Docker Compose"**
3. Aponte para o `docker-compose.yml` **na raiz** do repositório

### 2. Configurar Variáveis de Ambiente

No painel do EasyPanel, vá em **Environment Variables** e configure:

**⚠️ OBRIGATÓRIAS:**

| Variável | Exemplo |
|----------|---------|
| `DB_USER` | `gleps` |
| `DB_PASSWORD` | `SenhaForte123!` |
| `DB_NAME` | `gleps_crm` |
| `FRONTEND_URL` | `https://360.seudominio.com.br` |
| `JWT_SECRET` | (gere com `openssl rand -base64 32`) |
| `REFRESH_TOKEN_SECRET` | (gere com `openssl rand -base64 32`) |

**Opcionais (Google Calendar):**

> ⚠️ **IMPORTANTE**: No EasyPanel, configure as variáveis do Google Calendar no ambiente de produção do serviço `backend`.
> O `docker-compose.yml` não interpola mais essas chaves para evitar warnings falsos de "variable is not set" durante o deploy.
> O backend lê essas credenciais diretamente do ambiente em runtime ou da configuração da conta no banco.

| Variável | Descrição |
|----------|-----------|
| `GOOGLE_CLIENT_ID` | Client ID do Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Client Secret do Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `https://seudominio.com.br/api/calendar/google/callback` |

### 3. Mapear Domínio

1. No EasyPanel, vá no serviço **`frontend`**
2. Clique em **"Domains"**
3. Adicione seu domínio: `360.seudominio.com.br`
4. **Porta interna: `80`**
5. Ative HTTPS/SSL automático

> ⚠️ O domínio aponta APENAS para o `frontend`. O Nginx faz proxy automático de `/api` para o backend.

### 4. Deploy

Clique em **"Deploy"** ou **"Rebuild"** no EasyPanel.

---

## Credenciais Seed (primeiro acesso)

| Campo | Valor |
|-------|-------|
| Email | `admin@gleps.com` |
| Senha | `Admin@123` |

> ⚠️ **Troque a senha após o primeiro login!**

---

## Arquitetura de Rede

```
Internet → EasyPanel Proxy → frontend:80 (Nginx)
                                ├── / → Serve React SPA
                                ├── /api/* → proxy_pass → backend:3000
                                └── /health → 200 OK

backend:3000
  ├── /api/health → 200 OK
  ├── /api/auth/* → Autenticação
  └── /api/* → Demais rotas

postgres:5432
  └── Database gleps_crm
```

---

## Troubleshooting

Consulte `diagnostics.md` nesta pasta.
