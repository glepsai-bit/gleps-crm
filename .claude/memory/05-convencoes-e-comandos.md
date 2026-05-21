# Convenções, comandos e gotchas

## Comandos
```sh
# Frontend (raiz)
bun run dev          # vite, porta 8080
bun run build        # build de produção
bun run lint         # eslint
bun run test         # vitest (run); test:watch para watch

# Backend (/backend)
npm run dev          # servidor Express, porta 3000  (conferir package.json)
npx prisma migrate dev
```

## Convenções de código
- **Idioma do domínio em português**: `nome`, `telefone`, `valor`, `responsavel`, `origem`, `metodoPagamento`, `convenioNome`, etc. Manter o padrão existente; não anglicizar.
- **shadcn/ui**: componentes base em [src/components/ui/](../../src/components/ui/) — gerados, evitar editar à mão; usar [components.json](../../components.json) e o CLI quando precisar de novos.
- Alias `@/` → `src/` (ver tsconfig/vite.config).
- Formulários: react-hook-form + zod. Estado de servidor: TanStack Query.
- Toasts: `@/components/ui/toaster` (shadcn) e `sonner` ambos montados em App.tsx.

## Dual data layer (relembrar)
Ao tocar em qualquer feature de dados, verificar se ela existe em `*.backend.service.ts` e `*.cloud.service.ts`. Produção = backend Express (`VITE_USE_BACKEND=true`).

## Multi-tenancy
- Todo endpoint backend autenticado passa por `requireAccountId`. Nunca retornar dados de outra conta.
- Ao criar nova tabela/feature, incluir `accountId` + índice e relação com cascade.

## Rate limiting (backend)
- Limiter pula GET/HEAD/OPTIONS e prefixos de webhook + `/api/email`, `/api/audiences`, `/api/contacts`, `/api/dashboard`. Histórico: throttle agressivo já causou 429 derrubando POSTs do editor de e-mail — cuidado ao reativar.

## Webhooks (não throttlear)
`/api/chatwoot/webhook`, `/api/chatwoot/log-resolution`, `/api/email/webhook`, `/api/email/inbound`.

## Origem Lovable
- Projeto nasceu no Lovable; `lovable-tagger` no build dev, `@lovable.dev/cloud-auth-js`. README ainda é o template do Lovable.
- Planos/decisões históricas em [.lovable/](../../.lovable/) (plan.md, email-module-plan.md).

## Cuidados
- Segredos reais estão em `.env`, `.env.production`, `backend/.env` — **nunca commitar**. `.gitignore` cobre.
- Não é repositório git no momento (`git init` se for versionar). Confirmar com o usuário antes de commits/push.
- Mexeu em métricas? Atualizar [docs/METRICAS_DASHBOARD.md](../../docs/METRICAS_DASHBOARD.md).
