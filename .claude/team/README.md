# Time GLEPS CRM — Como trabalhamos

Estrutura compartilhada e versionada para que **todos os papéis tenham o mesmo acesso e entendimento**.
Modo de operação: **sessões paralelas** (uma por papel) coordenadas por este quadro + git.
As mesmas definições em `.claude/agents/` também permitem disparo pontual como subagente.

## Papéis e ownership (fronteiras)

| Papel | Quem | Domínio (edita) | Não edita |
|-------|------|-----------------|-----------|
| **Dev Principal** | sessão principal (lead/backend) | `/backend`, `backend/prisma/schema.prisma`, contratos de API, arquitetura, `.claude/memory/` | UI fina (delega ao Front) |
| **Front-end** | `.claude/agents/frontend.md` | `src/components`, `src/pages`, `src/layouts`, `src/hooks`(UI), estilos, `tailwind.config.ts` | `/backend`, schema Prisma |
| **QA** | `.claude/agents/qa.md` | testes (`*.test.ts`), validação, relatórios de bug | features (só reporta) |

Zona compartilhada (`src/services`, `src/api`, `src/contexts`): mudança de **contrato** é do Dev Principal; **consumo** é do Front. Combinar antes de alterar assinatura.

## Onboarding (todo papel lê antes de começar)
1. `CLAUDE.md` (raiz) — visão geral.
2. `.claude/memory/INDEX.md` + arquivos relevantes ao papel.
3. Este README + `board.md` (sua fila) + `handoff-log.md` (contexto recente).

## Fluxo de uma tarefa
```
A Fazer  →  Fazendo  →  Em QA  →  Feito
            (Front/Dev)  (QA)
              │            │
              ├─ branch    ├─ aprova → Feito + nota no handoff
              ├─ PR        └─ reprova → volta p/ Fazendo (bug detalhado)
              └─ handoff
```
- Pegou tarefa? Mova no `board.md` e ponha seu nome/papel.
- Terminou dev? PR + mova p/ "Em QA" + registre handoff (o que mudou, como testar).
- QA aprova → "Feito" e merge. Reprova → "Fazendo" com passos de reprodução.

## Convenção de git
- Branch por tarefa: `feat/<area>-<resumo>`, `fix/<area>-<resumo>`, `chore/...`, `test/...`. Ex.: `feat/kanban-filtro-nicho`.
- `main` é estável: só entra via PR aprovado pelo QA. Ninguém commita feature direto na `main`.
- Mensagens de commit em português, no imperativo: "adiciona filtro por nicho no Kanban".
- 1 tarefa do board ≈ 1 branch ≈ 1 PR. PR pequeno e revisável.
- **Nunca** commitar `.env*` (já no `.gitignore`). Confirmar com o usuário antes de `push` para remoto.

## Definição de pronto (DoD)
- `bun run lint` e `bun run build` limpos; testes relevantes passando.
- Não quebra os dois modos de dados (`VITE_USE_BACKEND` true/false).
- Multi-tenancy respeitado (sem vazamento entre contas).
- Mexeu em métrica? `docs/METRICAS_DASHBOARD.md` atualizado.
- Handoff registrado e card em "Feito".
