# 🔍 Auditoria de Sistema — GLEPS CRM

> Revisão completa (código + estrutura + gaps de produto) do CRM multi-tenant de WhatsApp.
> Gerada por auditoria multi-agente (8 dimensões + verify adversarial por finding + análise de gaps).
> Branch: `Variação-Principal` · Data: 2026-07-10

## Sumário executivo

**37 problemas** verificados (após dedup) + **8 lacunas de produto**. Todos os itens abaixo têm evidência no código real e passaram por um verificador adversarial (marcados `CONFIRMED` quando há prova cabal, `PLAUSÍVEL` quando provável mas sem prova completa).

| Severidade | Qtd | O que significa |
|---|---|---|
| 🔴 Crítico | 2 | Corrigir antes de escalar uso — segurança/dados |
| 🟠 Alto | 8 | Corrigir em breve — impacto real em operação/segurança |
| 🟡 Médio | 16 | Planejar — degrada qualidade/robustez |
| ⚪ Baixo | 11 | Backlog — polimento/hardening |

### ⚠️ Destaques que exigem ação imediata

- 🔴 **Secrets de producao com fallback publico no docker-compose passam na validacao zod (boot silencioso com chave JWT conhecida)** — Se o operador esquecer de setar JWT_SECRET/REFRESH_TOKEN_SECRET na UI do EasyPanel, o backend sobe normalmente assinando tokens com um segredo mundialmente conhecido (esta no repo publico). Qualquer p
- 🔴 **Seed legado cria 3 super_admins com senha padrao Admin@123 em qualquer deploy novo (RUN_SEED default true)** — Numa instalacao nova de producao os 3 super_admins nascem com a senha publica Admin@123 e emails conhecidos (repo publico). Atacante loga como super_admin e assume todos os tenants. O upsert so grava 

### 🔗 Relação com as correções recém-entregues

- A liberação do chat para agentes (commit `9309ae0`) torna mais relevante o item **"Endpoints de mensagem não aplicam o guard de acesso do agente"** (IDOR intra-tenant): o backend precisa escopar `GET/POST /messages` por agente, não só a listagem de conversas. Recomendo priorizar.
- Vários itens de chat/socket (broadcast tenant-wide, rascunho vaza entre conversas) afetam diretamente a experiência de atendimento.

---

## 🔴 CRÍTICO (2)

### 🔴 Secrets de producao com fallback publico no docker-compose passam na validacao zod (boot silencioso com chave JWT conhecida)

- **Categoria:** Segurança
- **Local:** `docker-compose.yml:59`
- **Status:** CONFIRMED
- **Evidência:** JWT_SECRET: ${JWT_SECRET:-your-production-jwt-secret-min-32-characters} (linha 59), REFRESH_TOKEN_SECRET: ${...:-your-production-refresh-secret-min-32} (61), DB_PASSWORD:-gleps_secret (34/58). Os defaults tem 44 e 37 chars, passando o env.ts z.string().min(32) sem erro. O repo e publico.
- **Impacto:** Se o operador esquecer de setar JWT_SECRET/REFRESH_TOKEN_SECRET na UI do EasyPanel, o backend sobe normalmente assinando tokens com um segredo mundialmente conhecido (esta no repo publico). Qualquer pessoa forja um JWT valido de qualquer usuario/super_admin -> bypass total de auth em todos os tenants. Igual para a senha do Postgres.
- **Recomendação:** Remover os defaults inseguros do docker-compose (usar ${JWT_SECRET:?JWT_SECRET obrigatorio}) ou adicionar guard no env.ts que rejeita os valores-placeholder conhecidos em NODE_ENV=production. Nunca embutir segredo funcional em arquivo versionado.

### 🔴 Seed legado cria 3 super_admins com senha padrao Admin@123 em qualquer deploy novo (RUN_SEED default true)

- **Categoria:** Segurança
- **Local:** `backend/src/prisma/seed.ts:10`
- **Status:** CONFIRMED
- **Evidência:** seed.ts hash 'Admin@123' e upsert de criticalAdmins = superadmin@sistema.com, admin@gleps.com.br, glepsai@gmail.com com role super_admin. docker-compose linha 72: RUN_SEED: ${RUN_SEED:-true}. Em DB novo sem marker _system_meta (RESET_DB_FORCE nao setado), start.sh linha 209 roda 'node dist/prisma/seed.js'.
- **Impacto:** Numa instalacao nova de producao os 3 super_admins nascem com a senha publica Admin@123 e emails conhecidos (repo publico). Atacante loga como super_admin e assume todos os tenants. O upsert so grava passwordHash no create, entao a janela ate alguem trocar a senha e critica.
- **Recomendação:** Nao criar super_admins hardcoded no seed de producao; usar o fluxo do start.sh (SUPER_ADMIN_EMAIL/PASSWORD via env) e forcar troca de senha no primeiro login. Manter RUN_SEED=false por padrao em prod.

---

## 🟠 ALTO (8)

### 🟠 Endpoints de mensagem nao aplicam o guard de acesso do agente (leitura e envio cross-agente dentro do tenant)

- **Categoria:** Auth/RBAC
- **Local:** `backend/src/controllers/message.controller.ts:292`
- **Status:** CONFIRMED
- **Evidência:** list(): `const data = await messageService.list(conversationId, accountId, {...})` — passa apenas conversationId+accountId; NUNCA chama conversationService.ensureConversationAccess/getActor. messageService.list -> ensureConversation() so valida `where: { id: conversationId, accountId }`. create() (linha 367) idem: `messageService.create(accountId, input)` sem ensureConversationAccess. Contraste: TODOS os handlers de conversation.controller.ts (assign L303, transfer L343, status L263, priority L283, resolve/reopen L480, cycles L622) chamam `ensureConversationAccess(id, getAccountId(req), getActor(req))`, e conversationService.get() aplica assertAgentCanAccess (assignee/team/participant). Prova de que a intencao existe: message.service SearchOptions L87-93 foi feito de proposito para escopar a busca do agente 'para evitar exfiltracao de PII via ILIKE em toda a conta' — mas o list/create diretos ficaram sem essa protecao.
- **Impacto:** Um agente autenticado pode ler o historico completo (GET /conversations/:id/messages) de QUALQUER conversa da conta, inclusive as atribuidas a outros agentes — vazamento de PII/conteudo de clientes entre agentes. Pior: pode ENVIAR mensagem (POST /conversations/:id/messages) em qualquer conversa da conta, disparando WhatsApp real para o cliente em nome do atendimento sem estar atribuido — write cross-agente e impersonation dentro do tenant. O isolamento por agente que o conversation.service garante e contornavel pela camada de mensagens.
- **Recomendação:** Em message.controller.list e create (e markRead/reactions), chamar conversationService.ensureConversationAccess(conversationId, accountId, getActor(req)) antes de listar/criar, exatamente como conversation.controller faz. Alternativamente propagar o actor ate messageService.list/ensureConversation e reusar assertAgentCanAccess.

### 🟠 Superficie dupla de gestao de usuarios: /api/users permite ao admin de conta criar/promover/deletar outros admins, driblando os guardrails de /api/admin/users

- **Categoria:** Auth/RBAC
- **Local:** `backend/src/controllers/user.controller.ts:87`
- **Status:** CONFIRMED
- **Evidência:** user.controller (rota /api/users, protegida so por requireAdmin em user.routes.ts L10-14, que aceita 'admin') tem regras FRACAS: create() L92-101 bloqueia apenas role==='super_admin' -> admin PODE criar outro admin; update() L128-134 bloqueia apenas super_admin -> admin PODE promover agent->admin; delete() L147-174 checa so accountId e nao-self -> admin PODE deletar um co-admin e NAO ha guard de ultimo-admin. Isso contradiz admin-user.controller.ts (rota /api/admin/users, T-024), que foi construido justamente para impedir: 'Admin NAO super pode criar OUTRO admin' (L105-107 CANNOT_MANAGE_OTHER_ADMIN), bloqueio de promover para admin (L177-179), e protecao de ultimo admin countActiveAdminsInAccount (L186-190 e L230-235 CANNOT_REMOVE_LAST_ADMIN).
- **Impacto:** As protecoes de privilegio criadas em T-024 (admin nao gerencia outros admins; nao remover o ultimo admin) sao completamente contornaveis: basta o admin usar os endpoints legados /api/users em vez de /api/admin/users. Um admin pode inflar admins, rebaixar/derrubar co-admins e desfazer a governanca de papeis da propria conta.
- **Recomendação:** Unificar a gestao de usuarios num unico caminho. Ou remover os handlers de mutacao de /api/users para role 'admin' (restringir a requireSuperAdmin), ou portar as mesmas regras do admin-user.controller (bloqueio admin-cria-admin, promover, e guard de ultimo admin) para user.controller.create/update/delete.

