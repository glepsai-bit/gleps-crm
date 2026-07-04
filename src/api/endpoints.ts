/**
 * API Endpoints Configuration
 * 
 * Centralized definition of all API endpoints organized by microservice/domain.
 * This file serves as the single source of truth for API routes.
 * 
 * When backend is ready:
 * 1. Update apiConfig.baseUrl with the real API URL
 * 2. Endpoints will automatically use the correct paths
 */

export const API_ENDPOINTS = {
  // ============= AUTH SERVICE =============
  AUTH: {
    LOGIN: '/api/auth/login',
    LOGOUT: '/api/auth/logout',
    REFRESH: '/api/auth/refresh',
    ME: '/api/auth/me',
    FORGOT_PASSWORD: '/api/auth/forgot-password',
    RESET_PASSWORD: '/api/auth/reset-password',
    IMPERSONATE: (userId: string) => `/api/users/${userId}/impersonate`,
    EXIT_IMPERSONATION: '/api/auth/exit-impersonation',
  },

  // ============= ACCOUNTS SERVICE (Super Admin) =============
  ACCOUNTS: {
    LIST: '/api/accounts',
    GET: (id: string) => `/api/accounts/${id}`,
    CREATE: '/api/accounts',
    UPDATE: (id: string) => `/api/accounts/${id}`,
    DELETE: (id: string) => `/api/accounts/${id}`,
    PAUSE: (id: string) => `/api/accounts/${id}/pause`,
    ACTIVATE: (id: string) => `/api/accounts/${id}/activate`,
    STATS: (id: string) => `/api/accounts/${id}/stats`,
  },

  // ============= USERS SERVICE =============
  USERS: {
    LIST: '/api/users',
    GET: (id: string) => `/api/users/${id}`,
    CREATE: '/api/users',
    UPDATE: (id: string) => `/api/users/${id}`,
    DELETE: (id: string) => `/api/users/${id}`,
    BY_ACCOUNT: (accountId: string) => `/api/accounts/${accountId}/users`,
    UPDATE_STATUS: (id: string) => `/api/users/${id}/status`,
    UPDATE_PERMISSIONS: (id: string) => `/api/users/${id}/permissions`,
  },

  // ============= ADMIN USERS (T-024 — admin de conta gerencia equipe) =============
  // Rota dedicada ao admin de conta gerenciar agentes/admins da PROPRIA tenancy.
  // SEMPRE escopada por accountId do JWT no backend. Nunca expõe role='super_admin'.
  // Auth: authenticate + requireAdmin + requireAccountId. DELETE exige header
  // X-Confirm-Password (verifyPassword middleware) com a senha do requester.
  ADMIN_USERS: {
    LIST: '/api/admin/users',
    GET: (id: string) => `/api/admin/users/${id}`,
    CREATE: '/api/admin/users',
    UPDATE: (id: string) => `/api/admin/users/${id}`,
    DELETE: (id: string) => `/api/admin/users/${id}`,
    LIMITS: '/api/admin/users/limits',
  },

  // ============= CONTACTS SERVICE =============
  CONTACTS: {
    LIST: '/api/contacts',
    GET: (id: string) => `/api/contacts/${id}`,
    CREATE: '/api/contacts',
    UPDATE: (id: string) => `/api/contacts/${id}`,
    DELETE: (id: string) => `/api/contacts/${id}`,
    SEARCH: '/api/contacts/search',
    // L-LEAD-1: BY_STAGE e MOVE_STAGE foram removidos por serem código morto —
    // o backend nunca implementou /api/contacts/stage/:id nem /api/contacts/:id/move
    // (rotas 404). A "movimentação de estágio" no kanban é, na prática, feita via
    // aplicação/remoção de tags (`/api/contacts/:id/tags`). Não reintroduza esses
    // endpoints sem antes ter rota correspondente no backend.
    NOTES: (id: string) => `/api/contacts/${id}/notes`,
    ADD_NOTE: (id: string) => `/api/contacts/${id}/notes`,
  },

  // ============= SALES SERVICE =============
  SALES: {
    LIST: '/api/sales',
    GET: (id: string) => `/api/sales/${id}`,
    CREATE: '/api/sales',
    UPDATE: (id: string) => `/api/sales/${id}`,
    DELETE: (id: string) => `/api/sales/${id}`,
    MARK_PAID: (id: string) => `/api/sales/${id}/pay`,
    REFUND: (id: string) => `/api/sales/${id}/refund`,
    REFUND_ITEM: (saleId: string, itemId: string) => `/api/sales/${saleId}/items/${itemId}/refund`,
    BY_CONTACT: (contactId: string) => `/api/contacts/${contactId}/sales`,
    TRANSACTIONS: (id: string) => `/api/sales/${id}/transactions`,
    STATS: '/api/sales/kpis',
  },

  // ============= PRODUCTS SERVICE =============
  PRODUCTS: {
    LIST: '/api/products',
    GET: (id: string) => `/api/products/${id}`,
    CREATE: '/api/products',
    UPDATE: (id: string) => `/api/products/${id}`,
    DELETE: (id: string) => `/api/products/${id}`,
    TOGGLE_STATUS: (id: string) => `/api/products/${id}/toggle`,
  },

  // ============= TAGS SERVICE =============
  TAGS: {
    LIST: '/api/tags',
    GET: (id: string) => `/api/tags/${id}`,
    CREATE: '/api/tags',
    UPDATE: (id: string) => `/api/tags/${id}`,
    DELETE: (id: string) => `/api/tags/${id}`,
    REORDER: '/api/tags/reorder',
    BY_CONTACT: (contactId: string) => `/api/contacts/${contactId}/tags`,
    ADD_TO_CONTACT: (contactId: string) => `/api/contacts/${contactId}/tags`,
    REMOVE_FROM_CONTACT: (contactId: string, tagId: string) => `/api/contacts/${contactId}/tags/${tagId}`,
    HISTORY: (contactId: string) => `/api/contacts/${contactId}/tags/history`,
  },

  // ============= FUNNEL SERVICE =============
  FUNNELS: {
    LIST: '/api/funnels',
    GET: (id: string) => `/api/funnels/${id}`,
    CREATE: '/api/funnels',
    UPDATE: (id: string) => `/api/funnels/${id}`,
    DELETE: (id: string) => `/api/funnels/${id}`,
    STAGES: (funnelId: string) => `/api/funnels/${funnelId}/stages`,
  },

  // ============= CALENDAR SERVICE =============
  CALENDAR: {
    EVENTS: '/api/calendar/events',
    EVENT: (id: string) => `/api/calendar/events/${id}`,
    CREATE_EVENT: '/api/calendar/events',
    UPDATE_EVENT: (id: string) => `/api/calendar/events/${id}`,
    DELETE_EVENT: (id: string) => `/api/calendar/events/${id}`,
    SYNC: '/api/calendar/sync',
    INTEGRATIONS: '/api/calendar/integrations',
    CONNECT_GOOGLE: '/api/calendar/connect/google',
    DISCONNECT_GOOGLE: '/api/calendar/disconnect/google',
  },

  // ============= EVENTS/AUDIT SERVICE =============
  EVENTS: {
    LIST: '/api/events',
    GET: (id: string) => `/api/events/${id}`,
    BY_ENTITY: (entityType: string, entityId: string) => `/api/events/${entityType}/${entityId}`,
    STATS: '/api/events/stats',
  },

  // ============= DASHBOARD/ANALYTICS =============
  DASHBOARD: {
    SUPER_ADMIN_KPIS: '/api/admin/kpis',
    ADMIN_KPIS: '/api/dashboard/kpis',
    AGENT_KPIS: '/api/dashboard/agent/kpis',
    HOURLY_PEAK: '/api/dashboard/hourly-peak',
    AGENT_PERFORMANCE: '/api/dashboard/agents-performance',
    SERVER_RESOURCES: '/api/admin/server-resources',
    CONSUMPTION_HISTORY: '/api/admin/consumption-history',
    WEEKLY_CONSUMPTION: '/api/admin/weekly-consumption',
  },

  // ============= PROSPECTING SERVICE =============
  PROSPECTING: {
    EXTRACT: '/api/prospecting/extract',
    USAGE: '/api/prospecting/usage',
    INBOXES: '/api/prospecting/inboxes',
    DISPATCH: '/api/prospecting/dispatch',
    CANCEL: '/api/prospecting/cancel',
    RESUME: '/api/prospecting/resume',
    BATCHES: '/api/prospecting/batches',
    BATCH_LOGS: (batchId: string) => `/api/prospecting/batches/${batchId}/logs`,
    AUDIENCES: '/api/prospecting/audiences',
    AUDIENCE: (id: string) => `/api/prospecting/audiences/${id}`,
    BATCHES_SCHEDULED: '/api/prospecting/batches/scheduled',
    // T-022 — agregação / dropdown de campaign_types (vide prospecting.controller.ts)
    BATCHES_AGGREGATE: '/api/prospecting/batches/aggregate',
    BATCH_CAMPAIGN_TYPES: '/api/prospecting/batches/campaign-types',
    DISPATCH_START: '/api/dispatch/send-batch',
    BATCH_CANCEL: (id: string) => `/api/prospecting/batches/${id}`,
    BATCH_PAUSE: (id: string) => `/api/prospecting/batches/${id}/pause`,
    BATCH_RESUME: (id: string) => `/api/prospecting/batches/${id}/resume`,
  },

  // ============= WHATSAPP TEMPLATES =============
  WHATSAPP_TEMPLATES: {
    LIST: '/api/whatsapp-templates',
    GET_BY_ID: (id: string) => `/api/whatsapp-templates/${id}`,
    CREATE: '/api/whatsapp-templates',
    UPDATE: (id: string) => `/api/whatsapp-templates/${id}`,
    DELETE: (id: string) => `/api/whatsapp-templates/${id}`,
  },

  // ============= WHATSAPP CAMPAIGNS (canônico) =============
  // BUG-082: paths canônicos para campanhas de WhatsApp — alguns serviços
  // ainda referenciam variantes em PROSPECTING; novos consumidores devem
  // usar esses constantes.
  WHATSAPP_CAMPAIGNS: {
    LIST: '/api/whatsapp/campaigns',
    GET: (id: string) => `/api/whatsapp/campaigns/${id}`,
    CREATE: '/api/whatsapp/campaigns',
    UPDATE: (id: string) => `/api/whatsapp/campaigns/${id}`,
    DELETE: (id: string) => `/api/whatsapp/campaigns/${id}`,
    DISPATCH: (id: string) => `/api/whatsapp/campaigns/${id}/dispatch`,
    CANCEL: (id: string) => `/api/whatsapp/campaigns/${id}/cancel`,
    METRICS: (id: string) => `/api/whatsapp/campaigns/${id}/metrics`,
    LOGS: (id: string) => `/api/whatsapp/campaigns/${id}/logs`,
  },

  // ============= EVOLUTION API (WhatsApp instance) =============
  // BUG-082: grupo dedicado para controle da instância Evolution
  // (status da conexão, QR Code de pareamento, desconexão, webhook).
  EVOLUTION: {
    STATUS: '/api/evolution/status',
    QRCODE: '/api/evolution/qrcode',
    DISCONNECT: '/api/evolution/disconnect',
    WEBHOOK: '/api/evolution/webhook',
  },

  // ============= API KEYS =============
  // BUG-082: gestão de chaves de API da conta (criar/listar/revogar).
  API_KEYS: {
    LIST: '/api/api-keys',
    CREATE: '/api/api-keys',
    REVOKE: (id: string) => `/api/api-keys/${id}`,
  },

  // ============= INSIGHTS/REPORTS =============
  INSIGHTS: {
    PRODUCT_ANALYSIS: '/api/insights/products',
    TEMPORAL_ANALYSIS: '/api/insights/temporal',
    PAYMENT_METHODS: '/api/insights/payment-methods',
    MARKETING: '/api/insights/marketing',
    AUTOMATIC: '/api/insights/automatic',
  },

  // ============= EMAIL MODULE =============
  EMAIL: {
    CADENCES: '/api/email/cadences',
    CADENCE: (id: string) => `/api/email/cadences/${id}`,
    CADENCE_STEPS: (cadenceId: string) => `/api/email/cadences/${cadenceId}/steps`,
    CADENCE_RULES: (cadenceId: string) => `/api/email/cadences/${cadenceId}/rules`,
    STEP: (id: string) => `/api/email/steps/${id}`,
    RULE: (id: string) => `/api/email/rules/${id}`,
    TEMPLATES: '/api/email/templates',
    TEMPLATE: (id: string) => `/api/email/templates/${id}`,
    ENROLL: '/api/email/enroll',
    UNENROLL: '/api/email/unenroll',
    ENROLLMENTS: '/api/email/enrollments',
    SENDS: '/api/email/sends',
    SEND_STATS: '/api/email/sends/stats',
    QUOTA: '/api/email/quota',
    AI_GENERATE: '/api/email/ai/generate',
    SETTINGS: '/api/email/settings',
    PROCESS_QUEUE: '/api/email/process',
    TEST_SENDGRID: '/api/email/test-connection',
    TEST_SEND: '/api/email/test-send',
    TEST_OPENAI: '/api/email/test-openai',
    SEARCH: '/api/email/search',
    // Campaigns
    CAMPAIGNS: '/api/email/campaigns',
    CAMPAIGN: (id: string) => `/api/email/campaigns/${id}`,
    CAMPAIGN_CADENCES: (id: string) => `/api/email/campaigns/${id}/cadences`,
    CAMPAIGN_STATS: (id: string) => `/api/email/campaigns/${id}/stats`,
    CAMPAIGN_DISPATCH_NOW: (id: string) => `/api/email/campaigns/${id}/dispatch-now`,
    // Audiences
    AUDIENCES: '/api/email/audiences',
    AUDIENCE: (id: string) => `/api/email/audiences/${id}`,
    AUDIENCE_CONTACTS: (id: string) => `/api/email/audiences/${id}/contacts`,
    AUDIENCE_REMOVE_CONTACT: (id: string, contactId: string) => `/api/email/audiences/${id}/contacts/${contactId}`,
    AUDIENCE_IMPORT: (id: string) => `/api/email/audiences/${id}/import`,
    // Inbox
    INBOX: '/api/email/inbox',
    INBOX_UNREAD: '/api/email/inbox/unread',
    INBOX_DIAGNOSTICS: '/api/email/inbox/diagnostics',
    INBOX_MESSAGE: (id: string) => `/api/email/inbox/${id}`,
    INBOX_MARK_READ: (id: string) => `/api/email/inbox/${id}/read`,
    INBOX_MARK_REPLIED: (id: string) => `/api/email/inbox/${id}/replied`,
    INBOX_PAUSE_ENROLLMENT: (id: string) => `/api/email/inbox/${id}/pause-enrollment`,
    INBOX_RESUME_ENROLLMENT: (id: string) => `/api/email/inbox/${id}/resume-enrollment`,
    INBOX_UNENROLL: (id: string) => `/api/email/inbox/${id}/unenroll`,
    INBOX_REPLY: '/api/email/inbox/reply',
    INBOX_SUGGEST_REPLY: '/api/email/inbox/suggest-reply',
  },

  // ============= WEBHOOKS (Sprint 3) =============
  WEBHOOKS: {
    LIST: '/api/webhooks',
    CREATE: '/api/webhooks',
    UPDATE: (id: string) => `/api/webhooks/${id}`,
    DELETE: (id: string) => `/api/webhooks/${id}`,
    DELIVERIES: (id: string) => `/api/webhooks/${id}/deliveries`,
    TEST: (id: string) => `/api/webhooks/${id}/test`,
  },

  // ============= INBOUND INTEGRATIONS (Sprint 3) =============
  INBOUND_INTEGRATIONS: {
    LIST: '/api/integrations/inbound',
    CREATE: '/api/integrations/inbound',
    DELETE: (slug: string) => `/api/integrations/inbound/${slug}`,
  },

  // ============= WHATSAPP CONSENTS / OPT-OUT (Sprint 3) =============
  WHATSAPP_CONSENTS: {
    LIST: '/api/whatsapp-consents',
    OPT_IN: (contactId: string) => `/api/whatsapp-consents/${contactId}/opt-in`,
    OPT_OUT: (contactId: string) => `/api/whatsapp-consents/${contactId}/opt-out`,
    EXPORT: '/api/whatsapp-consents/export',
    CHECK_BATCH: '/api/whatsapp-consents/check-batch',
  },

  // ============= SYSTEM SETTINGS (T-022 — config global do super admin) =============
  // Singleton de configurações globais (Evolution URL/API key/Webhook).
  // Acesso restrito a super_admin. API key vem mascarada como '***SET***'
  // quando preenchida no GET; o frontend deve evitar reenviar essa string
  // literal no PATCH para não sobrescrever o valor real.
  SYSTEM_SETTINGS: {
    GET: '/api/system-settings',
    UPDATE: '/api/system-settings',
    TEST_EVOLUTION: '/api/system-settings/test-evolution',
  },

  // ============= INBOXES (T-022 — canais de atendimento) =============
  // CRUD do modelo Prisma `Inbox` (whatsapp/email/facebook/instagram).
  // WHATSAPP_* controla a conexão Evolution por Inbox (QR/status/logout).
  INBOXES: {
    LIST: '/api/inboxes',
    GET: (id: string) => `/api/inboxes/${id}`,
    CREATE: '/api/inboxes',
    UPDATE: (id: string) => `/api/inboxes/${id}`,
    DELETE: (id: string) => `/api/inboxes/${id}`,
    // H-CONFIG-1: contagens de cascade exibidas antes do DELETE.
    DEPENDENCIES: (id: string) => `/api/inboxes/${id}/dependencies`,
    WHATSAPP_CONNECT: (id: string) => `/api/inboxes/${id}/whatsapp/connect`,
    WHATSAPP_STATUS: (id: string) => `/api/inboxes/${id}/whatsapp/status`,
    WHATSAPP_DISCONNECT: (id: string) =>
      `/api/inboxes/${id}/whatsapp/disconnect`,
  },

  // ============= TEAMS (T-022 — times de atendimento) =============
  // CRUD de Team + membership (TeamMember).
  TEAMS: {
    LIST: '/api/teams',
    GET: (id: string) => `/api/teams/${id}`,
    CREATE: '/api/teams',
    UPDATE: (id: string) => `/api/teams/${id}`,
    DELETE: (id: string) => `/api/teams/${id}`,
    MEMBERS: (id: string) => `/api/teams/${id}/members`,
    REMOVE_MEMBER: (id: string, userId: string) => `/api/teams/${id}/members/${userId}`,
    BY_USER_ME: '/api/teams/by-user/me',
  },

  // ============= AGENT AVAILABILITY (T-022 — presença no chat interno) =============
  // Status (online/away/busy/offline) por agente + heartbeat + lista de online.
  AVAILABILITY: {
    ME: '/api/availability/me',
    HEARTBEAT: '/api/availability/heartbeat',
    ONLINE: '/api/availability/online',
  },

  // ============= CANNED RESPONSES (T-022 — respostas prontas) =============
  // Escopadas por accountId. shortCode é normalizado server-side
  // (lowercase, sem barra inicial). Filtro `search` faz busca case-insensitive
  // em shortCode/content/description.
  CANNED_RESPONSES: {
    LIST: '/api/canned-responses',
    GET: (id: string) => `/api/canned-responses/${id}`,
    CREATE: '/api/canned-responses',
    UPDATE: (id: string) => `/api/canned-responses/${id}`,
    DELETE: (id: string) => `/api/canned-responses/${id}`,
  },

  // ============= SLA POLICIES (T-022 — políticas de SLA) =============
  // CRUD + aplicação em conversation + listagem dos N=50 breaches mais
  // recentes da policy.
  SLA_POLICIES: {
    LIST: '/api/sla-policies',
    GET: (id: string) => `/api/sla-policies/${id}`,
    CREATE: '/api/sla-policies',
    UPDATE: (id: string) => `/api/sla-policies/${id}`,
    DELETE: (id: string) => `/api/sla-policies/${id}`,
    BREACHES: (id: string) => `/api/sla-policies/${id}/breaches`,
    APPLY_TO_CONVERSATION: (conversationId: string) =>
      `/api/conversations/${conversationId}/sla`,
    // SLA v2 — dashboard agregado de outcomes, CSAT, ranking de agentes
    // e IA vs Humano (montado em /api/sla, nao /api/sla-policies).
    DASHBOARD: '/api/sla/dashboard',
  },

  // ============= CUSTOM ATTRIBUTES (T-022 — campos customizados) =============
  // Definições de campos customizados por conta.
  // scopes suportados: conversation | contact | account
  // types suportados: text | number | date | list | boolean
  CUSTOM_ATTRIBUTES: {
    LIST: '/api/custom-attributes',
    GET: (id: string) => `/api/custom-attributes/${id}`,
    CREATE: '/api/custom-attributes',
    UPDATE: (id: string) => `/api/custom-attributes/${id}`,
    DELETE: (id: string) => `/api/custom-attributes/${id}`,
  },

  // ============= WARMUP (T-022 FitPark — aquecimento de chips WhatsApp) =============
  // Pools de chips em aquecimento + números individuais com curva de envio
  // diária (D1..D21+). Acesso restrito a admin/super_admin (server valida).
  // Stats devolve últimos 30 dias de WarmupDailyStats (planned vs actual).
  WARMUP: {
    POOLS: '/api/warmup/pools',
    POOL: (id: string) => `/api/warmup/pools/${id}`,
    NUMBERS: '/api/warmup/numbers',
    NUMBER: (id: string) => `/api/warmup/numbers/${id}`,
    NUMBER_START: (id: string) => `/api/warmup/numbers/${id}/start`,
    NUMBER_PAUSE: (id: string) => `/api/warmup/numbers/${id}/pause`,
    NUMBER_RESUME: (id: string) => `/api/warmup/numbers/${id}/resume`,
    NUMBER_STATS: (id: string) => `/api/warmup/numbers/${id}/stats`,
    AI_PROVIDERS: '/api/warmup/ai/providers',
    // T-023 V2 (Phase 4) — biblioteca de midias (audio/sticker/image) usadas
    // como conteudo nao-texto nas conversas de aquecimento.
    MEDIA: '/api/warmup/media',
    MEDIA_UPLOAD: '/api/warmup/media/upload',
    MEDIA_DELETE: (id: string) => `/api/warmup/media/${id}`,
  },

  // ============= CHAT METRICS (T-022 — métricas do chat interno) =============
  // Métricas agregadas (conversations / messages / SLA breaches) calculadas
  // a partir dos models do chat interno. Escopo automático por accountId
  // do usuário autenticado (super_admin precisa estar impersonando).
  CHAT_METRICS: {
    METRICS: '/api/chat/metrics',
    AGENT_METRICS: (userId: string) => `/api/chat/metrics/agent/${userId}`,
    // Estas três rotas vivem em `/api/chat/<resource>` (não `/api/chat/metrics/<resource>`)
    // — o router backend monta o grupo em `/chat` e cada handler usa caminhos
    // próprios. Vide backend/src/routes/chat-metrics.routes.ts.
    RETURNING_LEADS: '/api/chat/returning-leads',
    RETURNING_LEADS_LIST: '/api/chat/returning-leads/list',
    LIVE_ATTENDANCE: '/api/chat/live-attendance',
  },

  // ============= CONVERSATIONS (T-022 — Chat interno) =============
  // Ciclo de vida da conversa: status, prioridade, atribuição, transferência,
  // snooze/resolve/reopen, labels, participants e custom attributes. Todas as
  // rotas exigem JWT + accountId. Filtros de listagem aceitam string 'null'
  // para assigneeId/teamId (= "não atribuído").
  CONVERSATIONS: {
    LIST: '/api/conversations',
    GET: (id: string) => `/api/conversations/${id}`,
    CREATE: '/api/conversations',
    UPDATE_STATUS: (id: string) => `/api/conversations/${id}/status`,
    UPDATE_PRIORITY: (id: string) => `/api/conversations/${id}/priority`,
    ASSIGN: (id: string) => `/api/conversations/${id}/assign`,
    ASSIGN_TEAM: (id: string) => `/api/conversations/${id}/assign-team`,
    TRANSFER: (id: string) => `/api/conversations/${id}/transfer`,
    SNOOZE: (id: string) => `/api/conversations/${id}/snooze`,
    RESOLVE: (id: string) => `/api/conversations/${id}/resolve`,
    REOPEN: (id: string) => `/api/conversations/${id}/reopen`,
    ADD_LABEL: (id: string) => `/api/conversations/${id}/labels`,
    REMOVE_LABEL: (id: string, tagId: string) =>
      `/api/conversations/${id}/labels/${tagId}`,
    ADD_PARTICIPANT: (id: string) => `/api/conversations/${id}/participants`,
    REMOVE_PARTICIPANT: (id: string, userId: string) =>
      `/api/conversations/${id}/participants/${userId}`,
    CUSTOM_ATTRIBUTES: (id: string) =>
      `/api/conversations/${id}/custom-attributes`,
    MARK_READ: (id: string) => `/api/conversations/${id}/read`,
    // SLA v2.1 — disparo IMEDIATO de pesquisa CSAT (sem aguardar o cron 15min).
    // Body opcional: { customMessage?: string; force?: boolean }
    // 409 se ja enviado e force !== true.
    SEND_CSAT: (id: string) => `/api/conversations/${id}/send-csat`,
  },

  // ============= MESSAGES (T-022 — Chat interno) =============
  // Listagem/envio de mensagens por conversa, marcação de leitura por
  // mensagem e busca textual (ILIKE em content escopado por accountId).
  // LIST/SEND compartilham a mesma URL — diferem pelo método HTTP.
  //
  // CHAT-REPLY-EDIT-DEL + CHAT-REACTIONS (T-022 pós-Sprint 4):
  //   PATCH  /api/messages/:id                    → edit outbound (janela 15min)
  //   DELETE /api/messages/:id                    → soft delete outbound (janela 15min)
  //   GET    /api/messages/:id/reactions          → lista reactions da msg
  //   POST   /api/messages/:id/reactions          → adiciona reaction {emoji}
  //   DELETE /api/messages/:id/reactions/:emoji   → remove reaction do próprio user
  MESSAGES: {
    LIST: (conversationId: string) =>
      `/api/conversations/${conversationId}/messages`,
    SEND: (conversationId: string) =>
      `/api/conversations/${conversationId}/messages`,
    MARK_READ: (id: string) => `/api/messages/${id}/read`,
    UPDATE: (id: string) => `/api/messages/${id}`,
    DELETE: (id: string) => `/api/messages/${id}`,
    SEARCH: '/api/messages/search',
    REACTIONS: (id: string) => `/api/messages/${id}/reactions`,
    REACTION_REMOVE: (id: string, emoji: string) =>
      `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`,
  },

  // ============= MENTIONS (T-022 Sprint 4 — histórico do sino) =============
  // Hidrata o sino do AdminLayout no mount (complementa o socket
  // `mention:new` que só cobre eventos em tempo real depois da conexão).
  //
  //   GET   /api/mentions?limit=&read=false|true|all
  //   PATCH /api/mentions/:id/read
  MENTIONS: {
    LIST: '/api/mentions',
    MARK_READ: (id: string) => `/api/mentions/${id}/read`,
  },

  // ============= WEB PUSH (VAPID subscriptions do browser) =============
  // Feature opcional: quando VAPID_PUBLIC_KEY nao esta configurada no backend,
  // GET /vapid-public devolve { enabled:false } e o hook do frontend fica
  // silencioso (nao pede permissao Notification).
  //
  //   GET    /api/push/vapid-public
  //   POST   /api/push/subscribe   { endpoint, keys: { p256dh, auth } }
  //   DELETE /api/push/unsubscribe { endpoint }
  PUSH: {
    VAPID_PUBLIC: '/api/push/vapid-public',
    SUBSCRIBE: '/api/push/subscribe',
    UNSUBSCRIBE: '/api/push/unsubscribe',
  },

  // ============= ATTACHMENTS (Bug A + PISTA D) =============
  // Proxy autenticado pra midia baixada da Evolution (GET /:id) + upload
  // multipart dedicado (POST /upload) usado pelo composer para arquivos
  // acima do threshold base64 (5MB). Auth JWT + accountId (RBAC via
  // conversation.accountId ou storagePath prefix pra rows pending).
  ATTACHMENTS: {
    STREAM: (id: string) => `/api/attachments/${id}`,
    UPLOAD: '/api/attachments/upload',
  },
} as const;

export default API_ENDPOINTS;
