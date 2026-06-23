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

---

## 2026-06-23 T-022 Sprint 3 Front-end — Webhook genérico + Compliance + Anti-ban (@frontend → @qa)

- **O que mudou:**
  - `src/services/webhooks.backend.service.ts` (novo) — `listWebhooks`, `createWebhook`, `updateWebhook`, `deleteWebhook`, `getDeliveries`, `testWebhook`; tipos exportados `WebhookSubscription`, `CreatedWebhook`, `WebhookDelivery`, `WebhookEvent`, `WEBHOOK_EVENTS`; graceful degradation em `list` e `getDeliveries` (retorna `[]` se backend retornar 404/500)
  - `src/services/inbound-integrations.backend.service.ts` (novo) — `listInbound`, `createInbound`, `deleteInbound`; tipos `InboundIntegration`, `InboundHandler`, `INBOUND_HANDLERS`; constrói `webhookUrl` local como fallback enquanto backend não retorna o campo
  - `src/services/whatsapp-consents.backend.service.ts` (novo) — `listOptedOut` (filtro período + busca), `optIn`, `optOut`, `exportCsv` (fetch nativo com token JWT + `createObjectURL` para download do arquivo)
  - `src/pages/admin/AdminIntegracoesPage.tsx` (novo) — 3 abas com TanStack Query + toast + AlertDialogs:
    - Aba "Webhooks de saída": tabela com badges de eventos, switch active, botões Editar/Testar/Excluir; Dialog criar/editar com MultiSelect de 7 eventos via Checkbox + toggle Active; pós-criação exibe secret HMAC com aviso "Copie agora"
    - Aba "Webhooks de entrada": lista de handlers com URL copiável; Dialog criar com slug, Select handler, config JSON livre, preview da URL gerada + exemplo cURL
    - Aba "Logs": Select de webhook + tabela de deliveries (eventName/url/status badge/latência ms/retryCount/data)
  - `src/pages/admin/AdminOptOutsPage.tsx` (novo) — tabela de opt-outs com filtro período (7d/30d/all) + busca cliente + server-side; botão "Exportar CSV"; AlertDialog de re-opt-in com aviso de consentimento explícito; empty state "Nenhum opt-out registrado. Bom sinal!"
  - `src/components/extracao/ComplianceWarning.tsx` (novo) — banner Alert amarelo (shadcn) que recebe `totalLote` e `totalOptOut`; renderiza null se totalOptOut === 0; mostra "X contatos com opt-out serão automaticamente excluídos do disparo"; pronto para ser integrado no DispatchDialog
  - `src/api/endpoints.ts` — adicionados grupos `WEBHOOKS`, `INBOUND_INTEGRATIONS`, `WHATSAPP_CONSENTS` (Sprint 3); todos os services usam strings literais de URL diretamente (o arquivo de endpoints serve como documentação centralizada)
  - `src/layouts/AdminLayout.tsx` — imports `Webhook` e `Ban` de lucide-react; itens "Integrações" (`/admin/integracoes`) e "Opt-outs WA" (`/admin/opt-outs`) adicionados ao `adminNavItems`
  - `src/App.tsx` — imports das 2 novas páginas; rotas `/admin/integracoes` e `/admin/opt-outs` protegidas com `allowedRoles: ['admin', 'super_admin']`

- **Arquivos/rotas afetadas:**
  - Novas rotas: `/admin/integracoes` e `/admin/opt-outs`
  - Modificados: `src/App.tsx`, `src/layouts/AdminLayout.tsx`, `src/api/endpoints.ts`
  - Novos: 3 services + 2 páginas + 1 componente

- **Commits:**
  - `275418c` — feat(t022): services Sprint 3 - webhooks, inbound integrations e whatsapp-consents
  - `d8e4c7c` — feat(t022): UI Sprint 3 - Integrações, Opt-outs e ComplianceWarning
  - `62e3f32` — feat(t022): rotas e sidebar Sprint 3 - integracoes e opt-outs

- **Como testar:**
  1. Acesse `/admin/integracoes` como admin → 3 abas devem aparecer com empty states (backend pendente)
  2. Aba "Webhooks de saída": clicar "+ Novo Webhook", preencher nome/URL (`https://exemplo.com/hook`), selecionar eventos via checkboxes, salvar → deve aparecer dialog com secret HMAC
  3. Aba "Webhooks de entrada": clicar "+ Novo Handler", preencher slug `pacto-checkin`, selecionar handler `Criar/atualizar contato`, ver URL gerada e exemplo cURL no próprio dialog
  4. Aba "Logs": selecionar um webhook no Select → deve mostrar empty state ou logs se houver entregas
  5. Acesse `/admin/opt-outs` → empty state "Nenhum opt-out registrado. Bom sinal!" deve aparecer
  6. Filtrar por período (7d/30d/all) e buscar por nome/telefone
  7. Botão "Exportar CSV" → deve tentar download (ou toast de erro se backend não disponível)
  8. Na sidebar: itens "Integrações" (ícone Webhook) e "Opt-outs WA" (ícone Ban) visíveis para admin
  9. Verificar que `ComplianceWarning` exporta corretamente: `import { ComplianceWarning } from '@/components/extracao/ComplianceWarning'`
  10. `tsc --noEmit -p tsconfig.app.json` → exit 0 (confirmado); `vite build` → 3537 módulos, sem erros

- **Pendências/suposições sobre contratos:**
  - `GET /api/webhooks` — backend Sprint 3 ainda não roteado; UI retorna empty state silenciosamente (`[]`)
  - `POST /api/webhooks`, `PATCH/DELETE`, `GET /:id/deliveries`, `POST /:id/test` — idem; mutations lançam erro com toast
  - `GET /api/integrations/inbound` — idem; `[]` enquanto não implementado
  - `GET /api/whatsapp-consents?status=opted_out` — idem; `[]` enquanto não implementado
  - `GET /api/whatsapp-consents/export?format=csv` — fetch nativo; toast de erro se backend retornar 404
  - Suposição: `InboundIntegration.webhookUrl` vem do backend; se ausente, o frontend constrói a URL como fallback com `window.location.origin`
  - `ComplianceWarning` ainda NÃO está integrado no `DispatchDialog` — integrar quando o backend expuser `GET /api/whatsapp-consents/check-batch` (ou similar) que identifica quais contatos do lote têm opt-out. O componente está pronto para receber `totalLote` e `totalOptOut` como props.
  - Build TypeScript: `npx tsc --noEmit -p tsconfig.app.json` → exit 0 confirmado. `npx eslint` nos 6 arquivos novos → 0 erros. `vite build` → 3537 módulos, ✅