### 🟠 Mensagem com multiplos anexos: so o primeiro e enviado ao WhatsApp; o resto some silenciosamente

- **Categoria:** Chat/Mensagens
- **Local:** `backend/src/controllers/message.controller.ts:462`
- **Status:** CONFIRMED
- **Evidência:** No dispatch outbound o controller pega apenas `const firstAttachment = ... ? parsed.attachments[0] : null;` e despacha SOMENTE esse item (sendWhatsAppAudio/sendMedia). Nao ha loop sobre parsed.attachments. Porem messageService.create() persiste TODOS os anexos (createNestedAttachments = plans.filter(...create).map(...)). O frontend permite multi-selecao: MessageComposer.tsx:890 `const files = Array.from(e.target.files ?? [])` + input `multiple` (linha 1127), e envia todos em `attachments: attachments.length > 0 ? attachments : undefined` (linha 494).
- **Impacto:** Agente anexa 3 imagens numa unica mensagem: o CRM mostra as 3 no bubble como 'enviadas', mas o cliente no WhatsApp recebe apenas a primeira. Perda de mensagem 100% silenciosa, sem status=failed nem toast. Documentos/comprovantes enviados em lote nunca chegam ao cliente.
- **Recomendação:** Iterar sobre TODOS os parsed.attachments no dispatch (um send por anexo, na ordem), ou rejeitar no schema mensagens com mais de 1 anexo ate haver suporte de fan-out. Reconciliar status por anexo.

### 🟠 Reserva de externalId 'pending:<uuid>' NAO fecha a race com o webhook fromMe: gera duplicata + mensagem entregue marcada como failed

- **Categoria:** Webhook Evolution
- **Local:** `backend/src/controllers/message.controller.ts:547`
- **Status:** CONFIRMED
- **Evidência:** SE-H5 reserva `externalId = pending:<uuid>` (linha 348) para deduplicar. Mas o webhook MESSAGES_UPSERT fromMe=true chega com o messageId REAL e o guard de idempotencia procura por esse id: evolution.controller.ts:888 `findFirst({ where: { conversationId, externalId: messageId } })`. Como a linha do agente ainda tem `pending:<uuid>`, o findFirst NAO acha e o webhook cria uma SEGUNDA row via messageService.create com senderType='agent' e externalId real (evolution.controller.ts:972). Depois o controller roda `prisma.message.update({ where:{id}, data:{ externalId: result.messageId }})` (linha 547) que viola `@@unique([conversationId, externalId])` (schema.prisma:36) -> P2002. P2002 NAO e ValidationError/NotFoundError, entao cai no catch generico (linha 574) -> messageService.markFailed. O comentario na linha 542-546 afirma que a colisao 'vai falhar silenciosamente ... continua integra', o que e falso: ela marca a mensagem entregue como failed.
- **Impacto:** Sob concorrencia (webhook chega antes do update), a mensagem REALMENTE entregue ao cliente aparece duplicada na thread E a original fica status=failed (UI mostra erro/botao reenviar). O agente reenvia -> terceira copia entregue ao cliente. Inconsistencia de status + duplicidade real de mensagens.
- **Recomendação:** No catch, tratar Prisma P2002 do update como caso de sucesso (o webhook ja materializou a msg com o id real): remover/mesclar a row pending em vez de markFailed, ou fazer o update via updateMany condicionado e reconciliar. Alternativamente, deixar o webhook fromMe reconciliar a row pending por metadata.pendingExternalId antes de inserir nova.

### 🟠 Mass-assignment permite sobrescrever accountId e gravar em outro tenant (email/campanhas)

- **Categoria:** Multi-tenancy
- **Local:** `backend/src/controllers/email.controller.ts:83`
- **Status:** CONFIRMED
- **Evidência:** createCadence: `await emailService.createCadence({ accountId, ...req.body, createdBy: userId })`. accountId (derivado de req.user via getAccountId) vem ANTES de `...req.body`, entao um accountId presente no corpo JSON sobrescreve o valor confiavel. O service persiste direto: `prisma.emailCadence.create({ data: { accountId: data.accountId, ... } })`. getAccountId retorna apenas `req.user?.accountId`, sem validacao. Mesmo padrao em createTemplate (linha 155), createRule (linha 331) e campaign.controller.ts create (linha 31).
- **Impacto:** Um usuario autenticado (admin ou agente com permissao 'emails') envia `{"accountId":"<uuid-de-outra-conta>", ...}` e cria cadencias, templates, regras e campanhas dentro de QUALQUER outro tenant. Quebra a garantia central de isolamento multi-tenant ('toda query DEVE ser escopada por conta') permitindo escrita cross-tenant / poluicao de dados de outro cliente.
- **Recomendação:** Nunca espalhar req.body sobre campos de identidade. Inverter a ordem para `{ ...req.body, accountId, createdBy }` (accountId sobrescreve o body) OU, preferivel, validar req.body com um schema zod que NAO inclua accountId/createdBy (whitelist) antes de chamar o service. Aplicar em createCadence, createTemplate, createRule e campaign.create.

### 🟠 SSRF no download de midia: fetchFromHttp busca URL arbitraria vinda do webhook sem SSRF guard

