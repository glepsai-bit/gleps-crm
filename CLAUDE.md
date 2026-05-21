# GLEPS CRM — Guia do Projeto (CLAUDE.md)

> CRM multi-tenant white-label com integração Chatwoot (WhatsApp/atendimento),
> prospecção via Google Maps, cadências de e-mail e Google Calendar.
> Originado no Lovable; roda em produção via Docker/EasyPanel sobre backend Express próprio.

Este arquivo é o ponto de entrada. Notas detalhadas vivem em [.claude/memory/](.claude/memory/INDEX.md).

## Time (3 papéis)
Trabalhamos em sessões paralelas coordenadas por quadro + git. Antes de começar, leia [.claude/team/README.md](.claude/team/README.md).
- **Dev Principal** (sessão lead/backend) — `/backend`, schema Prisma, contratos de API, arquitetura.
- **Front-end** — [.claude/agents/frontend.md](.claude/agents/frontend.md) — `/src` (UI).
- **QA** — [.claude/agents/qa.md](.claude/agents/qa.md) — testes e validação antes do merge.

Fila de trabalho: [.claude/team/board.md](.claude/team/board.md). Handoffs: [.claude/team/handoff-log.md](.claude/team/handoff-log.md).

---

## Stack

**Frontend** (`/src`): Vite + React 18 + TypeScript + shadcn/ui (Radix) + Tailwind + React Router v6 + TanStack Query + react-hook-form/zod. Gerenciador: **bun** (`bun.lockb`) e npm (`package-lock.json`).

**Backend** (`/backend`): Node + Express + TypeScript + Prisma + PostgreSQL. Auth JWT (access + refresh token). Cron interno para cadências de e-mail.

**Dual data layer**: o frontend pode falar com o **backend Express** OU com o **Supabase Cloud**, controlado pela flag `VITE_USE_BACKEND` ([src/config/backend.config.ts](src/config/backend.config.ts)). Produção (EasyPanel/VPS) = Express; preview Lovable = Supabase. Por isso muitos services têm variantes `*.backend.service.ts` e `*.cloud.service.ts`.

---

## Como rodar

```sh
# Frontend (porta 8080)
bun install        # ou npm i
bun run dev        # vite

# Backend (porta 3000)
cd backend
npm install
npx prisma migrate dev      # aplica migrations
npm run dev                 # ver backend/package.json para script exato

# Testes (frontend)
bun run test                # vitest

# Stack completa
docker compose up           # ver docker-compose.yml
```

Variáveis de ambiente: ver [.env.example](.env.example) (frontend) e [backend/.env.example](backend/.env.example).

---

## Mapa rápido

| Área | Frontend | Backend |
|------|----------|---------|
| Rotas/navegação | [src/App.tsx](src/App.tsx) | [backend/src/routes/index.ts](backend/src/routes/index.ts) |
| Auth | [src/contexts/AuthContext.tsx](src/contexts/AuthContext.tsx) + `.backend.tsx` | [backend/src/services/auth.service.ts](backend/src/services/auth.service.ts) |
| Cliente HTTP | [src/api/client.ts](src/api/client.ts), [src/api/endpoints.ts](src/api/endpoints.ts) | — |
| Permissões | [src/config/permissions.config.ts](src/config/permissions.config.ts) | [backend/src/middlewares/auth.middleware.ts](backend/src/middlewares/auth.middleware.ts) |
| Modelo de dados | — | [backend/prisma/schema.prisma](backend/prisma/schema.prisma) |

---

## Papéis e módulos

3 papéis: `super_admin` (gerencia contas/tenants), `admin` (dono da conta), `agent` (permissões granulares por usuário).

Módulos principais: **Kanban/Leads** (estágios de funil + tags), **Vendas/Financeiro/Produtos**, **Agenda** (Google Calendar), **Insights/Dashboard** (métricas Chatwoot), **Prospecção/Extração** (Google Maps via RapidAPI + disparo em massa), **E-mails** (cadências, templates, campanhas, audiências, inbox).

Detalhes módulo a módulo: [.claude/memory/02-modulos.md](.claude/memory/02-modulos.md).

---

## Convenções importantes

- **Multi-tenancy**: quase toda tabela tem `accountId`. Toda query/endpoint deve ser escopada por conta. Middleware `requireAccountId` no backend.
- **Idioma**: domínio em **português** (nome, telefone, valor, responsavel, origem...). Mantenha os nomes existentes.
- **Prisma**: campos camelCase no client, `@map` para snake_case no Postgres.
- **Sync Chatwoot**: estratégia "create-or-update-v2" (não usa upsert). Tags do CRM espelham labels do Chatwoot; conversas resolvidas geram `resolution_logs`.
- Ao mexer em métricas do dashboard, consultar [docs/METRICAS_DASHBOARD.md](docs/METRICAS_DASHBOARD.md) — é a fonte de verdade das regras de cálculo.

---

## Antes de commitar
- Rodar `bun run lint` e `bun run test`.
- Não commitar `.env`. Confirmar com o usuário antes de qualquer commit/push.