---

## 2026-06-23 T-022 Sprint 2 QA — Campanhas WhatsApp (@qa → @dev-principal)

### O que foi testado

**Análise estática completa** de todos os arquivos do escopo Sprint 2 (backend + frontend):

**Backend:**
- `backend/prisma/schema.prisma` — DispatchBatch novos campos + WhatsappTemplate
- `backend/prisma/migrations/0022_whatsapp_campaigns/migration.sql`
- `backend/src/services/whatsapp-template.service.ts` — 6 métodos
- `backend/src/services/whatsapp-campaign.service.ts` — 653 linhas
- `backend/src/services/contact.service.ts` (queryForApi)
- `backend/src/services/prospecting.service.ts` (transport Evolution)
- `backend/src/controllers/whatsapp-campaign.controller.ts` + `whatsapp-template.controller.ts`
- `backend/src/routes/whatsapp-campaign.routes.ts` (jwtRouter + apiKeyRouter) + `whatsapp-template.routes.ts`
- `backend/src/routes/contacts-api.routes.ts` + `backend/src/routes/index.ts`
- `backend/src/server.ts` (cron WA)

**Frontend:**
- `src/api/endpoints.ts` (novos endpoints WA)
- `src/services/whatsapp-templates.backend.service.ts`
- `src/pages/admin/AdminExtracaoPage.tsx` (AgendadasTab)
- `src/pages/admin/AdminWhatsappTemplatesPage.tsx`
- `src/components/extracao/DispatchDialog.tsx`
- `src/components/extracao/CampaignDashboard.tsx`

**Testes unitários criados e rodados:**
- `backend/src/services/__tests__/whatsapp-template.test.ts` — 12 testes (render, extractVariables, divergência regex)
- `backend/src/services/__tests__/whatsapp-campaign.test.ts` — 21 testes (renderTemplate, isScheduled, processScheduledQueue, validações)

**Bateria de verificação:**
- `npx tsc -p tsconfig.app.json --noEmit` → exit 0
- `cd backend && npx tsc --noEmit` → exit 0
- `npx vitest run` (frontend) → 36/36
- `cd backend && npm run test` → 46/46 (incluindo 33 novos do QA)

**Testes de integração curl:** não executados (sem DB + Evolution local). Relatado como pendência.

---

### Bugs encontrados

#### BUG-A (ALTA — corrigido pelo QA, commit a1cc3c7)
**Arquivo:** `src/api/endpoints.ts` linha 169
**Problema:** `DISPATCH_START = '/api/dispatch/start'` apontava para rota inexistente. O backend não tem `/dispatch/start`. O roteamento `router.use('/dispatch', whatsappCampaignJwtRoutes)` monta as rotas `/send-single` e `/send-batch` — portanto o endpoint correto é `/api/dispatch/send-batch`.
**Impacto:** qualquer código que usasse `DISPATCH_START` (endpoint reservado no frontend para uso futuro) receberia 404 do backend.
**Correção:** `DISPATCH_START: '/api/dispatch/send-batch'`

#### BUG-B (ALTA — corrigido pelo QA, commit a1cc3c7)
**Arquivos:** `src/api/endpoints.ts` linha 170 + `src/pages/admin/AdminExtracaoPage.tsx` linha 69
**Problema duplo:**
1. `BATCH_CANCEL: (id) => '/api/dispatch/batches/${id}/cancel'` — path com `/cancel` no final que não existe no backend. O backend tem `DELETE /batches/:id` (sem `/cancel`).
2. Frontend chamava `apiClient.patch(...)` mas o backend define `jwtRouter.delete('/batches/:id')` — método HTTP errado causaria 404/405.
**Impacto:** o botão "Cancelar" na aba "Agendadas" sempre falharia com erro de rede.
**Correção:**
- `BATCH_CANCEL: (id) => '/api/dispatch/batches/${id}'`
- `apiClient.patch(...)` → `apiClient.delete(...)`

#### BUG-C (MÉDIA — reportar, não bloqueia funcionalidade básica)
**Arquivo:** `backend/src/services/whatsapp-template.service.ts` linha 18 + `backend/src/services/whatsapp-campaign.service.ts` linha 76
**Problema:** divergência de regex de renderização de template:
- `whatsapp-template.service` usa `/\{(\w+)\}/g` — captura apenas `{variavel}`
- `whatsapp-campaign.service` usa `/\{\{?\s*([\w.]+)\s*\}?\}/g` — aceita `{{variavel}}`, `{ variavel }`, `{variavel.subchave}`

**Efeito real (descoberto em teste):** se um template usar `{{nome}}`, o preview (template.service) retorna `{João}` (o `{` extra vaza), enquanto o envio real (campaign.service) envia `João`. Preview incorreto gera UX confusa — usuário vê resultado diferente do que será enviado.

Templates com `{nome}` simples funcionam identicamente nos dois — portanto não afeta o fluxo padrão.
**Ação:** unificar para a regex do campaign.service (mais permissiva) em ambos os services. Baixa urgência enquanto a documentação recomendar apenas `{variavel}`.

#### BUG-D (BAIXA — documentação de TODO sem bloquear)
**Arquivo:** `backend/src/services/contact.service.ts` linhas 599–623
**Problema:** filtros `aniversario` e `customAttribute` do `queryForApi` são silenciosamente ignorados (campos não existem no schema). O endpoint aceita os parâmetros sem erro mas não filtra. Um consumidor n8n que use `?aniversario=today` receberá todos os contatos da conta.
**Ação para Sprint futuro:** adicionar `dataNascimento` e `customAttributes` ao modelo `Contact` e implementar os filtros. Os TODOs já estão no código com warning de log.

---

### O que NÃO tem bug (validado):

**Multi-tenancy (CRÍTICO):**
- `whatsappTemplateService.list(accountId)` — WHERE accountId sempre presente.
- `whatsappTemplateService.get(id, accountId)` — findFirst com accountId, não findUnique. Correto.
- `whatsappTemplateService.delete(id, accountId)` — faz get() primeiro (verifica accountId) antes de deletar. Sem IDOR.
- `whatsappCampaignService.sendSingle(accountId, ...)` — contato buscado com `{ id, accountId }`. Sem vazamento.
- `whatsappCampaignService.listBatches(accountId, ...)` — WHERE accountId. Correto.
- `whatsappCampaignService.getBatch(id, accountId)` — findFirst com ambos. Correto.
- `whatsappCampaignService.cancelScheduled(id, accountId)` — findFirst com accountId antes de update. Sem IDOR.
- `contactsApiRoutes` — `requireApiKey` popula `req.accountId` e o controller valida. Correto.
- `processScheduledQueue` — processa batches de todas as contas (correto para cron global); cada batch carrega `batch.accountId` que é usado em todas as operações downstream.

