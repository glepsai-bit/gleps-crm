# Quadro de tarefas — GLEPS CRM

> Fonte única de verdade do trabalho em andamento. Todos leem e atualizam.
> Formato do card: `- [ID] Título — @papel — branch: <branch> — (notas)`
> IDs sequenciais: T-001, T-002, ...

## 📋 A Fazer
- [T-004] **Dev Principal: contrato quebrado de stats de vendas (`/api/sales/stats` → 500)** — @dev-principal — O front (`src/api/endpoints.ts` `SALES.STATS = '/api/sales/stats'`, usado em `sales.service.ts:256` e `finance.backend.service.ts:110`) aponta para rota **inexistente**; o backend expõe `/api/sales/kpis`. Como `/stats` não existe, casa com `/:id` → `getById('stats')` → **500**. Hoje NÃO afeta a UI (o `FinanceContext` calcula KPIs no client, `useMemo` linha 772), por isso é **latente** — mas qualquer chamada a `salesService.getStats`/`getSaleKPIs` em backend mode quebra. Fix: corrigir o constant para `/api/sales/kpis` (ou adicionar `/stats` no backend). Detalhes no handoff QA 2026-06-01.
- [T-005] **Dev Principal: login/`/auth/me` retornam `chatwootApiKey` em texto puro** — @dev-principal — Avaliar não expor a API Key do Chatwoot no payload de auth (resposta de `POST /api/auth/login` e `GET /api/auth/me` traz `account.chatwootApiKey`). Risco baixo (só admin/super_admin vê), mas é credencial de integração trafegando à toa. Considerar omitir do response ou mascarar.

## 🔨 Fazendo
<!-- em desenvolvimento; máx 1-2 por papel -->

## 🧪 Em QA
<!-- aguardando validação do QA; PR aberto -->

## ✅ Feito
- [T-001] **QA: integração Chatwoot ponta a ponta — APROVADO (E2E em produção)** — @qa — Validado via API real na instância (login admin `administracao@mychooice.com`). Conta `MychooiceValidacaoFinal` agora tem **3 usuários** (Leandro/André/Amanda) com `chatwootAgentId` 1/2/3 batendo com `/api/chatwoot/agents` — agentes viraram usuários ativos. **Logou** como Leandro (agente importado). Multi-tenancy/authz OK (admin→403 em rotas super_admin; UUID aleatório→404; sem token→401). Ressalva: login de André/Amanda não testado (sem senhas) — só Leandro confirmado. 2026-06-01.
- [T-002] **Front: botão "Testar Conexão" em sucesso parece erro** — @frontend / @qa — Botão inteiro verde no sucesso / `text-destructive` no erro, nos dois modais. Validado no código (build/lint/testes ok). 2026-06-01.
- [T-003] **Front (CRÍTICO): importação de agentes no modal "Editar Conta"** — @frontend / @qa — Botão "Importar Agentes" + reuso do wizard via `editingAccount.id`. QA corrigiu foot-gun do "Voltar"/skip no fluxo de edição (`isEditImportMode`). Validado no código. 2026-06-01.
- [T-000] Estrutura inicial do time (agentes, board, convenções de git) — @dev-principal — 2026-05-21

---
### Backlog / ideias (não priorizado)
<!-- itens soltos a refinar depois -->
