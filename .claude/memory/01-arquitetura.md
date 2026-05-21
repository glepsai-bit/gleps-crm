# Arquitetura

## Visão geral

CRM multi-tenant white-label. Dois processos:

```
┌─────────────────────┐        ┌──────────────────────────┐
│  Frontend (Vite)    │  HTTP  │  Backend (Express)        │
│  React + shadcn     │───────▶│  Prisma → PostgreSQL      │
│  porta 8080         │        │  porta 3000               │
└─────────────────────┘        └──────────────────────────┘
          │                              │
          │ (modo Cloud)                 ├─ Chatwoot API (atendimento/WhatsApp)
          ▼                              ├─ Google Calendar OAuth
   Supabase Cloud                        ├─ RapidAPI (Google Maps scraping)
   (preview Lovable)                     ├─ SendGrid (e-mail)
                                         └─ OpenAI (geração de e-mail por IA)
```

## Dual data layer (importante)

Flag `VITE_USE_BACKEND` em [src/config/backend.config.ts](../../src/config/backend.config.ts):
- `true`  → frontend usa o **backend Express/Prisma** (produção VPS/EasyPanel)
- `false` → frontend usa **Supabase Cloud** diretamente (preview Lovable / dev)

Consequência prática: services no frontend frequentemente existem em três arquivos:
- `xxx.service.ts` — fachada que escolhe a implementação conforme a flag
- `xxx.backend.service.ts` — chama a API Express via [src/api/client.ts](../../src/api/client.ts)
- `xxx.cloud.service.ts` — chama o Supabase

Ao adicionar/alterar uma feature de dados, verificar **as duas implementações** se ambas estiverem em uso. O alvo de produção é o backend Express.

`AuthContext` segue o mesmo padrão: [AuthContext.tsx](../../src/contexts/AuthContext.tsx) (Supabase) vs [AuthContext.backend.tsx](../../src/contexts/AuthContext.backend.tsx) (Express). `App.tsx` seleciona o provider pela flag.

## Autenticação

- JWT access token (`JWT_EXPIRES_IN=1h`) + refresh token (`7d`), tabela `refresh_tokens`.
- Senhas com bcrypt (`BCRYPT_SALT_ROUNDS=12`).
- Middlewares backend: `authenticate`, `requireAccountId`, `requirePermission(...)` em [backend/src/middlewares/auth.middleware.ts](../../backend/src/middlewares/auth.middleware.ts).
- Frontend protege rotas com `ProtectedRoute` (`requireSuperAdmin` / `allowedRoles`).
- Seed cria super admins (ver [backend/src/prisma/seed.ts](../../backend/src/prisma/seed.ts)). Senha padrão de admins do seed: `Admin@123`.

## Backend — organização

Padrão clássico em camadas:
`routes/ → controllers/ → services/` + `middlewares/`, `config/`, `utils/`, `types/`.
20 controllers e 24 services. Registro central de rotas: [backend/src/routes/index.ts](../../backend/src/routes/index.ts), montadas sob `/api`.

Server bootstrap ([backend/src/server.ts](../../backend/src/server.ts)): conecta DB, inicia `metricsCollector`, e um **cron a cada 5 min** que processa a fila de cadências de e-mail (`emailService.processCadenceQueue()`). Helmet + CORS + rate limiting (limiter pula GET/HEAD/OPTIONS e webhooks).

## Deploy

- `Dockerfile.frontend` + `backend/Dockerfile` + [docker-compose.yml](../../docker-compose.yml).
- Nginx: [nginx/default.conf.template](../../nginx/default.conf.template).
- EasyPanel: instruções e diagnóstico em [deploy/easypanel/](../../deploy/easypanel/).
- Build version exposto em `/api/health`.
