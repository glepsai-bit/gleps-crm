# Quadro de tarefas — GLEPS CRM

> Fonte única de verdade do trabalho em andamento. Todos leem e atualizam.
> Formato do card: `- [ID] Título — @papel — branch: <branch> — (notas)`
> IDs sequenciais: T-001, T-002, ...

## 🎯 T-022 FitPark — Variação cliente academia (branch `Variação-FitPark`)
> Sistema autônomo; n8n é opcional. Todo disparo passa pelo CRM (regra de ouro).
> Roadmap completo: [docs/fitpark/ROADMAP.md](../../docs/fitpark/ROADMAP.md)

### Sprint 1 — Evolution + ApiKey infra — ✅ COMMITADO (b115f15)
- [T-022.1.a] Schema Account.evolution* + model ApiKey + migration 0021 — @dev-principal — ✅
- [T-022.1.b] Backend services (evolution, api-key, middleware) — @dev-principal — ✅
- [T-022.1.c] Backend controllers/routes (evolution, api-key, account update) — @dev-principal — ✅
- [T-022.1.d] Frontend super-admin (Evolution config, QR code, ApiKeys page) — @dev-principal — ✅
- [T-022.1.e] QA: validar Sprint 1 end-to-end (curl + UI + testes vitest) — @qa — ✅ APROVADO COM RESSALVAS (2026-06-23, commit caa34a0)

### Sprint 2 — Campanhas WhatsApp + cron + API REST (em paralelo @dev-principal + @frontend)
- [T-022.2.a] Backend: `scheduledAt`/`source`/`triggerName`/`metadata` no DispatchBatch + migration 0022
- [T-022.2.b] Backend: cron scheduler 5min para campanhas agendadas
- [T-022.2.c] Backend: model + service + controller + routes WhatsappTemplate
- [T-022.2.d] Backend: transport Evolution no prospecting.service
- [T-022.2.e] Backend: API `POST /api/campaigns/send-single` + `send-batch`
- [T-022.2.f] Backend: API `GET /api/campaigns` + `GET /:id` + `GET /:id/logs`
- [T-022.2.g] Backend: API `GET /api/contatos?aniversario=&tag=&last_activity_before=`
- [T-022.2.h] Frontend: form de agendamento no DispatchDialog
- [T-022.2.i] Frontend: aba "Agendadas" no AdminExtracaoPage
- [T-022.2.j] Frontend: CRUD WhatsappTemplate
- [T-022.2.k] Frontend: Dashboard de campanha unificado (filtros source/trigger)

### Sprint 3 — Webhook genérico + Compliance + Anti-ban (planejado)
- Webhook OUTBOUND + INBOUND, `whatsapp_consents`, opt-out, rate-limit, página Integrações

### Sprint 4-7 — Chat interno paridade Chatwoot total (planejado)
Schema + endpoints + Socket.IO + UI completa + Teams/Departamentos + SLA + Custom Attrs + Migração

### Sprint final — Multi-instância Evolution + Hardening (planejado)

---

