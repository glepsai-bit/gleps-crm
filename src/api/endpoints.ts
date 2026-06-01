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

  // ============= CONTACTS SERVICE =============
  CONTACTS: {
    LIST: '/api/contacts',
    GET: (id: string) => `/api/contacts/${id}`,
    CREATE: '/api/contacts',
    UPDATE: (id: string) => `/api/contacts/${id}`,
    DELETE: (id: string) => `/api/contacts/${id}`,
    SEARCH: '/api/contacts/search',
    BY_STAGE: (stageId: string) => `/api/contacts/stage/${stageId}`,
    MOVE_STAGE: (id: string) => `/api/contacts/${id}/move`,
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

  // ============= CHATWOOT INTEGRATION =============
  CHATWOOT: {
    AGENTS: '/api/chatwoot/agents',
    IMPORT_AGENTS: '/api/chatwoot/agents/import',
    CONVERSATIONS: '/api/chatwoot/conversations',
    CONVERSATION: (id: string) => `/api/chatwoot/conversations/${id}`,
    MESSAGES: (conversationId: string) => `/api/chatwoot/conversations/${conversationId}/messages`,
    METRICS: '/api/chatwoot/metrics',
    SYNC: '/api/chatwoot/sync',
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
} as const;

export default API_ENDPOINTS;