- **Categoria:** Segurança
- **Local:** `backend/src/services/attachment-storage.service.ts:349`
- **Status:** CONFIRMED
- **Evidência:** Em materialize(): `} else if (isAbsoluteHttp(sourceUrl)) { const fetched = await this.fetchFromHttp(accountId, sourceUrl); }` onde `sourceUrl = att.sourceUrl || att.fileUrl` — valor populado a partir do payload do webhook Evolution (evolution.controller monta attachment a partir de node.fileUrl/mediaUrl). fetchFromHttp (linha 221) faz `fetch(url, ...)` sem allowlist nem validacao de destino. Contraste: os webhooks OUTBOUND ja usam `safeFetch`/isSafeOutboundUrl (ssrf-guard.ts) — essa protecao NAO é aplicada aqui.
- **Impacto:** Combinado com o webhook spoofavel (finding anterior) ou com uma Evolution comprometida/mal-configurada, um atacante define uma mediaUrl apontando para servicos internos (ex.: http://169.254.169.254/latest/meta-data, http://localhost:3000, hosts RFC1918). O backend faz a requisicao server-side (SSRF cego); mensagens de erro chegam a incluir a URL, permitindo alguma exfiltracao/port-scan interno.
- **Recomendação:** Passar sourceUrl por isSafeOutboundUrl()/safeFetch antes do fetch em fetchFromHttp, bloqueando loopback, RFC1918, link-local (169.254.0.0/16) e hosts .internal/.local — reutilizando o mesmo ssrf-guard ja aplicado nos webhooks outbound.

### 🟠 Rascunho do composer (texto/anexos/nota) vaza entre conversas — risco de enviar mensagem para o contato errado

- **Categoria:** Chat/Mensagens
- **Local:** `src/components/chat/MessageComposer.tsx:234`
- **Status:** CONFIRMED
- **Evidência:** MessageComposer mantém `content`, `pending`, `isPrivate`, `cannedOpen` em useState (linha 234+). Não há `key={conversationId}` em `<ConversationThread>` (AdminChatPage.tsx:208) nem em `<MessageComposer>` (ConversationThread.tsx:1255), e nenhum useEffect reseta content/pending/isPrivate quando `conversationId` muda. Os únicos effects com dep [conversationId] são o de typing cleanup (só limpa timeout) e o de abortar gravação (não toca em content/pending). Como só o prop conversationId muda, o React reconcilia a MESMA instância — o state persiste.
- **Impacto:** Ao digitar um rascunho na conversa A e clicar na conversa B sem enviar, o texto (e anexos pendentes) continuam no composer da conversa B. Pressionar Enter envia o conteúdo de A para o contato de B no WhatsApp. Anexos com URL.createObjectURL também nunca são revogados na troca (memory leak secundário).
- **Recomendação:** Adicionar `key={conversationId}` no <MessageComposer> (força remount limpo por conversa) OU um useEffect com dep [conversationId] que faça setContent(''), setPending([]) (revogando previewUrls), setIsPrivate(false), setCannedOpen(false).

### 🟠 start.sh inicia o servidor mesmo com migrations falhando ('funcionalidade parcial')

- **Categoria:** Estrutura/Arquitetura
- **Local:** `backend/scripts/start.sh:169`
- **Status:** CONFIRMED
- **Evidência:** start.sh linhas 169 e 177: apos falha de 'prisma migrate deploy' (mesmo depois do recovery de P3009, ou para erros que nao sao P3009) faz 'echo Iniciando servidor mesmo assim (funcionalidade parcial)' e cai no 'exec node dist/server.js'.
- **Impacto:** Um deploy com schema desatualizado/parcial sobe em producao e comeca a atender requests. Colunas/tabelas faltando geram erros Prisma em runtime, respostas 500 intermitentes e risco de escrita inconsistente. O healthcheck passa (server responde /api/health) mascarando o problema para o orquestrador.
- **Recomendação:** Falhar o boot (exit 1) quando migrate deploy nao concluir, deixando o container reiniciar/parar visivelmente em vez de servir estado inconsistente. Alertar via Sentry/log estruturado no fail.

---

## 🟡 MÉDIO (16)

### 🟡 Webhook Evolution aceita eventos sem autenticacao quando a conta nao tem evolutionWebhookSecret (injecao de mensagens/opt-out num tenant conhecido)

- **Categoria:** Webhook Evolution
- **Local:** `backend/src/controllers/evolution.controller.ts:241`
- **Status:** CONFIRMED
- **Evidência:** if (!account.evolutionWebhookSecret || account.evolutionWebhookSecret.trim() === '') { logger.warn('[evolution-webhook] webhook unauth recebido - account sem evolutionWebhookSecret (modo permissivo)', ...) } ... (linha 389) 'Modo permissivo total: account sem secret. ... Nao validamos NADA - apenas processamos.' O accountId vem do path param POST /api/evolution/webhook/:accountId e o handler processa messages.upsert (processNewMessage cria conversas/mensagens/contatos) e opt-out (handleInboundOptOut) sem exigir HMAC nem token quando o secret nao esta setado.
- **Impacto:** Se um tenant nunca configurou evolutionWebhookSecret (modo onboarding), qualquer parte que conheca o UUID da conta pode enviar POSTs forjados para /api/evolution/webhook/:accountId e injetar mensagens inbound falsas, criar contatos/conversas e disparar opt-out de WhatsApp naquele tenant especifico, sem qualquer credencial. Nao vaza dados cross-tenant, mas permite manipulacao de dados de um tenant alvo por ator nao autenticado.
- **Recomendação:** Bloquear em runtime integracoes sem secret (mesmo padrao ja adotado em inbound-integration.service BUG-002, que retorna 401 quando integration.secret e nulo) ou, no minimo, exigir HMAC/token sempre em producao independentemente do secret existir, e provisionar evolutionWebhookSecret obrigatoriamente na criacao do Inbox WhatsApp.

### 🟡 Eventos de conversa sao broadcast para a sala da conta inteira, ignorando o RBAC de agente (leak intra-tenant de conversas nao atribuidas)

- **Categoria:** Chat/Mensagens
- **Local:** `backend/src/socket/index.ts:444`
- **Status:** CONFIRMED · _conhecido/backlog_
- **Evidência:** emitConversationUpdated: chatNs.to(roomConv(accountId, conversationId)).emit('conversation:updated', payload); chatNs.to(roomAccount(accountId)).emit('conversation:updated', payload); (linha 459) emitConversationAssigned: chatNs.to(roomAccount(accountId)).emit('conversation:assigned', payload). roomAccount(accountId) = account:${accountId} e TODO socket autenticado faz socket.join(roomAccount(accountId)) na linha 219. Em contraste, conversationService.list() (conversation.service.ts:234) restringe agentes a conversas onde sao assignee/participante/time.
- **Impacto:** Um agent cujo acesso via REST e limitado (list() so devolve conversas dele) ainda recebe via socket o payload de conversation:updated/conversation:assigned de TODAS as conversas da conta - incluindo dados de conversas de outros agentes que ele nao deveria enxergar. E um leak de RBAC dentro do mesmo tenant (nao cross-tenant), mas contorna a restricao de visibilidade por agente.
- **Recomendação:** Emitir conversation:updated/assigned apenas para a sala especifica da conversa (roomConv) e para as salas dos usuarios/times com acesso (assignee, participantes, membros do time), em vez de roomAccount.

### 🟡 Retry reenvia mensagens de midia/audio como texto puro, perdendo o anexo

- **Categoria:** Chat/Mensagens
- **Local:** `backend/src/controllers/message.controller.ts:666`
- **Status:** CONFIRMED
- **Evidência:** POST /messages/:id/retry so faz `evolutionService.sendText(accountId, { number, text: message.content, ... })` (linha 666). Nao inspeciona attachments/contentType. Uma mensagem de imagem que falhou (status=failed) e tinha caption sera reenviada como TEXTO da caption, sem a imagem. Audio-only (content null) e bloqueado em 654 ('Mensagem sem conteudo nao pode ser reenviada'), entao PTT falho nunca reenvia.
- **Impacto:** Reenvio de mensagem de midia que falhou entrega ao cliente apenas o texto/caption sem o arquivo; audio falho nao pode ser reenviado de forma alguma. Inconsistencia entre o que o CRM mostra (com anexo) e o que o cliente recebe.
- **Recomendação:** No retry, carregar os attachments da mensagem e re-despachar pelo mesmo roteamento do create() (audio->sendWhatsAppAudio, image/video/document->sendMedia); permitir retry de mensagens de midia sem content.

### 🟡 Rota de integracao (ai_bot/n8n) persiste anexos mas nunca os envia ao WhatsApp

- **Categoria:** Capacidade faltante
- **Local:** `backend/src/controllers/message.controller.ts:963`
- **Status:** CONFIRMED · _conhecido/backlog_
- **Evidência:** Em createFromIntegration, `shouldDispatch = !isPrivate && typeof parsed.content === 'string' && parsed.content.trim() !== ''` (linha 963) — so considera texto. O dispatch (linha 1000) so chama sendText. Porem integrationCreateBodySchema aceita `attachments` (linha 231) e messageService.create os persiste. Se a integracao manda attachments-only (sem content), shouldDispatch=false -> mensagem criada com status default 'sent' (message.service.ts:450) e NUNCA despachada, sem markFailed.
- **Impacto:** IA/n8n que tenta enviar imagem/audio/documento via /api/integrations/chat tem o anexo gravado como 'sent' no CRM mas o cliente nunca recebe nada — perda silenciosa. Bloqueia o envio de midia pela API externa da IA.
- **Recomendação:** Implementar roteamento de midia (sendMedia/sendWhatsAppAudio) tambem na rota de integracao, espelhando o create() JWT; enquanto nao houver, rejeitar attachments no integrationCreateBodySchema com 422 para nao gravar 'sent' fantasma.

### 🟡 messageId vazio da Evolution deixa a mensagem presa em 'pending:' com status inconsistente

- **Categoria:** Integridade de dados
- **Local:** `backend/src/controllers/message.controller.ts:541`
- **Status:** CONFIRMED
- **Evidência:** O update do externalId/status so ocorre `if (result.messageId)` (linha 541). extractMessageId (evolution.service.ts:367) retorna '' quando o corpo 2xx da Evolution nao tem key.id/messageId/... em nenhum dos formatos conhecidos. Nesse caso o update nao roda: a mensagem fica com externalId='pending:<uuid>' e status='sent' (default do create).
- **Impacto:** A mensagem pode ter sido entregue, mas fica eternamente 'pending': editar/deletar/reagir/quotar sao bloqueados (todos guardam contra externalId.startsWith('pending:')), o ACK delivered/read por externalId nunca reconcilia, e o webhook fromMe cria uma duplicata (o guard de idempotencia por externalId real nao acha a row pending).
- **Recomendação:** Se result.messageId vier vazio apos 2xx, logar em error e marcar a mensagem (ex.: metadata.dispatchWarning) ou tratar como falha reconciliavel; nunca deixar 'pending:' como estado final de uma mensagem despachada com sucesso.

### 🟡 updateCadence espalha req.body cru no data do Prisma (permite reatribuir accountId do proprio registro)

- **Categoria:** Multi-tenancy
- **Local:** `backend/src/services/email.service.ts:247`
- **Status:** CONFIRMED
- **Evidência:** updateCadence recebe `data` = req.body direto do controller (`emailService.updateCadence(req.params.id, accountId, req.body)`) e faz `const updateData: any = { ...data };` seguido de `prisma.emailCadence.updateMany({ where: { id, accountId }, data: updateData })`. Como accountId é coluna valida, um body com `{"accountId":"<outro-tenant>"}` passa no WHERE (registro proprio) mas altera a coluna accountId no SET, movendo o registro para outra conta. Padrao de spread cru repetido em outros update* do service.
- **Impacto:** Um usuario pode reatribuir/mover seus proprios registros (cadencias, e provavelmente templates/regras) para outro tenant, alem de setar campos nao previstos no contrato. Vaza dados para/entre contas e quebra a invariante de escopo por conta.
- **Recomendação:** Validar req.body com schema zod de whitelist (sem accountId/id/createdAt) antes de repassar, ou desestruturar explicitamente os campos permitidos em vez de `{ ...data }`.

### 🟡 getByStage carrega TODOS os contatos de um estágio sem take/limit (Kanban)

- **Categoria:** Prisma/Banco
- **Local:** `backend/src/services/contact.service.ts:571`
- **Status:** CONFIRMED
- **Evidência:** async getByStage(accountId, tagId) { const contacts = await prisma.contact.findMany({ where: { accountId, leadTags: { some: { tagId } } }, include: { leadTags: { include: { tag: {...} } }, _count: { select: { sales: true } } }, orderBy: { updatedAt: 'desc' } }); — sem take. Exposto em GET /tags/:id/contacts (tag.controller.ts:176) que também não passa paginação.
- **Impacto:** Cada coluna do Kanban busca a totalidade dos leads daquele estágio (estágios de topo de funil acumulam milhares de contatos), com include de leadTags+tag e subquery _count sales por linha. Query pesada + payload gigante a cada abertura do board; degrada com o crescimento da base e pode estourar memória/timeout do nginx.
- **Recomendação:** Adicionar take (ex.: 100) + paginação por cursor/offset no getByStage e no endpoint; carregar contadores agregados por estágio separadamente e paginar os cards ao rolar a coluna.

### 🟡 Consultas de receita/finance filtram por Sale.paidAt sem índice em paidAt

- **Categoria:** Prisma/Banco
- **Local:** `backend/prisma/schema.prisma:593`
- **Status:** CONFIRMED
- **Evidência:** Model Sale só tem @@index em accountId, contactId, status, responsavelId, createdAt — nenhum em paidAt. Porém as queries quentes filtram por paidAt: finance.service.ts:138 `paidAt: { gte, lte }` (getRevenueChart), insights.service.ts:127 (getTemporalAnalysis), além de getProductAnalysis/getPaymentMethods/overview (where: { accountId, status:'paid', paidAt: {...} }). São 8 filtros de range em paidAt nos services.
- **Impacto:** Todos os gráficos de receita e análises temporais/produtos filtram por janela de paidAt sem índice de suporte. Postgres usa o índice de accountId/status e faz filtro residual em paidAt, varrendo todas as vendas da conta a cada carga de dashboard/financeiro. Custo cresce linearmente com o volume de vendas do tenant.
- **Recomendação:** Criar índice composto @@index([accountId, status, paidAt]) (ou ao menos [accountId, paidAt]) em Sale via migration, casando com o padrão where accountId+status='paid'+paidAt range.

### 🟡 Métricas de chat/ciclos agregam em memória carregando rowsets ilimitados

- **Categoria:** Prisma/Banco
- **Local:** `backend/src/services/chat-metrics.service.ts:357`
- **Status:** CONFIRMED
- **Evidência:** getMetrics faz `prisma.conversation.findMany({ where: { accountId, OR:[createdAt range, resolvedAt range] }, select:{...} })` (357) SEM take, depois `conversationCycle.findMany` (392) e `sLABreach.findMany` (442) também sem take, e faz totalConversations/openConversations/resolvedByAi via .filter() em JS. Mesmo padrão em conversation-cycle.service.ts:381 (getMetrics) — findMany de todos os ciclos da janela e agregação com .filter no Node.
- **Impacto:** Numa conta movimentada, o dashboard de chat carrega dezenas de milhares de conversas/ciclos/breaches inteiros para a memória do Node só para contar/mediar em JS. Uso de memória e latência crescem sem limite com o histórico; contagens que deveriam ser count()/groupBy no banco são feitas no app.
- **Recomendação:** Trocar as agregações por prisma count()/groupBy()/aggregate() no banco (ex.: groupBy status, groupBy resolvedBy) em vez de findMany+filter; se precisar de amostras para percentis, paginar/limitar. sLABreach.findMany por breachedAt também carece de @@index([breachedAt]).

### 🟡 sla.checkBreaches: N+1 de message.findMany por conversa no cron

- **Categoria:** Prisma/Banco
- **Local:** `backend/src/services/sla.service.ts:400`
- **Status:** CONFIRMED · _conhecido/backlog_
- **Evidência:** checkBreaches faz findMany de até 5000 conversations (take:5000) e, dentro do `for (const conversation of conversations)`, quando policy.pauseWhenWaitingCustomer é true executa `prisma.message.findMany({ where: { conversationId: conversation.id, isPrivate:false }, orderBy, select })` (400) por conversa, mais createBreachIfMissing→sLABreach.create por breach.
- **Impacto:** Com política pause-when-waiting ativa, o cron dispara uma query de mensagens por conversa aberta (até 5000 round-trips por execução), cada uma varrendo a thread inteira. A cada tick do cron o banco leva rajada de queries; escala mal com número de conversas abertas.
- **Recomendação:** Buscar mensagens em lote (findMany com conversationId in [...] agrupando em memória) ou materializar o tempo de espera acumulado por ciclo (ConversationCycle) atualizado incrementalmente, evitando recomputar a thread inteira a cada tick.

### 🟡 sale.refundItem executa update+count+update sem transação (financeiro)

- **Categoria:** Integridade de dados
- **Local:** `backend/src/services/sale.service.ts:357`
- **Status:** CONFIRMED
- **Evidência:** refundItem faz `prisma.saleItem.update({...refunded:true})` (357), depois `prisma.saleItem.count({ where:{ saleId, refunded:false } })` (367) e `prisma.sale.update({ status: newStatus })` (374) — três chamadas independentes, sem prisma.$transaction envolvendo. (Comparar com sale.create que usa nested create atômico.)
- **Impacto:** Operação financeira não-atômica: crash entre o update do item e o update do sale deixa item marcado como refunded mas status da venda incoerente (nunca vira refunded/partial_refund). Dois estornos concorrentes de itens da mesma venda podem ambos ler nonRefundedItems>0 e gravar 'partial_refund' quando na verdade todos foram estornados (deveria ser 'refunded').
- **Recomendação:** Envolver os três passos em prisma.$transaction (recalcular status dentro da tx) e, para concorrência, usar lock (SELECT ... FOR UPDATE via $executeRaw ou advisory lock por saleId) antes de recomputar o status.

### 🟡 Buffer de listeners pré-connect é código morto: subscribe() nunca enfileira, H-DASH-3 não está realmente implementado

- **Categoria:** Chat/Mensagens
- **Local:** `src/services/socket.client.ts:328`
- **Status:** CONFIRMED
- **Evidência:** O método subscribe() (linha 328) faz: `if (!this.socket) { console.warn(...); return () => {}; }` e depois `socket.on(event, cb)`. Ele NUNCA faz push em `this.pendingSubscriptions`. O buffer declarado na linha 155 e o `flushPendingSubscriptions()` chamado por connect() (linha 203) existem, mas `grep -rn pendingSubscriptions` mostra que NADA popula o array (só iterações de reset em connect/disconnect). O comentário H-DASH-3 (linha 143) diz que o buffer conserta o caso 'efeito filho monta e faz subscribe antes do connect() do layout pai' — mas a correção não está ligada.
- **Impacto:** Qualquer componente que faz subscribe SEM chamar connect() antes perde o listener silenciosamente (retorna no-op e nunca é reanexado). AdminChatDashboardPage (live-attendance) faz exatamente isso: subscribe em conversation:updated sem connect próprio (confirmado: nenhum connect() no arquivo). Como efeitos de filhos rodam antes dos pais no React, no mount inicial o socket ainda é null → listener descartado → o dashboard 'Atendimento ao vivo' fica sem tempo-real e só atualiza pelo polling de 15s. É o exato sintoma ('live-attendance congelado') que o comentário afirma ter corrigido.
- **Recomendação:** Em subscribe(), quando `this.socket` for null, criar a entrada `{ event, cb, attached:false }`, dar push em pendingSubscriptions, e retornar um unsubscribe que remova do buffer (e faça socket.off se já anexado). Assim flushPendingSubscriptions() no connect() passa a reanexar de fato.

### 🟡 Reabertura concorrente cria ciclos de conversa duplicados (open cycles orfaos)

- **Categoria:** Integridade de dados
- **Local:** `backend/src/services/conversation-cycle.service.ts:138`
- **Status:** CONFIRMED
- **Evidência:** openCycle() faz `const existingOpen = await this.findOpenCycle(...)` (linha 143) e, se null, cria um novo ConversationCycle + seta Conversation.openCycleId numa transacao curta (linhas 151-164). Nao ha unique/partial-index protegendo 1 ciclo aberto por conversa: no schema.prisma o model ConversationCycle (linhas 1352-1387) tem apenas @@index([conversationId]) — nenhum @@unique nem indice parcial WHERE resolved_at IS NULL. findOpenCycle usa o fast-path `conv.openCycleId` (linha 117), que fica NULL apos closeCycle (linha 230 seta openCycleId:null). maybeReopen (conversation.service.ts:1899) chama openCycle sem guard de concorrencia.
- **Impacto:** Evolution faz retry agressivo e o proprio codigo documenta '3 mensagens em 1s' (conversation.service.ts:1752). Duas mensagens inbound quase simultaneas numa conversa RESOLVIDA disparam duas execucoes de maybeReopen->openCycle; ambas leem openCycleId=NULL e o fallback resolvedAt:null nao encontra nada, entao ambas criam um ConversationCycle. Conversation.openCycleId aponta so pro ultimo; o outro ciclo fica orfao com resolvedAt=NULL para sempre. Como incrementMessageCount/recordFirstResponse usam o fast-path openCycleId (linha 117), o ciclo zumbi nunca recebe mensagens nem resolucao. getMetrics (linhas 393-395) conta esse orfao em totalCycles e openCycles permanentemente inflados, distorcendo KPIs de atendimento.
- **Recomendação:** Adicionar indice unico parcial em conversation_cycles (conversation_id) WHERE resolved_at IS NULL (mesma tecnica da migration 0028 usada para conversations), e envolver o create de openCycle num try/catch P2002 que faz re-find do ciclo aberto vencedor — espelhando o padrao ja usado em findOrCreateForCustomer/resolveOrCreateContact.

### 🟡 Round-robin de atribuicao nao e atomico e usa updatedAt (bumped por qualquer mensagem) como ponteiro

- **Categoria:** Chat/Mensagens
- **Local:** `backend/src/services/team.service.ts:284`
- **Status:** CONFIRMED
- **Evidência:** pickAssignee determina o proximo agente lendo `prisma.conversation.findFirst({ where:{accountId,teamId,assigneeId:{in:memberIds}}, orderBy:{updatedAt:'desc'} })` (linhas 284-292) e retorna activeMembers[(lastIndex+1)%n]. Nao ha lock nem escrita atomica do ponteiro. E o campo de ordenacao updatedAt e bumpado em TODA mensagem: message.service.ts:485 `convUpdate = { updatedAt: now }` no create de qualquer mensagem (customer ou agent).
- **Impacto:** 1) Race: duas conversas novas criadas ao mesmo tempo (dois webhooks inbound) chamam pickAssignee em paralelo, leem a MESMA lastAssignment e ambas calculam o mesmo nextIndex -> o mesmo agente recebe as duas, quebrando o balanceamento. 2) Corrupcao do ponteiro: como a ordenacao e por updatedAt e nao por momento-da-atribuicao, quando uma conversa antiga do agente X recebe nova mensagem seu updatedAt vira 'agora' e o round-robin volta a apontar pra X+1, ignorando as atribuicoes recentes. O rodizio segue o trafego de mensagens, nao a ordem de distribuicao — agentes ativos recebem sistematicamente mais conversas.
- **Recomendação:** Basear o ponteiro num evento imutavel de atribuicao (ex.: Event conversation.assigned mais recente, ou uma coluna lastRoundRobinAssignedAt no Team atualizada atomicamente) em vez de Conversation.updatedAt, e serializar a selecao (advisory lock por teamId ou update atomico de um contador de posicao) para evitar que dois picks concorrentes retornem o mesmo membro.