## 📋 A Fazer (legacy fora do T-022)
- [T-009] **Dev Principal: dev local não funciona como produção (login local quebrado)** — @dev-principal — **Sinalização do Front (não é da minha alçada resolver).** O usuário quer rodar local igual a produção e focar tudo em uma stack só, funcional. Observado: em produção/Docker o app usa Express, mas o `vite dev` local sobe em modo Supabase Cloud (o `.env` do front não tem `VITE_USE_BACKEND`), então não consigo logar no localhost com as credenciais de seed do Express. **Necessidade:** que o ambiente local funcione como o de prod (mesma tecnologia, login funcionando) — o caminho/arquitetura fica a seu critério. **Bloqueia:** a validação visual do dark mode pelo usuário, que só consegue logar localmente depois disto. Contexto no handoff [2026-06-14 dev local](handoff-log.md#2026-06-14-dev-local-prod). **UPDATE 2026-06-14:** o `.env` da raiz já tem `VITE_USE_BACKEND=true` e a stack local (Express :3000 + Postgres + Vite :8080) sobe → **login local funciona** e a validação do dark mode foi feita/mergeada. **Não bloqueia mais.** Resta só empacotar `npm run dev:stack` + `npm run qa:smoke:local` no package.json (rodar local = prod com um comando só).

<!-- novas tarefas entram aqui -->

## 🔨 Fazendo
<!-- em desenvolvimento; máx 1-2 por papel -->

## 🧪 Em QA
> **VALIDADO + MERGEADO NA MAIN (2026-06-14, Dev Principal por instrução do usuário)** — deploy pendente do usuário. Validação visual via Playwright (login claro/escuro, admin+super-admin, charts, toggle ao vivo, persistência, não-regressão @700px) + bateria verde: `tsc` ✅, `vitest` 36/36 ✅, `vite build` ✅, `eslint` nos arquivos do diff ✅, `qa:smoke` local 42/45 (3 falhas `/chatwoot/*` esperadas em local). Detalhes no handoff [2026-06-14 merge main](handoff-log.md#2026-06-14-darkmode-merge-main). Os 3 cards abaixo estão **concluídos**.
- [T-006] **Front: Dark Mode — Fase 1 (liga o interruptor)** — @frontend — branch: `feat/dark-mode` — `ThemeProvider` (next-themes, `defaultTheme="system"`) no App; `ThemeToggle` (Claro/Escuro/Sistema) no header mobile + rodapé da sidebar dos 2 layouts; fundo `<main>` → `bg-background`; **login agora segue a preferência do usuário** (removido force-dark; labels/card/logo theme-aware). Bug extra corrigido: botão "Entrar" usava `bg-gradient-primary`/`glow-primary` inexistentes (ficava transparente no tema claro) — classes definidas com tokens.
- [T-007] **Front: Dark Mode — Fase 2 (Charts adaptativos)** — @frontend — branch: `feat/dark-mode` — RevenueChart (grid/ticks/série), PaymentMethodChart (separador donut→`--card`), Resolução/IAvsHuman (track donut→`--muted`), BacklogCard (track barra). **Decisão tomada:** paleta de método de pagamento e azul-IA mantidos como **dado/categoria** (legíveis nos 2 temas; não há token azul e mapear p/ `--chart-1` deixaria a IA vermelha).
- [T-008] **Front: Dark Mode — Fase 3 (gaps de token + polimento)** — @frontend — branch: `feat/dark-mode` — overrides no `.dark`: `--chart-grid`, `--*-soft` (BacklogCard), `--role-admin/agent`, `--text-*`; `.glass`/`.glass-strong` tokenizados; `.shadow-card` ganha profundidade no dark; reserva do ScrollArea ajustada. **Pendência (precisa de você):** logo MyChooice tem só versão branca — no login usei um "chip" escuro p/ legibilidade; se quiser logo colorido no tema claro, precisa do SVG limpo. Favicon `prefers-color-scheme` ficou de fora (cosmético).

## ✅ Feito
- [T-004] **Dev Principal: SALES.STATS apontando para rota inexistente** — @dev-principal — Front (`src/api/endpoints.ts:75`) trocado de `/api/sales/stats` → `/api/sales/kpis`. Build/lint/test verde. 2026-06-01.
- [T-005] **Dev Principal: `chatwootApiKey` omitido do payload de auth** — @dev-principal — Campo removido da interface `LoginResult` e dos returns de `auth.service.ts` (`login` e `getMe`). Frontend não consumia o valor em backend mode (`hasChatwootConfig` já desconsidera; `useChatwootMetrics` só usa em Cloud mode via Supabase). Tsc/build/test verde. 2026-06-01.
- [T-001] **QA: integração Chatwoot ponta a ponta — APROVADO (E2E em produção)** — @qa — Validado via API real na instância (login admin `administracao@mychooice.com`). Conta `MychooiceValidacaoFinal` agora tem **3 usuários** (Leandro/André/Amanda) com `chatwootAgentId` 1/2/3 batendo com `/api/chatwoot/agents` — agentes viraram usuários ativos. **Logou** como Leandro (agente importado). Multi-tenancy/authz OK (admin→403 em rotas super_admin; UUID aleatório→404; sem token→401). Ressalva: login de André/Amanda não testado (sem senhas) — só Leandro confirmado. 2026-06-01.
- [T-002] **Front: botão "Testar Conexão" em sucesso parece erro** — @frontend / @qa — Botão inteiro verde no sucesso / `text-destructive` no erro, nos dois modais. Validado no código (build/lint/testes ok). 2026-06-01.
- [T-003] **Front (CRÍTICO): importação de agentes no modal "Editar Conta"** — @frontend / @qa — Botão "Importar Agentes" + reuso do wizard via `editingAccount.id`. QA corrigiu foot-gun do "Voltar"/skip no fluxo de edição (`isEditImportMode`). Validado no código. 2026-06-01.
- [T-000] Estrutura inicial do time (agentes, board, convenções de git) — @dev-principal — 2026-05-21

---
### Backlog / ideias (não priorizado)
<!-- T-007 e T-008 foram absorvidos no dark mode completo (em QA na branch feat/dark-mode) -->
- **Polimento opcional pós-dark-mode** (se o usuário quiser): logo MyChooice colorido p/ tema claro (precisa SVG limpo); favicon `prefers-color-scheme`; migrar variantes `success`/`warning` do `badge.tsx` para tokens (hoje hsl fixo, mas seguro nos 2 temas).
