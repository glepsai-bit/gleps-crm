# Quadro de tarefas — GLEPS CRM

> Fonte única de verdade do trabalho em andamento. Todos leem e atualizam.
> Formato do card: `- [ID] Título — @papel — branch: <branch> — (notas)`
> IDs sequenciais: T-001, T-002, ...

## 📋 A Fazer
<!-- novas tarefas entram aqui -->

## 🔨 Fazendo
<!-- em desenvolvimento; máx 1-2 por papel -->

## 🧪 Em QA
<!-- aguardando validação do QA; PR aberto -->

## ✅ Feito
- [T-004] **Dev Principal: SALES.STATS apontando para rota inexistente** — @dev-principal — Front (`src/api/endpoints.ts:75`) trocado de `/api/sales/stats` → `/api/sales/kpis`. Build/lint/test verde. 2026-06-01.
- [T-005] **Dev Principal: `chatwootApiKey` omitido do payload de auth** — @dev-principal — Campo removido da interface `LoginResult` e dos returns de `auth.service.ts` (`login` e `getMe`). Frontend não consumia o valor em backend mode (`hasChatwootConfig` já desconsidera; `useChatwootMetrics` só usa em Cloud mode via Supabase). Tsc/build/test verde. 2026-06-01.
- [T-001] **QA: integração Chatwoot ponta a ponta — APROVADO (E2E em produção)** — @qa — Validado via API real na instância (login admin `administracao@mychooice.com`). Conta `MychooiceValidacaoFinal` agora tem **3 usuários** (Leandro/André/Amanda) com `chatwootAgentId` 1/2/3 batendo com `/api/chatwoot/agents` — agentes viraram usuários ativos. **Logou** como Leandro (agente importado). Multi-tenancy/authz OK (admin→403 em rotas super_admin; UUID aleatório→404; sem token→401). Ressalva: login de André/Amanda não testado (sem senhas) — só Leandro confirmado. 2026-06-01.
- [T-002] **Front: botão "Testar Conexão" em sucesso parece erro** — @frontend / @qa — Botão inteiro verde no sucesso / `text-destructive` no erro, nos dois modais. Validado no código (build/lint/testes ok). 2026-06-01.
- [T-003] **Front (CRÍTICO): importação de agentes no modal "Editar Conta"** — @frontend / @qa — Botão "Importar Agentes" + reuso do wizard via `editingAccount.id`. QA corrigiu foot-gun do "Voltar"/skip no fluxo de edição (`isEditImportMode`). Validado no código. 2026-06-01.
- [T-000] Estrutura inicial do time (agentes, board, convenções de git) — @dev-principal — 2026-05-21

---
### Backlog / ideias (não priorizado)
<!-- itens soltos a refinar depois -->