### 🟡 Estado do servidor 100% em memoria (Socket.IO sem adapter + crons no processo) impede replicas — SPOF do backend

- **Categoria:** Estrutura/Arquitetura
- **Local:** `backend/src/server.ts:60`
- **Status:** CONFIRMED · _conhecido/backlog_
- **Evidência:** initSocket sem createAdapter/Redis (grep nao encontra @socket.io/redis; whatsapp-rate-limit.service.ts linha 120 'ainda in-memory; sem sincronizacao entre replicas. TODO Redis'). server.ts roda setInterval de email/WA/SLA crons dentro do proprio processo; batches vivem em memoria (recoverOrphanRunningBatches no bootstrap). docker-compose backend e instancia unica.
- **Impacto:** O backend so pode rodar como 1 instancia. Subir 2+ replicas duplicaria a execucao de todos os crons (emails/campanhas WhatsApp enviados em dobro) e quebraria o tempo-real (eventos socket nao propagam entre replicas). Enquanto o unico container reinicia, todo o chat/tempo-real fica fora do ar — single point of failure sem HA.
- **Recomendação:** Adotar @socket.io/redis-adapter e mover rate-limit/locks de cron para Redis (ou um scheduler dedicado com lock distribuido) antes de escalar horizontalmente; documentar explicitamente a limitacao de instancia unica.

