# Quadro de tarefas — GLEPS CRM

> Fonte única de verdade do trabalho em andamento. Todos leem e atualizam.
> Formato do card: `- [ID] Título — @papel — branch: <branch> — (notas)`
> IDs sequenciais: T-001, T-002, ...

## 📋 A Fazer
<!-- novas tarefas entram aqui -->

## 🔨 Fazendo
<!-- em desenvolvimento; máx 1-2 por papel -->

## 🧪 Em QA
- [T-001] **QA: validar integração Chatwoot ponta a ponta (E2E pós-deploy)** — @qa — branch: `feat/edit-account-import-agents` — **Camada de código APROVADA** (build/lint/testes + revisão estática — ver handoff 2026-06-01 QA). Falta a validação funcional dos Cenários A–D na instância: agentes do Chatwoot → usuários que **conseguem logar** + isolamento multi-tenant. Aguardando redeploy no EasyPanel + acesso (contas/URL) para QA testar como usuário. Roteiro em [handoff-log.md](handoff-log.md#2026-05-31-correção-de-escopo).

## ✅ Feito
- [T-002] **Front: botão "Testar Conexão" em sucesso parece erro** — @frontend / @qa — Botão inteiro verde no sucesso / `text-destructive` no erro, nos dois modais. Validado no código (build/lint/testes ok). 2026-06-01.
- [T-003] **Front (CRÍTICO): importação de agentes no modal "Editar Conta"** — @frontend / @qa — Botão "Importar Agentes" + reuso do wizard via `editingAccount.id`. QA corrigiu foot-gun do "Voltar"/skip no fluxo de edição (`isEditImportMode`). Validado no código. 2026-06-01.
- [T-000] Estrutura inicial do time (agentes, board, convenções de git) — @dev-principal — 2026-05-21

---
### Backlog / ideias (não priorizado)
<!-- itens soltos a refinar depois -->
