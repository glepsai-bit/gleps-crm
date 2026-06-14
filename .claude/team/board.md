# Quadro de tarefas — GLEPS CRM

> Fonte única de verdade do trabalho em andamento. Todos leem e atualizam.
> Formato do card: `- [ID] Título — @papel — branch: <branch> — (notas)`
> IDs sequenciais: T-001, T-002, ...

## 📋 A Fazer
- [T-006] **Front: Dark Mode — Fase 1 (MVP, "liga o interruptor")** — @frontend — branch: `feat/dark-mode-fase-1` — Habilita o dark mode end-to-end nas telas de navegação principal. Infra (tokens HSL, paleta dark já desenhada, `darkMode:['class']`, `next-themes` instalado) está pronta; falta plumbing + 2 fixes de fundo branco hardcoded nos layouts. **Esforço estimado: 4–6h.** Roteiro completo + arquivos exatos no handoff [2026-06-01 Dark Mode Auditoria](handoff-log.md#2026-06-01-dark-mode-auditoria). Resumo do que entrega: (1) `ThemeProvider` (next-themes, `attribute="class"`, `defaultTheme="light"`, `enableSystem`) envolvendo a árvore em `src/App.tsx`; (2) novo componente `ThemeToggle` (sun/moon) usando `useTheme` do next-themes — posicionar no header dos layouts Admin e SuperAdmin; (3) **bug real** em `src/layouts/AdminLayout.tsx:263`: trocar `style={{ backgroundColor: '#F8FAFC' }}` por `className="bg-background"`; (4) **bug real** em `src/layouts/SuperAdminLayout.tsx:237`: trocar `bg-white` por `bg-background`; (5) cleanup `src/pages/LoginPage.tsx:142,157` — `text-white/90` → `text-foreground/90` (página força `className="dark"` no wrapper L102, decidir se mantém ou remove o force-dark). Charts (Fase 2 / T-007) e marca (Fase 3 / T-008) ficam pendentes e podem renderizar "estranho" no dark — está dentro do escopo da Fase 1 deixar visível pra validação. **Critério de pronto:** dark mode liga via toggle; tema persiste (localStorage do next-themes); Sonner respeita o tema (já chama `useTheme` em `ui/sonner.tsx`); todas rotas principais (`/admin`, `/admin/kanban`, `/admin/leads`, `/admin/sales`, `/admin/finance`, `/admin/products`, `/admin/agenda`, `/admin/insights`, `/admin/emails`, `/super-admin/*`) renderizam com chrome coerente no dark; `bun run build` e `bun run test` limpos.

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
- [T-007] **Front: Dark Mode — Fase 2 (Charts adaptativos)** — @frontend — Refactor de 6 arquivos para que charts/donuts respondam ao tema. Esforço estimado 6–10h. Depende de T-006 entregue e validado. **Decisão de design pendente do usuário:** paleta categórica dos métodos de pagamento (PIX/débito/crédito/boleto/dinheiro/convênio) — manter cores fixas (legibilidade de dado) ou tokenizar em `--chart-N` (adaptativo)? Detalhes em `handoff-log.md` (auditoria).
- [T-008] **Front: Dark Mode — Fase 3 (Marca + polimento)** — @frontend — Logos com variante dark ou `currentColor`, tokens `--success`/`--warning`/`--overlay`, cleanup `badge`/`button`/`input`, `.shadow-card` adaptativa, favicon `prefers-color-scheme`. Esforço estimado 4–6h. Depende de T-006 entregue. **Depende também:** SVG limpo do MyChooice (o atual é A4 print com 3 versões empilhadas + plate preto — workaround possível com `currentColor` mas perde a cor `#EE3924` da marca).