### 🟡 Sem backup automatico de banco; script de backup nao roda dentro do container backend

- **Categoria:** Capacidade faltante
- **Local:** `backend/Dockerfile:40`
- **Status:** PLAUSIVEL
- **Evidência:** backup-postgres.sh exige pg_dump (linha 30: 'command -v pg_dump ... ERRO pg_dump nao encontrado'), mas o Dockerfile de producao instala apenas 'apk add --no-cache openssl ffmpeg' (sem postgresql-client). Nem docker-compose.yml nem start.sh agendam o script (nenhum cron/crontab). Volume unico pgdata_v2 sem replica.
- **Impacto:** Nao ha backup rodando. O unico script de backup falharia com 'pg_dump nao encontrado' se chamado no container backend, e nada o dispara. Perda do volume pgdata_v2 (disco/host) = perda total dos dados de todos os tenants, sem recuperacao. Single point of failure de dados.
- **Recomendação:** Instalar postgresql-client no container que roda o backup (ou usar sidecar/cron do host apontando para docker compose exec postgres pg_dump), agendar via cron com retencao e off-site, e monitorar sucesso do dump.

---

## ⚪ BAIXO (11)

### ⚪ Inconsistencia front/back: Prospeccao e admin-only no backend mas o front libera a rota para agente com permissao 'extracao'