**Autenticação + Permissões:**
- Rotas JWT (`/api/whatsapp/campaigns`, `/api/dispatch`) usam `authenticate`. Correto.
- Rotas API Key (`/api/integrations/whatsapp/campaigns`) usam `requireApiKey`. Correto.
- `whatsapp-template.routes.ts` usa `authenticate + requireAccountId + requirePermission('campaigns', 'emails')`. Agentes sem permissão recebem 403.
- `getAccountId()` no controller suporta JWT e API key — sem path que bypasse a validação.

**Cron de agendamento:**
- Usa `updateMany({ where: { id, status: 'scheduled' } })` com verificação de `updated.count === 0` para evitar race condition multi-worker. Correto.
- Erro em um batch não derruba os outros (try/catch por batch + catch no promise do processBatchInBackground). Correto.
- `take: 50` evita starve de batches antigos — limite razoável para cron 5min.

**Transport Evolution no prospecting:**
- `resolveDispatchConfig` detecta Evolution por `evolutionBaseUrl + evolutionApiKey + evolutionInstance` (todos obrigatórios). Fallback correto para Chatwoot. Se nenhum configurado: lança `Error('Configure Chatwoot ou Evolution na conta')` — iGreen/Gleps360 com só Chatwoot funcionam normalmente.
- `evolutionBaseUrl.replace(/\/$/, '')` presente em `evolution.service.ts` (confirmado Sprint 1). Trailing slash tratado.

**Migration e schema:**
- `dispatch_batches`: novos campos opcionais com DEFAULT adequados — não quebra batches antigos (retrocompatível).
- `whatsapp_templates`: FK com ON DELETE CASCADE para accounts. Índices em `account_id` e `category`. Correto.
- `source` com `NOT NULL DEFAULT 'manual'` — batches existentes recebem 'manual' automaticamente.

**Regra de ouro (ROADMAP):**
- Todo disparo WhatsApp passa por `whatsappCampaignService` que chama `evolutionService.sendText()`. n8n usa API key route que compartilha o mesmo controller/service. Regra mantida.

**TODOs de compliance (Sprint 3 — documentados e aceitáveis):**
- Consent/opt-out: não existem ainda. Código NÃO tem guard que bloqueie envio se sem consentimento. Documentado como Sprint 3. Risco aceitável para Sprint 2 interno; DEVE ser implementado antes de produção com usuários finais.
- Rate-limit por conta: não existe no campaign.service. `delaySeconds` existe mas é delay entre mensagens, não throttle por conta. Sprint 3.

---

### Pendências para @dev-principal

1. **(ALTA — já corrigido pelo QA)** BUG-A e BUG-B: endpoints corrigidos em `endpoints.ts` e `AdminExtracaoPage.tsx`. Commit `a1cc3c7`.
2. **(MÉDIA)** BUG-C: unificar regex de renderização entre `whatsapp-template.service` e `whatsapp-campaign.service`. Usar `/\{\{?\s*([\w.]+)\s*\}?\}/g` em ambos.
3. **(BAIXA)** BUG-D: `queryForApi` ignora filtros `aniversario` e `customAttribute` silenciosamente. Documentar isso no contrato da API para evitar confusão com n8n.
4. **(MÉDIA — pré-produção)** Compliance/Sprint 3: consent, opt-out e rate-limit DEVEM existir antes de disparar para usuários reais. O campo `WhatsappConsent` e `WhatsappRateLimit` precisam ser criados.
5. **(BAIXA)** Testes de integração curl dos endpoints WhatsApp: não executados nesta rodada por falta de DB + Evolution local. Sugestão: CI com Postgres + mock da Evolution API.

---

### Veredito geral: APROVADO COM RESSALVAS

Sprint 2 é funcional e seguro para o escopo declarado. Os bugs A e B (endpoints) foram corrigidos pelo QA e o build está verde. O BUG-C (regex) é cosmético (não afeta fluxo padrão com `{variavel}`). O BUG-D é documentado com TODO no próprio código.

Pontos críticos de multi-tenancy e autenticação estão corretos. A regra de ouro (todo disparo pelo CRM) é respeitada.

**Commit QA:** `a1cc3c7` (branch `Variação-FitPark`)

---

## 2026-06-23 T-022 Sprint 2 Front-end — Campanhas WhatsApp (@frontend → @qa)

- **O que mudou:**
  - `src/api/endpoints.ts` — novo grupo `WHATSAPP_TEMPLATES` (LIST, CREATE, UPDATE, DELETE) + endpoints `BATCHES_SCHEDULED`, `DISPATCH_START`, `BATCH_CANCEL` dentro de `PROSPECTING`
  - `src/services/whatsapp-templates.backend.service.ts` (novo) — `listTemplates`, `createTemplate`, `updateTemplate`, `deleteTemplate` usando `apiClient`
  - `src/pages/admin/AdminWhatsappTemplatesPage.tsx` (novo) — CRUD completo: tabela, Dialog criar/editar (react-hook-form + zod), AlertDialog excluir, Dialog preview com placeholders substituídos por valores fake, skeleton + empty state, TanStack Query + toast
  - `src/layouts/AdminLayout.tsx` — item "Templates WA" com ícone `MessageSquare` adicionado ao `adminNavItems`
  - `src/App.tsx` — import + rota `/admin/whatsapp-templates` (ProtectedRoute allowedRoles admin/super_admin)
  - `src/components/extracao/DispatchDialog.tsx` — adicionados: Select de template (popula mensagem automaticamente; deseleciona se mensagem for editada), RadioGroup de agendamento (3 opções: agora, data/hora específica, daqui X horas/dias), `scheduled_at` ISO + `source` no payload do dispatch
  - `src/components/extracao/CampaignDashboard.tsx` (novo) — 4 cards de métricas (total enviadas, taxa entrega, opt-outs, campanhas ativas), filtros por período/fonte/triggerName, tabela de batches com graceful fallback para backend ainda não implementado
  - `src/pages/admin/AdminExtracaoPage.tsx` — tabs expandidas de 3 para 5 colunas (+ "Agendadas" e "Dashboard"), componente `AgendadasTab` inline com tabela de batches agendados + cancelamento via AlertDialog + TanStack Query

