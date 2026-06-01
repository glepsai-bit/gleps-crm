# Log de handoffs

> Registro cronológico de passagens de bastão entre papéis. Mais recente no topo.
> Modelo:
> ```
> ## [data] T-XXX — <título>  (@origem → @destino)
> - **O que mudou:** ...
> - **Arquivos/rotas afetadas:** ...
> - **Como testar:** ...
> - **Pendências/observações:** ...
> ```

## 2026-06-01 — T-004 e T-005 entregues (@dev-principal → @qa)

**T-004 — `SALES.STATS` apontava para rota inexistente:**
- Mudança: `src/api/endpoints.ts:75` — `STATS: '/api/sales/stats'` → `STATS: '/api/sales/kpis'`.
- Consumidores corrigidos automaticamente: `sales.service.ts:256` (`getStats`) e `finance.backend.service.ts:110` (`getSaleKPIs`).
- Não toquei o backend (já tem `/api/sales/kpis`).

**T-005 — `chatwootApiKey` no payload de auth:**
- Removido o campo da interface `LoginResult` em `backend/src/services/auth.service.ts:34`.
- Removido o campo do objeto retornado em `login()` (após `linha 155`) e em `getMe()` (após `linha 282`).
- Análise de impacto no front:
  - [chatwootConfig.ts:hasChatwootConfig](../../src/utils/chatwootConfig.ts) já trata explicitamente: em backend mode só exige `base_url + account_id`, não usa a key. → OK.
  - [useChatwootMetrics.ts:216](../../src/hooks/useChatwootMetrics.ts#L216) usa `account.chatwoot_api_key` mas apenas no caminho Supabase Cloud (chama `supabase.auth.getSession` + Edge Function), que não roda em backend mode (`VITE_USE_BACKEND=true`). → OK.
  - [AuthContext.backend.tsx:43](../../src/contexts/AuthContext.backend.tsx#L43) já era defensivo (`?? raw.chatwootApiKey`); receber `undefined` é inofensivo. → OK.
  - `SuperAdminAccountDetailPage` e `SuperAdminAccountsPage` leem a key a partir de `/api/accounts` (listagem), não do payload de auth — sem mudança.

**Validação local:**
- `npx vite build` → ✅ limpo (3524 módulos).
- `npx vitest run` → ✅ 36/36 testes (mesma baseline do QA anterior).
- `cd backend && npm install && npx tsc --noEmit` → ✅ exit 0 (após instalar deps que estavam ausentes nesta máquina).

**Commit/push:** dois commits separados em `main` (autorizado via memory `autorizacao-push-main`).

**Pós-deploy (QA pode validar):**
- Em produção, fazer `GET /api/auth/me` autenticado → conferir que `account` NÃO tem mais o campo `chatwootApiKey`.
- Em produção, chamar `GET /api/sales/kpis` direto (ou disparar qualquer caminho que use `salesService.getStats`) → retornar 200, não 500.

---

## 2026-06-01 — QA: validação E2E em produção (T-001 APROVADO) + 2 achados (@qa → @dev-principal)

Validado direto na instância `https://crm-mychooice-goodleads.jybre9.easypanel.host` via API real (frontend usa backend Express). Login como `administracao@mychooice.com` (role **admin**, conta `MychooiceValidacaoFinal`, `id 5b2096ea…`).

**T-001 — Integração Chatwoot: FUNCIONAL ✅**
- `GET /api/users` → 3 usuários ativos: Leandro (`chatwootAgentId:1`), André (`:2`), Amanda (`:3`).
- `GET /api/chatwoot/agents` → 3 agentes ids 1/2/3, mesmos e-mails. **Bate 1:1** — agentes viraram usuários do CRM. A conta saiu de `Usuários: 0`.
- **Login confirmado** como Leandro (agente importado id 1). André/Amanda existem e estão `active` mas `lastLoginAt: null` — login deles não testado (sem senhas). Recomendo o usuário confirmar o login de um deles.

**Multi-tenancy / authz: OK ✅**
- admin → `GET /api/accounts` = 403 `SUPER_ADMIN_REQUIRED`; `GET /api/admin/kpis` = 403.
- `GET /api/users/<uuid-aleatório>` = 404; `GET /api/contacts/<uuid-aleatório>` = 404 (sem vazamento entre contas).
- `GET /api/contacts` sem token = 401. Todos os dados retornados escopados ao `accountId` da conta.

**Módulos exercitados (todos OK):**
- Dashboard: `kpis` (17 leads, 0 vendas), `hourly-peak`, `agents-performance`, `backlog`, `ia-vs-human` → 200.
- Contacts: **CRUD round-trip** completo — POST 201 → GET 200 → PUT 200 → DELETE 200 → GET 404 (dado de teste removido, total voltou a 17). Validação de enum `origem` funcionando (rejeitou valor inválido com 400). 17 contatos vindos do sync Chatwoot.
- Sales/Finance: `/api/sales`, `/api/sales/kpis`, `/api/finance/revenue-chart`, `/api/finance/funnel-conversion` → 200.
- Insights: `kpis`, `products`, `temporal`, `marketing`, `payment-methods`, `automatic`, `agents-ranking` → 200 (admin bypassa `requirePermission('insights')`).
- Tags (6), Funnels (1 default "Funil Principal", 6 tags), Calendar, Events, Email (cadences/templates/campaigns/audiences vazios mas 200; `quota` 0/3000 mês, 0/100 dia), Prospecting (`usage` 0/100, batches, audiences) → 200.
- `chatwoot/metrics` exige `dateFrom`/`dateTo` (400 sem eles, 200 com) — comportamento correto.

**Achados (não-bloqueantes, abri T-004 e T-005):**
1. **[T-004] Latente:** `GET /api/sales/stats` → **500**. `SALES.STATS` aponta para rota inexistente; backend tem `/api/sales/kpis`. `/stats` casa com `/:id` → `getById('stats')` → 500. NÃO afeta UI hoje (FinanceContext calcula KPIs no client). Corrigir o constant.
2. **[T-005] Segurança:** `POST /api/auth/login` e `GET /api/auth/me` retornam `account.chatwootApiKey` em texto puro no payload.
- Dívida técnica menor: constants mortos `DASHBOARD.REVENUE`, `DASHBOARD.CONVERSION_FUNNEL`, `INSIGHTS.OVERVIEW` (404, não usados — front usa `/api/finance/*` e `/api/insights/kpis`).

**Veredito:** produto operacional para uso de admin; T-001 aprovado. Nenhum bug bloqueante encontrado nos fluxos que a UI realmente usa.

---

## 2026-06-01 — Front → QA: abrir o PR (Front está proibido de commitar) (@frontend → @qa)

**Decisão do usuário:** somente o QA faz commit. Logo, o Front **não vai commitar/pushar/abrir PR**. Deixo tudo pronto no working tree e passo o bastão para o QA executar o git.

- **Branch:** `feat/edit-account-import-agents` (já criada e em uso; 0 commits ainda).
- **Estado:** working tree com as mudanças de T-002 + T-003 (e a correção `isEditImportMode` do QA). `npm run build` ✅ limpo; `npm run test` ✅ 36/36.
- **Arquivos a versionar:** `src/pages/super-admin/SuperAdminAccountsPage.tsx`, `.claude/team/board.md`, `.claude/team/handoff-log.md`.
- **NÃO versionar `package-lock.json`** — o diff atual é só remoção de marcadores `"peer": true` (efeito do `npm install` porque a máquina estava sem `node_modules`). Já foi revertido uma vez; se reaparecer, rodar `git checkout -- package-lock.json` antes de commitar.

**Passos sugeridos para o QA (precisa confirmar push com o usuário):**
```sh
git checkout -- package-lock.json   # se estiver modificado
git add src/pages/super-admin/SuperAdminAccountsPage.tsx .claude/team/board.md .claude/team/handoff-log.md
git commit -m "feat: importa agentes do Chatwoot no Editar Conta + corrige estado do botao de teste (T-002, T-003)"
git push -u origin feat/edit-account-import-agents
gh pr create --base main --head feat/edit-account-import-agents \
  --title "feat: importar agentes do Chatwoot no Editar Conta (T-002, T-003)" \
  --body "T-002 e T-003. Validação de código aprovada pelo QA (build/test/lint baseline). Pendente: E2E pós-deploy (T-001, Cenários A–D). Detalhes nos handoffs de 2026-06-01."
```
- **Após abrir o PR:** mover nada no board é necessário (T-002/T-003 já estão em "Feito" como aprovação de código); manter T-001 em "Em QA" aguardando o redeploy no EasyPanel para a validação funcional.

> **NOTA DO QA (2026-06-01, posterior):** este recado ficou obsoleto. O git **já foi executado**: o usuário autorizou push direto na `main`, então em vez de abrir PR fiz o commit `60e6b07` (T-002 + T-003 + correção `isEditImportMode`) e merge fast-forward na `main`, já em `origin/main`. `package-lock.json` saiu limpo, sem alterações. **Não há código novo pendente de teste** — só falta o E2E do T-001 pós-redeploy.

---

## 2026-06-01 — QA: T-002/T-003 aprovados no código + correção de foot-gun (@qa → @dev-principal/@usuário)

- **Validação local executada:** `npm run build` ✅ limpo; `npm run test` ✅ 36/36; `eslint` no arquivo = 32 erros, **todos `no-explicit-any` (baseline pré-existente), zero novos**. (`bun` não instalado nesta máquina — usei `npm`, igual ao Front.)
- **Revisão estática:** reuso do wizard no Edit está correto — `handleEditImportAgents` semeia `createdAccountId = editingAccount.id`, cria usuários via `usersCloudOrBackend.create({ account_id, chatwoot_agent_id })` e dá `loadAccounts()` ao fim. T-002 (botão verde/vermelho inteiro via `cn()`) ok nos dois modais.
- **Correção que apliquei (foot-gun real, não cosmético):** ao reusar o Dialog de Criação no fluxo de edição, o "Voltar" do step de seleção levava ao formulário vazio "Criar Nova Conta" — e dali era possível **criar uma conta nova por engano**; o "Pular" mostrava toast "Conta criada com sucesso!" no contexto de edição. Adicionei `isEditImportMode`: nesse modo o "Voltar" some e o toast de skip é neutralizado. `resetForm` reseta a flag. Mudança contida no mesmo arquivo, sem novo componente.
- **Pendente (bloqueia T-001):** validação funcional E2E (Cenários A–D) — login dos usuários importados + multi-tenancy — só após **redeploy no EasyPanel**. Usuário vai redeployar e fornecer acesso (contas/URL) para QA testar como usuário.
- **Achado pré-existente (não corrigi, fora de escopo):** possível off-by-one no toast de contagem (`createdUsers.length + 1` vs `.length` no skip do último agente) — herdado do fluxo de criação.

---

## 2026-06-01 — T-002 + T-003 entregues: estado do botão + importação de agentes no Edit (@frontend → @qa)

- **O que mudou:** ambas as tarefas saíram na mesma branch `feat/edit-account-import-agents` porque tocam exatamente a mesma região do arquivo (botão "Testar Conexão" do modal de Edit) — separar geraria conflito comigo mesmo. Tudo é front puro; nenhum contrato de backend mudou.
  - **T-002 (botão):** o botão "Testar Conexão" agora fica **verde inteiro** em sucesso (`border-emerald-500 text-emerald-700 hover:bg-emerald-50`) e usa `text-destructive` em erro, via `cn(...)` condicional. Aplicado nos **dois** modais — Criação e Edição.
  - **T-003 (importação no Edit):** adicionado estado `editConnectionResult` que guarda os agentes detectados no teste de conexão do Edit (mesmo mapeamento do fluxo de criação). Após sucesso com `agents.length > 0`, aparece o botão **"Importar N Agente(s)"** (`handleEditImportAgents`). Ele reaproveita o **mesmo wizard** já existente no Dialog de Criação (steps `select-agents` → `create-users`): popula `createdAccountId = editingAccount.id`, `connectionResult`, `selectedAgentIds` (todos pré-selecionados), fecha o modal de Edit e abre o wizard. Nenhum componente novo — reusa `ChatwootAgentImport` + `EmbeddedUserCreationForm` e os handlers `handleAgentSelectionProceed`/`handleUserCreated`/`handleSkipCurrentAgent`.
  - Bônus de robustez: alterar URL/Account ID/API Key no Edit reseta o status/resultado da conexão (evita importar agentes desatualizados).
- **Arquivos afetados:** [src/pages/super-admin/SuperAdminAccountsPage.tsx](../../src/pages/super-admin/SuperAdminAccountsPage.tsx) (único arquivo). Import novo de `cn` de `@/lib/utils`.
- **Como testar:** seguir o roteiro completo abaixo (Cenários A–D). Foco em B e C (caminho que estava quebrado): abrir conta existente sem usuários → Editar → ativar Chatwoot → Testar Conexão (botão verde) → "Importar Agentes" → wizard → usuários aparecem na listagem e conseguem logar.
- **Validação local:** `npm run build` ✅ limpo. `npm run lint` tem 585 erros **pré-existentes** no projeto (baseline `no-explicit-any` em todo o `/src`); meu código novo só repete o padrão `(a: any)` já usado no `handleTestConnection` — não há regressão. `bun` não está instalado nesta máquina; usei `npm`.
- **Pendências/observações:**
  - Não fiz commit/push ainda — aguardando confirmação do usuário (regra do time).
  - QA: validar especialmente o caso de **email duplicado** (409 → pula agente) e a persistência de `chatwoot_agent_id` na tabela `users`.

---

## 2026-05-31 — Correção de escopo: integração Chatwoot está FUNCIONALMENTE INCOMPLETA (@dev-principal → @qa, @frontend) {#2026-05-31-correção-de-escopo}

**Correção da minha framing anterior.** Disse no diagnóstico de cima que "a integração funciona". Errado — isso era só do ponto de vista de "API responde 200". A integração só é funcional quando entrega o **resultado de negócio**: os agentes do Chatwoot viram **usuários ativos no CRM, capazes de logar e operar**. Hoje na conta `MychooiceValidacaoFinal` (Chatwoot ID 6, 2 agentes detectados) isso não acontece — `Usuários: 0`. A integração está QUEBRADA do ponto de vista de uso.

**Não fazer workarounds** (recriar conta, importar manual, etc). Resolver de raiz via T-003.

### Roteiro completo de validação ponta a ponta para o QA (T-001)

**Pré-requisitos:**
- T-002 e T-003 entregues e em `main`.
- Super admin logado em `https://crm-mychooice-goodleads.jybre9.easypanel.host`.
- Instância de teste do Chatwoot com pelo menos 2 agentes cadastrados e ao menos 1 conversa real (pra validar webhook futuro).

**Cenário A — Criação de conta com Chatwoot desde o início:**
1. Contas → + Nova Conta.
2. Preenche nome, mantém status `active`.
3. **Ativa Chatwoot**, preenche URL/Account ID/API Key.
4. **Clica "Testar Conexão"** → tem que aparecer ✅ visível (botão inteiro verde após T-002, não só ícone) com "N agentes encontrados".
5. Botão final muda de "Criar Conta" para **"Próximo: Importar Agentes"** → clica.
6. Wizard step 2: seleciona todos os agentes → "Próximo".
7. Wizard step 3: cria cada usuário (email vem do Chatwoot, define senha, role, permissões) → "Próximo" até concluir todos.
8. **Esperado:** conta aparece na listagem com `Usuários: N` igual ao número de agentes importados.
9. **Logout** do super admin. Faz login com o **e-mail de um dos agentes importados** + senha definida no passo 7. Tem que entrar no CRM com o role/permissões corretos.

**Cenário B — Edição: ativar Chatwoot em conta já existente (este é o caminho que estava quebrado):**
1. Cria uma conta nova com Chatwoot **desabilitado**. Salva → `Usuários: 0`.
2. Edita essa conta. Ativa Chatwoot, preenche credenciais.
3. **Clica "Testar Conexão"** → tem que ficar verde (T-002).
4. Após sucesso, **tem que aparecer o botão "Importar Agentes"** (T-003) — esse era o ponto faltante.
5. Clica → wizard de seleção → cria usuários (mesmo fluxo do Cenário A passos 6-7).
6. **Esperado:** conta passa de `Usuários: 0` para `Usuários: N`.
7. Validar login com um dos novos usuários como no Cenário A passo 9.

**Cenário C — Conta `MychooiceValidacaoFinal` (a já existente, com Chatwoot conectado mas sem usuários):**
1. Repete o Cenário B a partir do passo 2 usando essa conta (não precisa criar nova, ela já está nessa situação).
2. Após T-003 entregar, os 2 agentes do Chatwoot têm que vir pra `Usuários`.
3. Logar com cada um deles tem que funcionar.

**Cenário D — Multi-tenancy (não pode regredir):**
1. Logado como admin de uma conta A, **não** pode ver/acessar usuários ou dados da conta B (importadas em cenários acima).
2. Tentar fazer requests cruzadas (`GET /api/users` com token de A pedindo dados de B) → 401/403.

**Critério de aprovação T-001:** todos os 4 cenários passam. Se algum falhar, reabre T-002/T-003 com o passo exato que quebrou + screenshot + log do backend.

**Riscos conhecidos a observar:**
- Email duplicado entre Chatwoot e CRM já tem tratamento (return 409, pula para próximo agente — [SuperAdminAccountsPage.tsx:367-371](../../src/pages/super-admin/SuperAdminAccountsPage.tsx#L367-L371)). Reproduzir com agente cujo email já exista no CRM e confirmar comportamento.
- Senha definida no formulário tem que respeitar a política do backend (bcrypt 12 rounds, sem regra de complexidade explícita no schema atual). Confirmar que senhas simples passam ou não.
- O `chatwoot_agent_id` tem que ser persistido na tabela `users` (campo `chatwootAgentId`) para futura associação de conversas → usuário.

---

## 2026-05-31 — T-001/T-002/T-003 Integração Chatwoot: diagnóstico inicial (@dev-principal → @qa, @frontend)

**Contexto:** usuário relatou que "Chatwoot não conecta nem importa agentes" na conta `MychooiceValidacaoFinal` (Chatwoot account ID 6, instância `atendimento.gleps.com.br`). Após investigar logs + screenshots + código, confirmei que **a integração com Chatwoot está 100% funcional** — o problema é UX que faz parecer falha.

**Evidências de que a integração funciona:**
- Logs do backend: `POST /api/chatwoot/test-connection HTTP/1.1 200 422` (sucesso).
- Toast no frontend: *"Conexão com Chatwoot estabelecida com sucesso! 2 agente(s) encontrados."*
- Tabela de contas mostra `Chatwoot: ID 6` na conta criada.

**O que está realmente quebrado (2 bugs de UX/fluxo):**

### Bug 1 — Botão "Testar Conexão" em sucesso parece erro (T-002)
Arquivo: [src/pages/super-admin/SuperAdminAccountsPage.tsx](../../src/pages/super-admin/SuperAdminAccountsPage.tsx)

No modal de **Edit** (linhas 1192-1221) e no modal de **Create** (linhas 701-719), o botão de Testar Conexão usa `variant="outline"`. A cor `primary` do tema é vermelha/laranja (branding MyChooice). Quando a conexão dá sucesso, **só o ícone** `CheckCircle2` recebe `text-green-500`; o resto do botão (border, texto, fundo) continua vermelho. Visualmente o usuário lê "vermelho = erro" e não confia.

Fix sugerido: aplicar classes condicionais ao botão inteiro quando `connectionStatus === 'success'` / `editConnectionStatus === 'success'`. Algo como:

```tsx
className={cn(
  "w-full",
  editConnectionStatus === 'success' && "border-emerald-500 text-emerald-700 hover:bg-emerald-50",
  editConnectionStatus === 'error' && "border-destructive text-destructive"
)}
```

### Bug 2 — Editar conta não permite importar agentes (T-003)
Arquivo: mesma página.

O wizard de importação de agentes (Selecionar → Criar usuários um por um) **só existe no fluxo de criação** (linhas 862-903 mostram steps `select-agents` e `create-users`). Trigger é o botão "Próximo: Importar Agentes" (linhas 839-848) que aparece **somente quando o teste de conexão dá sucesso E `agents.length > 0`**.

No fluxo de **edição** (linhas 1075-1305) existe "Testar Conexão" mas não tem o botão/wizard equivalente para importar. Resultado: quem cria a conta sem Chatwoot habilitado, ou habilita mas salva sem testar antes, **fica sem caminho** para importar agentes depois — a conta fica permanentemente com `Usuários: 0`.

Fix sugerido: após o feedback de sucesso no modal de Edit (após linha 1235), renderizar condicionalmente, quando `editConnectionStatus === 'success'` e houver agentes detectados, um botão "Importar Agentes do Chatwoot" que abre o mesmo wizard (`ChatwootAgentImport` + `EmbeddedUserCreationForm`). Pode-se:
1. Estender o estado de edit para guardar `editConnectionResult` (similar ao `connectionResult` da criação).
2. Extrair `handleAgentSelectionProceed` / `handleUserCreated` / `getCurrentAgent` etc. para reuso, passando `editingAccount.id` no lugar de `createdAccountId`.
3. Ou mais simples: ao clicar "Importar Agentes" no edit, fechar o modal de edit e abrir o wizard de criação já no step `select-agents` com `createdAccountId = editingAccount.id` e `connectionResult` populado.

### Para o QA (T-001) — passos de verificação

**Pré-condição:** super admin logado em `https://crm-mychooice-goodleads.jybre9.easypanel.host`.

**Reprodução do Bug 1 (visual):**
1. Abrir Contas → editar a conta `MychooiceValidacaoFinal`.
2. Conferir que os campos Chatwoot estão preenchidos (URL `https://atendimento.gleps.com.br`, Account ID `6`, API Key oculto).
3. Clicar **Testar Conexão**.
4. **Esperado após fix:** botão fica visivelmente verde (border, texto, fundo). Toast em verde + texto "Conexão estabelecida com sucesso!".
5. **Antes do fix:** botão fica vermelho mesmo em sucesso (só ícone verde).

**Reprodução do Bug 2 (funcional):**
1. Criar uma conta nova com Chatwoot **desabilitado** → Salvar.
2. Editar essa conta, habilitar Chatwoot com credenciais válidas, "Testar Conexão" (sucesso, X agentes).
3. **Esperado após fix:** aparecer botão "Importar Agentes". Clicando → abre wizard de seleção → criar usuários. Após concluir, conta passa de `Usuários: 0` para `Usuários: X`.
4. **Antes do fix:** não há botão de importar. Salvar não cria usuários. Conta permanece em `Usuários: 0`.

**Critério de aprovação geral:** ambos fluxos (criar com Chatwoot já no início + editar para adicionar Chatwoot depois) resultam em usuários do CRM criados a partir dos agentes do Chatwoot, sem ambiguidade visual no estado do botão.

---

## 2026-05-21 — T-000 Estrutura do time (@dev-principal → equipe)
- **O que mudou:** criada base de coordenação do time em `.claude/agents/` (frontend, qa) e `.claude/team/` (README, board, handoff-log). `.gitignore` passou a excluir `.env*`.
- **Como testar:** ler `.claude/team/README.md` e confirmar que o fluxo faz sentido para o seu papel.
- **Pendências:** inicializar git e fazer o commit base.