- **Categoria:** Auth/RBAC
- **Local:** `src/hooks/usePermissions.ts:26`
- **Status:** CONFIRMED
- **Evidência:** routePermissionMap mapeia '/admin/extracao': 'extracao' e '/admin/prospeccao': 'extracao' (L26-27) — ou seja, um agent com a permission granular 'extracao' passa em canAccessRoute e ProtectedRoute o deixa entrar. Mas o backend em prospecting.routes.ts L8-9 aplica `router.use(authenticate, requireAccountId); router.use(requireRole('admin', 'super_admin'));` a TODAS as rotas de /prospecting — nenhum agente passa, independente de permissions. warmup.routes.ts L34-36 faz o mesmo (admin/super_admin only), coerente com adminOnlyRoutes, mas prospeccao ficou fora dessa lista.
- **Impacto:** Um agente a quem o admin concede a permissao 'extracao' ve o menu e navega para /admin/extracao|/admin/prospeccao, porem toda chamada de API (extract, dispatch, batches, usage, audiences) retorna 403 — tela quebrada e experiencia confusa. A permissao 'extracao' e efetivamente inutil para agentes, contradizendo a UI que a oferece.
- **Recomendação:** Decidir a politica e alinhar as duas pontas: se prospeccao deve ser acessivel a agentes, trocar requireRole('admin','super_admin') por requirePermission('extracao') no backend; se e admin-only, mover '/admin/extracao' e '/admin/prospeccao' para adminOnlyRoutes e remove-las do routePermissionMap / da lista de permissions concediveis a agentes.

### ⚪ Envio de audio (PTT) descarta o texto (content) da mesma mensagem

- **Categoria:** Chat/Mensagens
- **Local:** `backend/src/controllers/message.controller.ts:499`
- **Status:** CONFIRMED
- **Evidência:** Quando firstAttachment.fileType==='audio' o unico dispatch e `evolutionService.sendWhatsAppAudio(accountId, { number, audioBase64, instance })` (linha 499) — sem caption e sem envio separado do texto. O ramo sendMedia (linha 510) inclui `caption: parsed.content`, mas o ramo de audio nao. O content e persistido em messageService.create mas nunca vai pro WhatsApp.
- **Impacto:** Agente grava/anexa um audio e escreve um texto junto: o cliente recebe so o audio; o texto some silenciosamente (fica so no CRM). WhatsApp nem suporta caption em PTT, mas o texto deveria ir como mensagem separada.
- **Recomendação:** No ramo de audio, se houver content nao-vazio, disparar tambem um sendText (antes ou depois do audio) ou bloquear a combinacao no schema com mensagem clara.

### ⚪ Dispatch ignorado (sem telefone / canal nao-whatsapp) deixa a mensagem como status='sent' sem ter sido enviada

- **Categoria:** Integridade de dados
- **Local:** `backend/src/controllers/message.controller.ts:597`
- **Status:** CONFIRMED
- **Evidência:** A mensagem e criada com status default 'sent' (message.service.ts:450) ANTES do dispatch. Quando `conversation?.inbox?.channelType === 'whatsapp' && phone` e falso, o codigo apenas loga '[message] dispatch ignorado' (linha 598) e retorna 201 com finalMessage ainda status='sent'.
- **Impacto:** Conversa sem telefone no contato (ou inbox nao-whatsapp) grava mensagens como 'sent' mesmo sem nenhum envio real ao provider. O agente ve indicador de enviado para algo que nunca saiu.
- **Recomendação:** Quando shouldDispatch=true mas o dispatch e pulado por falta de phone/canal, persistir a mensagem com status='failed' (ou 'sending') e um metadata.lastError explicativo, em vez de deixar 'sent'.

### ⚪ dashboard.getAgentPerformance faz N+1 (3 queries por agente)

- **Categoria:** Prisma/Banco
- **Local:** `backend/src/services/dashboard.service.ts:208`
- **Status:** CONFIRMED
- **Evidência:** users.map(async (user) => { const [totalSales, paidSales, totalRevenue] = await Promise.all([ prisma.sale.count({ where:{...saleWhere, responsavelId:user.id} }), prisma.sale.count({... status:'paid'}), prisma.sale.aggregate({... _sum:{valor} }) ]); }) — 3 queries por usuário, mais o findMany inicial.
- **Impacto:** Cada carga do dashboard de performance dispara 3×N queries (N = admins+agents). Bounded pelo número de usuários (geralmente pequeno), mas desnecessário: dá para resolver com um único groupBy responsavelId. Cresce se a conta tiver muitos agentes.
- **Recomendação:** Substituir o loop por prisma.sale.groupBy({ by:['responsavelId','status'], where:saleWhere, _count, _sum:{valor} }) e cruzar em memória com a lista de usuários.

### ⚪ unreadCount incrementado indevidamente na conversa aberta: isOpenHere lê query param que nunca é setado

- **Categoria:** Frontend
- **Local:** `src/components/chat/ConversationList.tsx:285`
- **Status:** CONFIRMED
- **Evidência:** No handler onMessageCreated: `const isOpenHere = ... new URLSearchParams(window.location.search).get('conversationId') === targetId;` (linha 285). Porém AdminChatPage guarda a conversa selecionada em `useState` (AdminChatPage.tsx:28) e NUNCA escreve na URL — grep confirma que essa é a única referência a URLSearchParams/searchParams em todo o chat. Logo `get('conversationId')` é sempre null e isOpenHere é sempre false, então `nextUnread = isInbound ? unread+1 : unread` sempre incrementa (linha 297-300).
- **Impacto:** Quando chega mensagem do cliente na conversa que o agente já tem aberta, o badge de não-lidas na lista incrementa mesmo assim (fantasma). Só é corrigido ~2s depois quando o ConversationThread dispara markAsRead e invalida ['conversations']. Badge pisca com contagem incorreta.
- **Recomendação:** Passar o selectedConversationId por contexto/prop para a ConversationList e comparar com `targetId`, em vez de ler da URL; ou sincronizar selectedConversationId com a query string da rota.

### ⚪ Imagens sem thumbnail são baixadas duas vezes (fetch autenticado duplicado)

- **Categoria:** Frontend
- **Local:** `src/components/chat/AttachmentRenderer.tsx:130`
- **Status:** CONFIRMED
- **Evidência:** Em ImageAttachment: `const main = useAuthenticatedSrc(fileUrl);` (130) e `const thumb = useAuthenticatedSrc(thumbnailUrl || fileUrl);` (131). Cada hook faz um fetch+blob independente. Quando `thumbnailUrl` é null (comum para mídia recebida do WhatsApp), ambos os hooks buscam a MESMA `fileUrl`, gerando dois GET autenticados e dois blobs para a mesma imagem.
- **Impacto:** Dobra a banda e o número de requisições para toda imagem inbound sem thumbnail; em threads com muitas imagens isso pressiona o endpoint /api/attachments e a memória (dois object URLs por imagem).
- **Recomendação:** Quando não houver thumbnailUrl, reaproveitar `main.resolvedSrc` em vez de instanciar um segundo useAuthenticatedSrc com a mesma URL (ex.: só chamar o hook do thumb quando thumbnailUrl existir).

### ⚪ Token global compartilhado (EVOLUTION_WEBHOOK_TOKEN) autentica webhook de QUALQUER conta — quebra isolamento multi-tenant