- **Arquivos/rotas afetadas:**
  - Nova rota: `/admin/whatsapp-templates`
  - Rota modificada: `/admin/prospeccao` (novas abas Agendadas e Dashboard)
  - Dialog de disparo modificado (compatível com comportamento anterior — "Disparar agora" é o default)

- **Como testar:**
  1. Acesse `/admin/whatsapp-templates` como admin — lista de templates deve carregar (ou empty state se backend não respondeu)
  2. Criar template: clicar "+ Novo Template", preencher nome/categoria/conteúdo com `{nome}` e salvar
  3. Clicar no ícone olho (Eye) para ver preview com "João Silva" substituído no lugar de `{nome}`
  4. Editar e excluir template (confirmar AlertDialog)
  5. Na sidebar, item "Templates WA" deve aparecer com ícone de balão
  6. Em Prospecção (`/admin/prospeccao`), verificar que abas "Agendadas" e "Dashboard" aparecem
  7. Clicar em "Disparar" em qualquer lead selecionado → DispatchDialog deve mostrar seções "Template (opcional)" e "Agendamento" antes dos botões
  8. Selecionar um template → campo de mensagem deve ser preenchido automaticamente
  9. Escolher "Agendar para data/hora específica" → campos de data e hora devem aparecer
  10. Escolher "Daqui X horas/dias" → input numérico + select de unidade devem aparecer

- **Pendências e suposições sobre contratos:**
  - `GET /api/whatsapp-templates` — backend ainda não existe; endpoint retornará 404 até ser implementado. UI trata com empty state.
  - `POST/PATCH/DELETE /api/whatsapp-templates/:id` — idem.
  - `GET /api/dispatch/batches?status=scheduled` — endpoint novo; UI faz graceful fallback (retorna `[]` em caso de erro).
  - `PATCH /api/dispatch/batches/:id/cancel` — contrato assumido; pode ser necessário ajustar para DELETE ou body diferente.
  - `GET /api/dispatch/metrics` — endpoint de métricas de campanha; não existe ainda; retorna zeros enquanto não implementado.
  - `POST /api/dispatch/start` com `scheduled_at` e `source` — o DispatchDialog ainda usa `POST /api/prospecting/dispatch` (endpoint existente). O campo `scheduled_at` e `source` foram adicionados ao payload, mas o backend atual pode ignorá-los até a implementação Sprint 2 estar completa.
  - Suposição: `DispatchBatch.source` e `DispatchBatch.scheduled_at` são campos opcionais — não quebra serialização com batches antigos que não têm esses campos.
  - Build TypeScript: `npx tsc --noEmit` passou sem erros no commit `197a845`.

---

## 2026-06-23 T-022 Sprint 1 QA — Evolution API + ApiKey infra (@qa → @dev-principal) {#2026-06-23-t022-sprint1-qa}

### O que foi testado

**Análise estática completa** dos arquivos do escopo (schema, migration, services, controllers, routes, UI):

- `backend/prisma/schema.prisma` — campos `Account.evolution*` + model `ApiKey`
- `backend/prisma/migrations/0021_add_evolution_and_api_key/migration.sql`
- `backend/src/services/evolution.service.ts` (sendText, sendMedia, sendAudio, getStatus, getQrCode, disconnect)
- `backend/src/services/api-key.service.ts` (generate, list, validate, revoke)
- `backend/src/middlewares/apiKey.middleware.ts` (requireApiKey — Bearer + x-api-key)
- `backend/src/controllers/evolution.controller.ts` + `evolution.routes.ts`
- `backend/src/controllers/api-key.controller.ts` + `api-key.routes.ts`
- `backend/src/controllers/account.controller.ts` + `backend/src/services/account.service.ts`
- `backend/src/routes/index.ts`
- `src/pages/super-admin/SuperAdminAccountDetailPage.tsx`
- `src/pages/super-admin/SuperAdminApiKeysPage.tsx`
- `src/services/api-keys.backend.service.ts`
- `src/services/accounts.backend.service.ts`
- `src/services/accounts.cloud.service.ts`
- `src/App.tsx` (rota `/super-admin/accounts/:accountId/api-keys`)

**Testes unitários:** 13 testes vitest para `api-key.service.ts` (generate, list, validate, revoke) — todos passando 13/13.

**Bateria geral:**
- `npx tsc -p tsconfig.app.json --noEmit` → ✅ exit 0
- `backend npx tsc --noEmit` → ✅ exit 0
- `npx vitest run` (frontend) → ✅ 36/36
- `cd backend && npx vitest run` → ✅ 13/13
- `npx vite build` → ✅ 3531 modules, build ok (aviso chunk size é pré-existente)

**Testes de integração curl:** não executados (sem DB Postgres + Evolution rodando localmente). Relatado abaixo.

---

### Bugs encontrados

#### BUG-1 (CRITICO — corrigido pelo QA)
**Arquivo:** `src/pages/super-admin/SuperAdminAccountDetailPage.tsx` linha 328–334
**Problema:** `handleGenerateQrCode` buscava o base64 do QR Code nas propriedades `response?.base64 ?? response?.qrcode ?? response?.qrCode ?? response?.data?.base64 ?? response?.data?.qrcode`. O backend Evolution Controller retorna `res.json({ data: result })` onde `result` é `QrCodeResult = { qrcodeBase64, code, raw }`. A propriedade real é `response.data.qrcodeBase64` — nunca testada na cadeia original. Resultado: o QR Code nunca exibia na UI.
**Correção aplicada (commit caa34a0):** adicionou `response?.data?.qrcodeBase64` como primeiro candidato na cadeia.

#### BUG-2 (BAIXA — reportar, não bloqueia)
**Arquivo:** `src/services/accounts.backend.service.ts` linha 55–68 (`create` method)
**Problema:** O método `create` não inclui os campos Evolution (`evolutionBaseUrl`, `evolutionApiKey`, `evolutionInstance`) no payload enviado ao backend. O `update` (linha 70+) inclui corretamente. Impacto na UI atual: nenhum (configuração Evolution só é feita via update na `SuperAdminAccountDetailPage`). Impacto se alguém chamar a API diretamente: campos Evolution perdidos no create.
**Ação:** corrigir no próximo sprint antes de expor a criação de contas com Evolution via API REST.

---

### O que NÃO tem bug (validado):

- **Multi-tenancy:** todos os endpoints de Evolution e ApiKeys exigem `accountId` no path e o controller faz `assertCanAccessAccount` com validação de role. `apiKeyService.list()` filtra por `accountId`. `apiKeyService.revoke()` usa `where: { id, accountId }` — sem vazamento.
- **Vazamento de hash:** `apiKeyService.list()` usa `select` explícito que exclui `hashedKey`. O endpoint GET retorna apenas `{ id, name, prefix, scopes, lastUsedAt, revokedAt, createdAt }`. Confirmado por teste unitário.
- **Middleware apiKey:** aceita `Authorization: Bearer <key>` e `x-api-key: <key>`. Lógica correta. Chave revogada → findFirst retorna null (`revokedAt: null` no where) → 401. Chave inexistente → 401. Testado via unitários.
- **SHA-256 correto:** chave armazenada é `sha256(plaintextKey)`, não o texto plano. Confirmado por teste unitário.
- **Prefixo:** primeiros 12 chars da plaintextKey (começa em `glk_`). Confirmado.
- **Schema e migration:** `ApiKey` tem `@index([hashedKey])` e `@index([keyPrefix])` — queries de validação serão eficientes. FK com Cascade Delete. Correto.
- **HMAC webhook Evolution:** endpoint `POST /api/evolution/webhook/:accountId` é público. Não tem validação HMAC. Está documentado como `TODO(sprint-futura)` no código e no ROADMAP. Risco aceitável para Sprint 1, **deve ser resolvido antes de produção real**.
- **QrCode prefixo:** o `handleGenerateQrCode` na UI já faz `String(base64).replace(/^data:image\/png;base64,/, '')` antes de montar o `<img src>`. Correto — remove o prefixo de data URL se vier do backend.
- **Rota App.tsx:** `/super-admin/accounts/:accountId/api-keys` com `requireSuperAdmin` — correto.
- **Permissões Evolution routes:** `requireRole('super_admin', 'admin')` + `assertCanAccessAccount` no controller. Admin só acessa a própria conta. Correto.
- **Fire-and-forget lastUsedAt:** race condition inofensiva. Se o update falhar, a key ainda é válida na próxima chamada. Comportamento correto para performance.
- **`evolutionBaseUrl.replace(/\/$/, '')` no service:** trailing slash removido antes das chamadas. Correto.
- **normalizeNumber:** remove não-dígitos. Funciona para `+55 (11) 99999-9999` → `5511999999999`. Correto.
- **Dual data layer (VITE_USE_BACKEND):** `accounts.backend.service.ts` e `accounts.cloud.service.ts` ambos declaram os campos `evolution_*` no tipo `Account`. Backend service mapeia camelCase → snake_case corretamente. Cloud service tem os campos na interface. Coerentes.

---

### Pendências para @dev-principal

1. **(BAIXA) BUG-2** — adicionar campos Evolution no `accountsBackendService.create()` em `src/services/accounts.backend.service.ts`
2. **(MÉDIA — pré-produção)** Webhook `POST /api/evolution/webhook/:accountId` sem autenticação/HMAC. Qualquer um pode enviar eventos falsos. Implementar antes de expor o endpoint publicamente.
3. **(BAIXA)** Teste de integração curl dos endpoints evolution e api-keys não realizado nesta rodada (sem DB + Evolution disponíveis). Sugestão: configurar ambiente de CI com Postgres para Sprint 2.

---

### Veredito geral: APROVADO COM RESSALVAS

Sprint 1 está funcional e seguro para o escopo declarado. O único bug crítico (BUG-1, QR Code) foi corrigido por mim neste QA. O BUG-2 é baixa severidade e não bloqueia o uso atual. O webhook sem HMAC é risco conhecido e documentado — aceitável para Sprint 1, deve ser resolvido antes de expor em produção.

**Commit QA:** `caa34a0` (branch `Variação-FitPark`)

---

## 2026-06-14 — Dark Mode validado na UI + bateria verde → merge na main (@dev-principal → @usuário) {#2026-06-14-darkmode-merge-main}

**Por instrução direta do usuário** (autorização de push na main), rodei a bateria de testes e, com tudo verde, fiz o merge do dark mode na `main` para deploy. O bloqueio T-009 deixou de valer na prática: o `.env` da raiz já tem `VITE_USE_BACKEND=true` e a stack local (Express :3000 + Postgres + Vite :8080) sobe — **login local funciona**, o que destravou a validação visual.

**Validação visual (Playwright, stack local, usuários do seed):**
- Login claro **e** escuro: logo legível, labels legíveis, botão "Entrar" vermelho visível nos 2 temas (confirma a correção do botão transparente).
- Admin (escuro): dashboard (donut Resolução, barras Backlog soft, IAvsHuman), Financeiro (RevenueChart, PaymentMethodChart donut com separador `--card`) e Insights — sem buraco branco.
- Financeiro também no claro (separadores brancos corretos). Toggle troca ao vivo (sem reload) e **persiste** no reload.
- Super-admin (escuro): layout próprio, Monitoramento do Servidor + charts de consumo OK.
- Não-regressão @700px: sidebar inteira, último item de nav não sobreposto pelo rodapé/toggle. Console: 0 erros.

**Bateria (gates locais):** `tsc -p tsconfig.app.json` ✅ · `vitest` 36/36 ✅ · `vite build` ✅ · `eslint` nos arquivos do diff ✅ (o único erro, `location.state as any` em LoginPage:58, é **pré-existente na main** — confirmado: não aparece no diff) · `qa:smoke` local 42/45 (as 3 falhas `/chatwoot/*` são esperadas em local — seed sem credenciais Chatwoot; backend não foi tocado).

**Pendência (não bloqueia deploy):** empacotar `npm run dev:stack` e `npm run qa:smoke:local` no package.json (T-009 "rodar local com um comando só"). Logo MyChooice colorido p/ tema claro e favicon `prefers-color-scheme` seguem como polimento opcional.

---

## 2026-06-14 — Front sinaliza: dev local ≠ prod, login local não funciona (T-009) (@frontend → @dev-principal) {#2026-06-14-dev-local-prod}

**Não é da minha alçada (front) resolver — só estou reportando para o Dev Principal decidir o caminho.** O usuário pediu para alinhar o ambiente local ao de produção e focar tudo em uma só tecnologia, funcional. Ele vai logar e validar o dark mode **depois** que isto for resolvido.