- **Categoria:** Multi-tenancy
- **Local:** `backend/src/controllers/evolution.controller.ts:335`
- **Status:** CONFIRMED
- **Evidência:** Linha 302 `const globalToken = env.EVOLUTION_WEBHOOK_TOKEN;` e linha 332-337: `if (!hmacValid && providedToken) { if (secret && this.safeTokenEqual(secret, providedToken)) { tokenValid = true; } else if (globalToken && this.safeTokenEqual(globalToken, providedToken)) { tokenValid = true; } }`. O globalToken nao e escopado por accountId — vale para todo `:accountId` da URL.
- **Impacto:** Se EVOLUTION_WEBHOOK_TOKEN estiver configurado, um unico segredo compartilhado autentica webhooks para TODAS as contas. Vazando esse token (ou um operador de uma conta que o conheca), um atacante injeta eventos em qualquer tenant apenas trocando o accountId na URL — cross-tenant message/opt-out injection. O per-account secret existe justamente para evitar isso; o fallback global anula a isolacao.
- **Recomendação:** Remover o fallback de token global, ou torna-lo aceito apenas para contas explicitamente marcadas, e nunca como credencial cross-tenant unica. Preferir sempre o secret por conta (x-crm-webhook-token) que ja e configurado na instance Evolution.

### ⚪ Opt-out inbound processado antes da idempotencia e fora dos guards de inbox — reexecuta em retries da Evolution e roda mesmo em inbox inexistente/inativo

- **Categoria:** Integridade de dados
- **Local:** `backend/src/controllers/evolution.controller.ts:408`
- **Status:** CONFIRMED
- **Evidência:** No controller, o bloco de opt-out (linhas 408-433) chama `whatsappConsentService.handleInboundOptOut(accountId, phone, messageText)` diretamente a partir do body do webhook, ANTES do dispatcher. A idempotencia por externalId (findFirst em processNewMessage, linha 888) e os guards de inbox (`if (!inbox)` linha 820, `if (!inbox.active)` linha 833) so existem dentro de processNewMessage, que roda depois. handleInboundOptOut nao tem checagem de externalId ja processado (whatsapp-consent.service.ts:582 chama optOut sem dedupe por mensagem).
- **Impacto:** Como o dispatcher devolve 200 mesmo em erro (linha 455) mas a Evolution reenvia em caso de 5xx/timeout, a mesma mensagem de opt-out pode ser reprocessada; e o opt-out roda para contas/instances sem inbox configurado ou inativo (o phone e marcado como opted-out sem que exista canal). Combinado com o Finding 1, um atacante nao autenticado pode disparar opt-out em massa. Impacto contido porque optOut e aproximadamente idempotente, mas gera writes/logs repetidos e efeitos em contas nao provisionadas.
- **Recomendação:** Mover o processamento de opt-out para dentro do fluxo de mensagem, apos os guards de inbox existente/ativo e apos a checagem de idempotencia (so processar quando a Message inbound e realmente nova), reaproveitando o skip por externalId.

### ⚪ Rollover de warmup incrementa currentDay de forma nao-idempotente; mutex e apenas in-process

- **Categoria:** Integridade de dados
- **Local:** `backend/src/services/whatsapp-warmup.service.ts:527`
- **Status:** CONFIRMED
- **Evidência:** rolloverIfNeeded protege o snapshot diario com upsert idempotente (linha 499, comentario 'upsert atomico evita duplicacao se 2 ticks rodarem em paralelo') MAS o avanco de dia usa `warmupNumber.update({ data:{ currentDay:{increment:1}, dailyEnviadasHoje:0, dailyRecebidasHoje:0 } })` (linhas 527-535) — increment nao e idempotente. O unico guard de concorrencia e o mutex in-memory `isWarmingChips` em server.ts:104-121, que so vale dentro de UM processo. O servico irmao whatsapp-rate-limit.service.ts (linhas ~42-51) documenta explicitamente a intencao de rodar em 'multiplas replicas', cenario em que 'cada processo tem sua propria contagem'.
- **Impacto:** Em deploy horizontal (Docker/EasyPanel com >1 replica) cada replica roda seu proprio setInterval de tick sem lock compartilhado. Na virada de dia, duas replicas passam pelo guard `lastDate === today` (ambas leem o estado antigo) e ambas executam o increment -> currentDay avanca 2 dias de uma vez (pula um dia do protocolo de aquecimento) e as duas disparam o mesmo lote de mensagens de warmup para o mesmo chip. Como o objetivo do warmup e evitar ban, envios duplicados/aceleracao do protocolo aumentam risco real de banimento do numero.
- **Recomendação:** Tornar o rollover idempotente/atomico: usar updateMany com WHERE que trave o avanco (ex.: WHERE current_day = :expected AND last_activity_at < :dayStart) e checar count, ou mover o avanco para dentro do mesmo upsert transacional guardado por (numberId,date). Para multi-replica, adotar lock distribuido (advisory lock no Postgres por numberId) em vez do mutex in-memory.

### ⚪ Ausencia de graceful shutdown (sem handler SIGTERM/SIGINT) derruba crons e batches em andamento no redeploy

- **Categoria:** Estrutura/Arquitetura
- **Local:** `backend/src/server.ts:42`
- **Status:** CONFIRMED
- **Evidência:** grep por SIGTERM/SIGINT/process.on em server.ts nao retorna nada. Ha varios setInterval (email/WA/SLA) e envio de mensagens WhatsApp em background; no redeploy o container recebe SIGTERM e o processo morre sem drenar.
- **Impacto:** A cada deploy, disparos/campanhas WhatsApp e envios de email em voo sao cortados no meio, podendo deixar registros em estado 'running' e mensagens parcialmente processadas. So os batches WA tem recovery no bootstrap; email e outros fluxos nao.
- **Recomendação:** Adicionar handlers SIGTERM/SIGINT que param os crons, aguardam in-flight, fecham Socket.IO e chamam prisma.$disconnect antes de exit, com timeout.

### ⚪ FRONTEND_URL default aponta para dominio legado (goodleads.mychooice.com) — CORS/links quebram se env nao setada