**O que observei (fatos, sem propor solução):**
- Produção/Docker usa Express: `docker-compose.yml` builda o front com `VITE_USE_BACKEND: "true"` e sobe postgres + backend.
- No `vite dev` local o app cai em **Supabase Cloud**: o `.env` do front **não** define `VITE_USE_BACKEND` (e `.env.example` não menciona a flag) → `useBackend=false` em [src/config/backend.config.ts](../../src/config/backend.config.ts).
- Existe seed do Express ([backend/src/prisma/seed.ts](../../backend/src/prisma/seed.ts)) com `superadmin@sistema.com` / `Admin@123`, mas ele não vale no localhost atual porque o front local fala com Supabase, não com o Express seedado.
- Consequência: não há como logar no localhost de forma confiável hoje → bloqueia a validação visual do dark mode.

**Necessidade (resultado esperado, não o "como"):** ambiente local que funcione igual ao de prod, com login funcionando. A tecnologia/arquitetura e a eventual consolidação da camada dupla de dados ficam a critério do Dev Principal (e ele deve confirmar o escopo com o usuário).

**Do meu lado (front):** o dark mode está pronto e em QA na branch `feat/dark-mode` (working tree). Assim que o login local funcionar, valido visualmente as telas autenticadas no dark.

---

## 2026-06-14 — Dark Mode COMPLETO (T-006 + T-007 + T-008) (@frontend → @qa) {#2026-06-14-dark-mode-completo}

**O usuário pediu o dark mode por completo, com a obrigatoriedade de NÃO quebrar nenhuma funcionalidade, rodando workflows de monitoramento em paralelo. Entreguei as 3 fases numa única branch `feat/dark-mode` (working tree, ainda não commitada — QA commita).**

### O que mudou
- **Plumbing (T-006):** novo `src/components/theme-provider.tsx` (next-themes; tipado via `ComponentProps<typeof NextThemesProvider>` p/ não depender de `ThemeProviderProps`, que a 0.3.0 não re-exporta) + `src/components/theme-toggle.tsx` (dropdown Claro/Escuro/Sistema; ícone anima via `dark:` sem ler tema em JS). `App.tsx` envolve a árvore com `<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>` (ordem: QueryClient > Theme > Tooltip > Router > Auth).
- **Toggle posicionado** no header mobile **e** no rodapé da sidebar dos dois layouts (cores `sidebar-*`).
- **Fundo do `<main>`** trocado de `#F8FAFC` (Admin) e `bg-white` (SuperAdmin) → `bg-background`.
- **Login segue a preferência do usuário** (requisito explícito): removido o `className="dark"` forçado; labels `text-white/90`→`text-foreground/90`; card `glass-strong` tokenizado; logo branco posto num "chip" `bg-sidebar` (escuro nos 2 temas) p/ legibilidade.
- **Charts (T-007):** RevenueChart (grid→`--chart-grid`, ticks→`--muted-foreground`, série→`--chart-2`), PaymentMethodChart (separador do donut `#FFFFFF`→`--card`), Resolução/IAvsHuman (track do donut `#E5E7EB`→`--muted`), BacklogCard (track da barra `bg-white/50`→`bg-foreground/10`).
- **Gaps de token no `.dark` (T-008):** `--chart-grid`, `--success/warning/destructive-soft`, `--role-admin/agent`, `--text-*`; `.glass`/`.glass-strong`→`hsl(var(--card))`; `.shadow-card` com sombra mais forte no dark; reserva do ScrollArea da sidebar 8rem→11rem (toggle aumentou o rodapé).

### Decisões (divergi da auditoria com motivo)
- **Azul-IA e paleta de método de pagamento mantidos como DADO** (não tokenizados). Não há token azul; mapear p/ `--chart-1` (vermelho) deixaria a IA vermelha (regressão + conflito com "perigo"). São cores legíveis nos 2 temas.
- `defaultTheme="system"` (não "light") porque o usuário pediu que o login/app **siga a preferência** do SO; persiste a escolha manual via toggle.

### Bug encontrado e corrigido (reportado ao usuário)
Botão **"Entrar"** usava `bg-gradient-primary` e `glow-primary` — **classes inexistentes**. O `twMerge` descartava o `bg-primary` do Button → botão transparente; só não se via porque o login era sempre escuro (texto branco). Ao tornar o login claro, o botão **sumia**. Corrigido definindo as classes com tokens da marca (gradiente vermelho→accent + glow). Confirmado por screenshot nos 2 temas.

### Verificação (2 workflows + gates)
- **Workflow auditoria** (7 agentes): mapa exato de cores + risco funcional + gaps de token.
- **Workflow verificação adversarial** (3 agentes): regressão funcional = PASS (árvore de providers ok, auth/submit/redirect intactos, nenhum teste depende de tema); completude = PASS (nenhum chrome hardcoded de chrome escapou); corretude pegou **1 blocker** (o `tsc` do `theme-provider`) — **já corrigido e revalidado**.
- Gates locais: `npx tsc --noEmit -p tsconfig.app.json` ✅ · `vite build` ✅ · `vitest` 36/36 ✅ · `eslint` limpo nos arquivos do diff (o único erro, `location.state as any` em LoginPage:58, é pré-existente em main).
- **Visual:** login capturado nos 2 temas (claro/escuro) via Playwright na instância local — ambos corretos e legíveis.

### Arquivos (10 modificados + 2 novos)
Novos: `src/components/theme-provider.tsx`, `src/components/theme-toggle.tsx`.
Modificados: `src/App.tsx`, `src/layouts/AdminLayout.tsx`, `src/layouts/SuperAdminLayout.tsx`, `src/pages/LoginPage.tsx`, `src/index.css`, `src/components/finance/RevenueChart.tsx`, `src/components/finance/PaymentMethodChart.tsx`, `src/components/dashboard/ResolucaoCard.tsx`, `src/components/dashboard/IAvsHumanCard.tsx`, `src/components/dashboard/BacklogCard.tsx`.

### Como testar (QA)
1. `npm run dev` → abrir `/login`: alternar tema do SO (ou `localStorage.theme`) e confirmar login legível em claro e escuro (logo, labels, botão "Entrar" vermelho visível).
2. Logar e usar o `ThemeToggle` (sidebar/header) em `/admin/*` e `/super-admin/*`; alternar Claro/Escuro/Sistema; conferir persistência (reload mantém escolha).
3. Olhar dashboards/insights/financeiro no dark: gráficos com grid/ticks/tracks visíveis, sem "buraco branco"; BacklogCard legível; donuts com track sutil.
4. **Não-regressão:** sidebar não sobrepõe o último item de nav em tela baixa (~700px); Sonner (toast) segue o tema; multi-tenancy/auth inalterados.

### Pendências / decisões p/ o usuário
- **Commit:** não commitei (regra do time = QA commita). Para QA: `git add -A` (inclui os 2 arquivos novos) e commit na branch `feat/dark-mode`.
- **Logo no tema claro:** hoje usa "chip" escuro. Se quiser o logo **colorido** no claro, precisa do SVG limpo do MyChooice (o atual é só branco). Workaround atual é seguro e legível.
- **Favicon `prefers-color-scheme`** ficou de fora (cosmético, ícone da aba).

---

## 2026-06-01 — QA: verificação geral final — PRONTO PARA DEPLOY (@qa → @usuário)

**Limpeza não-bloqueante aplicada:** removidas 3 constantes mortas de `src/api/endpoints.ts` (`DASHBOARD.REVENUE`, `DASHBOARD.CONVERSION_FUNNEL`, `INSIGHTS.OVERVIEW`) — confirmado por grep que não eram usadas em nenhum lugar (nem em testes). `qa-smoke.mjs` ajustado (removidos os probes desses paths).

**T-005 já confirmado AO VIVO ✅:** entre as execuções, a instância foi redeployada e `GET /api/auth/me` **não traz mais `chatwootApiKey`**. Os outros 44 checks seguem 200/verde → remover a key **não quebrou nada em produção**. Atualizei o smoke para tratar isso como assert de regressão normal (espera `ABSENT`).

**Estado final (local, na `main`):** `vite build` ✅ · `vitest` 36/36 ✅ · `eslint` endpoints.ts limpo · backend `tsc` ✅ · `npm run qa:smoke` → **45 checks, 0 falhas reais**.

**Veredito: pronto para deploy.** A `main` contém T-002/T-003, T-004, T-005, tooling de QA e a limpeza das constantes.

---

## 2026-06-01 — QA: T-004 e T-005 APROVADOS no código (pré-deploy) (@qa → @usuário)

Revisão estática dos commits `2f33c43` (T-004) e `c74a2eb` (T-005) antes do próximo deploy.

**T-004 — APROVADO ✅** `src/api/endpoints.ts:75` `SALES.STATS: '/api/sales/stats' → '/api/sales/kpis'`. Mudança de 1 linha, correta. `/api/sales/kpis` é rota real (validei 200 ao vivo). Consumidores `salesService.getStats` e `finance.backend.getSaleKPIs` passam a apontar para o lugar certo.

**T-005 — APROVADO ✅** `backend/src/services/auth.service.ts`: campo `chatwootApiKey` removido da interface `LoginResult` e dos returns de `login()` e `getMe()`. Sem referência sobrando no arquivo. **Sem regressão no front (backend mode):**
- `chatwootConfig.ts:21-23` faz branch em `useBackend` → exige só `base_url + account_id`, não a key. ✅
- `useChatwootMetrics.ts:265-268` em backend mode chama `fetchChatwootMetricsViaBackend(...)` (não usa a key); o ramo que usa `account.chatwoot_api_key` (linha 216) é só Cloud. ✅
- `AuthContext.backend.tsx:43` é defensivo (`?? raw.chatwootApiKey`) → vira `undefined`, inofensivo. ✅
- Telas super_admin leem a key de `/api/accounts` (listagem), não do payload de auth → intactas.

**Validação independente:** front `vite build` ✅; `vitest` ✅ 36/36; backend `tsc --noEmit` ✅ exit 0.

**Observação (não-bloqueante):** o T-005 fechou só o payload de **auth**. A `chatwootApiKey` ainda volta em `GET /api/accounts` (necessária para o form de edição do super_admin pré-preencher). Se a intenção for nunca trafegar a key ao cliente, avaliar mascarar também ali — fica a critério do Dev/usuário, fora do escopo do T-005.

**Veredito:** seguro para deploy. Pós-deploy: `npm run qa:smoke` deve marcar `T-005 chatwootApiKey` como `ABSENT`.

---

## 2026-06-01 — QA: harness de smoke-test da API + T-004/T-005 ainda NÃO deployados (@qa → @usuário/@dev-principal)

**Entregável (cabe ao QA — tooling de validação):** `scripts/qa-smoke.mjs` + script `npm run qa:smoke`. Roda 48 checks contra uma instância: auth, dashboard, CRM core, finance, insights, chatwoot, email, prospecção, e barreiras authz/multi-tenancy. Credenciais por env (`QA_BASE_URL`/`QA_EMAIL`/`QA_PASSWORD`), **nenhum segredo no repo**. `--write` inclui round-trip criar→apagar contato. Anomalias conhecidas (paths mortos, etc.) são reportadas sem derrubar o run; se uma mudar de status, ele avisa para limpar a lista.
- Rodado agora: **48 checks, 0 falhas reais**.

**Achado importante:** as correções T-004 e T-005 estão na `main` mas **a instância ainda roda o build antigo** — validei ao vivo:
- `GET /api/auth/me` **ainda traz `chatwootApiKey`** (T-005 não aplicado).
- `GET /api/sales/stats` ainda 500 (path não existe; o front já migrou para `/api/sales/kpis` no código, mas o bundle deployado é o antigo).
- **Ação:** redeployar para T-004/T-005 valerem. Depois do redeploy, rodar `npm run qa:smoke` — a linha `T-005 chatwootApiKey no /auth/me` deve virar `ABSENT` (o script avisa "RESOLVIDA?" → aí removo o marcador).

**Como rodar:**
```sh
QA_BASE_URL="https://crm-mychooice-goodleads.jybre9.easypanel.host" \
QA_EMAIL="..." QA_PASSWORD="..." npm run qa:smoke
```

---

## 2026-06-01 — Dark Mode — Auditoria + abertura de T-006/T-007/T-008 (@dev-principal → @frontend) {#2026-06-01-dark-mode-auditoria}

**Contexto:** o usuário pediu dark mode. Antes de abrir card, rodei auditoria multi-agente read-only do code base inteiro (9 agentes em paralelo cobrindo infra + 8 áreas). Resultado: viabilidade ALTA, infra ~80% pronta, escopo dividido em 3 fases. **Esta é a passagem para o Front executar a Fase 1 (T-006).**