- **Categoria:** Estrutura/Arquitetura
- **Local:** `docker-compose.yml:56`
- **Status:** CONFIRMED
- **Evidência:** docker-compose.yml linha 56: FRONTEND_URL: ${FRONTEND_URL:-https://goodleads.mychooice.com}. Producao atual e 360.gleps.com.br. FRONTEND_URL alimenta CORS e links (ex.: OAuth redirect, emails).
- **Impacto:** Se o operador esquecer FRONTEND_URL, o backend assume um dominio de outra marca: CORS pode bloquear o frontend real, e links gerados (OAuth/emails) apontam para host errado. Config fragil por default silencioso em vez de fail-loud.
- **Recomendação:** Tornar FRONTEND_URL obrigatoria em producao (sem default de marca) ou derivar de uma unica variavel de dominio; validar no env.ts quando NODE_ENV=production.

---

## 🧩 Lacunas de produto (o que um CRM de WhatsApp precisa e falta/está frágil)

### 🟠 Agente pode assinar mensagens em tempo real de QUALQUER conversa da conta via socket join-conversation (RBAC ignorado)

- **Local:** `backend/src/socket/index.ts:247`
- **Evidência:** No handler join-conversation, a unica checagem e de tenant, nao de RBAC do agente: `const conv = await prisma.conversation.findFirst({ where: { id: conversationId, accountId }, select: { id: true } }); if (!conv) return; socket.join(roomConv(accountId, conversationId));`. Nao ha chamada a assertAgentCanAccess/ensureConversationAccess. Em contraste, conversation.service.list() (linha ~330) filtra agente para apenas assignee/team/participant.
- **Impacto:** Um agente com escopo restrito (ve so conversas atribuidas via HTTP) pode emitir join-conversation com o id de qualquer conversa do tenant e passar a receber message:created, message:updated, typing e reactions — ou seja, o corpo completo das mensagens em tempo real — de conversas de OUTROS agentes/times as quais nao teria acesso pela API. Vazamento de conteudo de atendimento entre agentes do mesmo tenant.
- **Recomendação:** No join-conversation, apos validar o tenant, aplicar a mesma RBAC do list: se socket.data.role === 'agent', validar assignee/participant/teamMember (reutilizar assertAgentCanAccess) antes do socket.join. Negar silenciosamente caso contrario.

### 🟠 Recuperacao de senha inexistente: frontend e rate-limiter referenciam /api/auth/forgot-password e /reset-password que nao existem no backend

- **Local:** `backend/src/routes/auth.routes.ts:8`
- **Evidência:** auth.routes.ts so expoe login, refresh, logout, me, verify-password — nao ha forgot/reset. Mesmo assim src/api/endpoints.ts:19-20 define FORGOT_PASSWORD:'/api/auth/forgot-password' e RESET_PASSWORD:'/api/auth/reset-password'; src/config/routes.config.ts:13-14 define as rotas /forgot-password e /reset-password; backend/src/server.ts:369 monta `app.use('/api/auth/forgot-password', authLimiter)`. Nao existe pagina ForgotPassword em /src (find nao encontra) nem service resetPassword no backend.
- **Impacto:** Um usuario (admin ou agente) que esquece a senha nao tem como recupera-la — depende de um super_admin/admin redefinir manualmente. Para um CRM multi-tenant com clientes reais, ausencia de self-service de recuperacao de senha e uma lacuna essencial de onboarding/suporte. Ha ainda codigo morto (endpoints/rota/limiter) que sugere a feature existir.
- **Recomendação:** Implementar fluxo forgot/reset password com token de uso unico e expiravel enviado por e-mail (SendGrid ja integrado), ou remover os endpoints/rotas/limiter mortos para nao confundir. Preferencialmente implementar.

### 🟡 Broadcast conversation:updated envia PII do contato para todos os agentes da conta (bypassa RBAC do list)

- **Local:** `backend/src/socket/index.ts:444`
- **Evidência:** emitConversationUpdated faz `chatNs.to(roomAccount(accountId)).emit('conversation:updated', payload)` e todos os sockets entram em roomAccount no connect (linha 219). O payload vem de stripHeavyRelationsForBroadcast (conversation.service.ts:33) que so remove `messages` — mantem contact {nome, telefone, email, profilePicUrl}, assignee, labels e customAttributes. Agentes sem acesso aquela conversa (filtrados no list()) mesmo assim recebem esses dados.
- **Impacto:** Qualquer atualizacao de status/prioridade/label de uma conversa entrega nome, telefone e e-mail do contato para TODOS os agentes do tenant em tempo real, inclusive os que nao podem ver aquela conversa via HTTP. Vazamento de PII entre agentes.
- **Recomendação:** Rotear conversation:updated apenas para roomConv (quem realmente abriu a conversa, ja com RBAC no join) e/ou emitir para o assignee/participantes/time. Para a lista, enviar um evento minimo (so id + status) sem PII, ou por sala restrita.

### 🟡 Webhook Evolution aceita eventos sem autenticacao quando a conta nao tem evolutionWebhookSecret (modo permissivo total)

- **Local:** `backend/src/controllers/evolution.controller.ts:241`
- **Evidência:** `if (!account.evolutionWebhookSecret || account.evolutionWebhookSecret.trim() === '') { logger.warn('... modo permissivo') }` e no bloco final (linha 389) 'Modo permissivo total: account sem secret ... Nao validamos NADA — apenas processamos'. A rota POST /api/evolution/webhook/:accountId e publica (evolution.routes.ts) e nao ha enforcement de que o secret seja provisionado.
- **Impacto:** Se um tenant nunca teve o secret populado (onboarding incompleto), qualquer um que conheca/adivinhe o accountId (UUID) pode POSTar eventos forjados: injetar mensagens WhatsApp de entrada falsas, respostas de CSAT, eventos de conexao/desconexao de inbox. Poluicao de dados e possivel engenharia social dentro do chat do cliente.
- **Recomendação:** Tornar evolutionWebhookSecret obrigatorio no provisioning do inbox e rejeitar (401) webhooks de contas sem secret em producao, em vez de aceitar. Manter permissivo apenas sob flag explicita de dev.

### 🟡 Sem escalabilidade horizontal: Socket.IO sem adapter Redis e rate-limits em memoria por instancia

- **Local:** `backend/src/services/whatsapp-rate-limit.service.ts:54`
- **Evidência:** whatsapp-rate-limit usa `private readonly perPhone = new Map<...>()` e `perAccount = new Map<...>()` (linhas 54-57) com TODO(redis) na linha 46. backend/src/socket/index.ts nao chama createAdapter/redis (grep sem resultado). backend/src/server.ts monta express-rate-limit sem `store:` (default MemoryStore).
- **Impacto:** Rodando mais de uma instancia/replica do backend: (1) salas do Socket.IO nao propagam entre instancias — agentes conectados em instancias diferentes deixam de receber message:created/typing/mention, quebrando o chat em tempo real; (2) rate-limits de auth e de disparo WhatsApp sao contados por instancia, permitindo N x o limite e arriscando ban do numero. Impede escalar o produto sob carga real.
- **Recomendação:** Adicionar @socket.io/redis-adapter e migrar rate-limits para store compartilhado (Redis) antes de escalar horizontalmente; ou documentar/forcar deploy single-instance.

### 🟡 Agente sem permissao kanban/leads nao ve etiquetas nem atributos customizados no chat

- **Local:** `backend/src/routes/tag.routes.ts:11`
- **Evidência:** tag.routes.ts:11 `router.get('/', requirePermission('kanban','leads'), ...)` — listar tags/labels exige permissao de kanban ou leads. custom-attribute.routes.ts:22 `router.use(requireAdmin)` — todos os endpoints de atributos customizados sao admin-only. Um agente cujas permissoes sao apenas chat/dashboard recebe 403 nesses endpoints.
- **Impacto:** Agentes que so fazem atendimento nao conseguem visualizar as etiquetas aplicadas nem os atributos customizados das conversas que atendem — informacao essencial de contexto do cliente no CRM de WhatsApp. Degrada o nucleo do produto (atendimento) para o papel mais comum.
- **Recomendação:** Criar permissao de leitura de labels/atributos vinculada ao acesso ao chat (ex.: liberar GET /tags e GET /custom-attributes para quem tem permissao de atendimento/chat), mantendo escrita restrita a admin.

### ⚪ GET /api/users/online cai no handler GET /:id (id='online') — capacidade de presenca por essa rota inexistente

- **Local:** `backend/src/routes/user.routes.ts:12`
- **Evidência:** user.routes.ts declara `router.get('/', requireAdmin, list)` (10) e `router.get('/:id', getById)` (12), sem nenhuma rota /online. Uma chamada GET /api/users/online e capturada por /:id com id='online', executando userService.getById('online') e retornando NOT_FOUND.
- **Impacto:** Qualquer cliente que espere um endpoint de usuarios online recebe erro; a presenca online real vive em agent-availability. Endpoint fantasma confunde integracoes.
- **Recomendação:** Adicionar rota explicita /users/online (ou remover a expectativa no frontend) apontando para agentAvailabilityService, registrada ANTES de /:id.

### ⚪ Sem code-splitting: App.tsx importa 31 rotas de forma sincrona (bundle inicial pesado)

- **Local:** `src/App.tsx:1`
- **Evidência:** App.tsx tem 45 imports estaticos e 31 <Route>; grep por lazy(/Suspense/React.lazy retorna vazio. Todas as paginas (Kanban, Prospeccao, Warmup, Financeiro, Chat, etc.) entram no chunk inicial.
- **Impacto:** Primeiro carregamento lento, especialmente para agentes em celular/rede fraca — o agente so precisa do chat mas baixa todo o CRM. Piora tempo ate interativo em producao.
- **Recomendação:** Aplicar React.lazy + Suspense por rota (pelo menos para modulos pesados: prospeccao, warmup, financeiro, e-mails) para reduzir o bundle inicial.

---

## Metodologia

Auditoria automatizada multi-agente: 8 dimensões de revisão (multi-tenancy, auth/RBAC, chat/mensagens, segurança, Prisma/banco, frontend, webhook Evolution, integridade de dados, estrutura/arquitetura) + análise dedicada de lacunas de produto. Cada achado passou por um verificador adversarial independente que leu o código real e emitiu veredito (CONFIRMED / PLAUSÍVEL / REFUTADO — refutados foram descartados). 50 agentes, ~1.7M tokens.

> Para uma revisão em nuvem ainda mais profunda, você pode disparar `/code-review ultra` (multi-agente, billed) — é acionada por você, eu não consigo lançá-la.