### Estado da infraestrutura (não precisa refazer)
- `tailwind.config.ts` já usa `darkMode: ['class']`. Toda paleta referencia `hsl(var(--token))` — zero hardcode no tema.
- `src/index.css` tem **62 variáveis semânticas em `:root`** (padrão shadcn completo + extensões `--success`, `--warning`, `--info`, `--sidebar-*`, `--kanban-*`, `--role-*`, `--status-*`, `--chart-*`).
- **`.dark { }` já está desenhado** com **35 variáveis sobrescritas** ("Deep black enterprise") — paleta dark pronta, só não está sendo ativada.
- `next-themes` ^0.3.0 nas dependências.
- `components.json` com `cssVariables: true`, `baseColor: "slate"`.
- 86% dos componentes shadcn (43 de 50) usam exclusivamente tokens semânticos. Baseline saudável.
- **`src/components/ui/sonner.tsx` já chama `useTheme()`** mas cai no fallback porque não há provider.

### Gaps que faltam (escopo do T-006)
1. **Nenhum `ThemeProvider` em `src/App.tsx`** — toda a árvore não tem contexto de tema.
2. **Nenhum `ThemeToggle`** existe (grep retornou zero).
3. **Bug real em layouts** (rompe dark mode visualmente):
   - `src/layouts/AdminLayout.tsx:263` → `style={{ backgroundColor: '#F8FAFC' }}` no `<main>`. Conteúdo todo fica fundo claro permanente.
   - `src/layouts/SuperAdminLayout.tsx:237` → `bg-white` no `<main>`. Mesmo problema.
4. **Cleanup mínimo** em `src/pages/LoginPage.tsx:142,157` — `text-white/90` em `<Label>` (funciona hoje só porque L102 força `className="dark"` na raiz).

### Passos sugeridos para o Front executar (T-006)

```tsx
// 1. src/components/theme-provider.tsx (novo)
import { ThemeProvider as NextThemesProvider, type ThemeProviderProps } from "next-themes"

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}

// 2. src/App.tsx — envolver a árvore dentro do QueryClientProvider
<QueryClientProvider client={queryClient}>
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
    <TooltipProvider>...</TooltipProvider>
  </ThemeProvider>
</QueryClientProvider>

// 3. src/components/theme-toggle.tsx (novo)
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  return (
    <Button variant="ghost" size="icon" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
      <Sun className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span className="sr-only">Alternar tema</span>
    </Button>
  )
}
```

Posicionar `<ThemeToggle />` no header de `src/layouts/AdminLayout.tsx` e `src/layouts/SuperAdminLayout.tsx` (perto do avatar/menu do usuário). Fixar os 2 bugs do `<main>` no mesmo PR.

**Decisão de design pendente (alinhar com usuário antes de mergear):** manter ou remover o `className="dark"` forçado em `LoginPage.tsx:102`? Hoje a página de login é sempre dark independente da preferência. Sugestão: remover o force-dark — login passa a respeitar tema. Se mantiver, label cleanup (`text-foreground/90`) ainda alinha com tokens mas continua visualmente igual.

### Áreas que **ficam fora** da Fase 1 (vão para T-007 e T-008)
- **Charts dashboards** (`AtendimentoRealtimeCard`, `IAvsHumanCard`, `ResolucaoCard`, `BacklogCard`): constantes `CHART_BLUE/GREEN/YELLOW/RED/MUTED` hex hardcoded em JS. Refactor para `hsl(var(--chart-*))`.
- **SVG donuts crus** (`IAvsHumanCard` L72, `ResolucaoCard` L119): `<circle stroke="#E5E7EB">` — track invisível no dark.
- **`PaymentMethodChart`**: 7 cores hex por método + `stroke="#FFFFFF"` entre fatias.
- **`RevenueChart`**: `<CartesianGrid stroke="#E5E7EB">` + ticks `fill: '#64748B'`.
- **Bom referencial (já adaptativo):** `HourlyPeakChart`, `ServerConsumptionChart`, `WeeklyConsumptionChart`, `TemporalAnalysisChart`, `ConversionVelocity` usam `hsl(var(--chart-*))` corretamente. Copiar padrão na Fase 2.
- **Logos**: `mychooice-logo-white.svg` (100% branco, único importado em 3 lugares) somiria em light; `gleps-logo.png` tem fundo roxo queimado sem alpha; favicon sem `prefers-color-scheme`.
- **Cleanup shadcn**: `badge.tsx` variantes `success`/`warning` com hsl literal; `button.tsx` variant `gradient` com `text-white`; `input.tsx` `dark:text-white` redundante. **Os tokens `--success`/`--warning` JÁ EXISTEM em `:root` — só não foram cabeados em `tailwind.config.ts` como cores Tailwind.** Conectar é trivial.

### Pseudo-problemas (NÃO TOCAR, são intencionais)
- `CreateStageDialog` `PRESET_COLORS` — paleta de cor pro usuário **escolher** ao criar tag (são dados).
- `AdminKanbanPage` seed de estágios — mesma coisa (dados, não chrome).
- `EmailPreviewDialog` template HTML com `color:#1a1a1a;background:#fff;...` — vai ser **enviado por e-mail**, renderiza em Gmail/Outlook do destinatário onde CSS vars do app não existem. Manter literal.
- Overlays `bg-black/80` em `dialog`/`alert-dialog`/`sheet`/`drawer` — padrão oficial shadcn, funciona em ambos.

### Métricas brutas da auditoria (referência)
- Total: 127 ocorrências hardcoded em 31 arquivos.
- Risco por área: `ui/`=low, `pages/admin/`=low, `pages/super-admin/`=low, `comp-grupoB`=medium, `layouts/css`=medium, `comp-grupoA(dashboards)`=high, `charts`=high, `brand/assets`=high.
- Charts e dashboards (10 arquivos) concentram ~70% do risco real → vão pro T-007.
- Bugs no `<main>` dos layouts (2 ocorrências, 2 arquivos) + cleanup LoginPage (2 ocorrências, 1 arquivo) = **escopo cirúrgico do T-006**.

### Esforço estimado
| Fase | Cards | Horas | O que entrega |
|---|---|---|---|
| 1 (MVP) | T-006 | 4–6h | Toggle funciona, navegação principal dark coerente |
| 2 (Charts) | T-007 | 6–10h | Dashboards adaptativos, sem buraco branco em gráficos |
| 3 (Marca + polimento) | T-008 | 4–6h | Logos OK, tokens novos, cleanup, QA visual completo |
| **Total** | 3 PRs | **14–22h** | Dark mode production-grade |

---

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
