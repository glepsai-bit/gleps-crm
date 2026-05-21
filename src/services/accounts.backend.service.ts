/**
 * Accounts Backend Service
 * 
 * Uses Express API via apiClient instead of Supabase.
 * Maps camelCase backend responses to snake_case UI format.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { Account, CreateAccountInput, UpdateAccountInput } from './accounts.cloud.service';

/**
 * Maps a camelCase backend account object to the snake_case Account shape expected by the UI.
 */
function mapAccount(raw: any): Account {
  return {
    id: raw.id,
    nome: raw.nome,
    status: raw.status || 'active',
    timezone: raw.timezone || 'America/Sao_Paulo',
    plano: raw.plano ?? null,
    limite_usuarios: raw.limiteUsuarios ?? raw.limite_usuarios ?? 10,
    monthly_extraction_limit: raw.monthlyExtractionLimit ?? raw.monthly_extraction_limit ?? 500,
    monthly_email_limit: raw.monthlyEmailLimit ?? raw.monthly_email_limit ?? 3000,
    daily_email_limit: raw.dailyEmailLimit ?? raw.daily_email_limit ?? 100,
    chatwoot_base_url: raw.chatwootBaseUrl ?? raw.chatwoot_base_url ?? null,
    chatwoot_account_id: raw.chatwootAccountId ?? raw.chatwoot_account_id ?? null,
    chatwoot_api_key: raw.chatwootApiKey ?? raw.chatwoot_api_key ?? null,
    google_client_id: raw.googleClientId ?? raw.google_client_id ?? null,
    google_client_secret: raw.googleClientSecret ?? raw.google_client_secret ?? null,
    google_redirect_uri: raw.googleRedirectUri ?? raw.google_redirect_uri ?? null,
    created_at: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    updated_at: raw.updatedAt ?? raw.updated_at ?? new Date().toISOString(),
    users_count: raw.usersCount ?? raw.users_count ?? 0,
  };
}

export const accountsBackendService = {
  async list(): Promise<Account[]> {
    const response = await apiClient.get<any>(API_ENDPOINTS.ACCOUNTS.LIST);
    // Backend returns { data: [...], meta: {...} } or just an array
    const items = Array.isArray(response) ? response : (response?.data || response);
    return (Array.isArray(items) ? items : []).map(mapAccount);
  },

  async getById(id: string): Promise<Account | null> {
    const response = await apiClient.get<any>(API_ENDPOINTS.ACCOUNTS.GET(id));
    const raw = response?.data ?? response;
    return raw ? mapAccount(raw) : null;
  },

  async create(input: CreateAccountInput): Promise<Account> {
    const response = await apiClient.post<any>(API_ENDPOINTS.ACCOUNTS.CREATE, {
      nome: input.nome,
      plano: input.plano,
      chatwootBaseUrl: input.chatwoot_base_url,
      chatwootAccountId: input.chatwoot_account_id,
      chatwootApiKey: input.chatwoot_api_key,
      monthlyExtractionLimit: input.monthly_extraction_limit,
      monthlyEmailLimit: input.monthly_email_limit,
      dailyEmailLimit: input.daily_email_limit,
    });
    const raw = response?.data ?? response;
    return mapAccount(raw);
  },

  async update(id: string, input: UpdateAccountInput): Promise<Account> {
    const response = await apiClient.put<any>(API_ENDPOINTS.ACCOUNTS.UPDATE(id), {
      nome: input.nome,
      status: input.status,
      plano: input.plano,
      chatwootBaseUrl: input.chatwoot_base_url,
      chatwootAccountId: input.chatwoot_account_id,
      chatwootApiKey: input.chatwoot_api_key,
      monthlyExtractionLimit: input.monthly_extraction_limit,
      monthlyEmailLimit: input.monthly_email_limit,
      dailyEmailLimit: input.daily_email_limit,
      googleClientId: input.google_client_id,
      googleClientSecret: input.google_client_secret,
      googleRedirectUri: input.google_redirect_uri,
      openaiApiKey: input.openai_api_key,
      sendgridApiKey: input.sendgrid_api_key,
      sendgridFromEmail: input.sendgrid_from_email,
      sendgridFromName: input.sendgrid_from_name,
    });
    const raw = response?.data ?? response;
    return mapAccount(raw);
  },

  async delete(id: string, password?: string): Promise<void> {
    if (!password || !password.trim()) {
      throw { message: 'Senha de confirmação é obrigatória', status: 400 };
    }
    // Send password in both header and body for proxy compatibility
    await apiClient.delete(API_ENDPOINTS.ACCOUNTS.DELETE(id), {
      headers: { 'x-confirm-password': password.trim() },
      body: JSON.stringify({ password: password.trim() }),
    });
  },

  async getUsers(accountId: string) {
    return apiClient.get<any[]>(API_ENDPOINTS.USERS.BY_ACCOUNT(accountId));
  },

  async testChatwootConnection(
    baseUrl: string,
    accountId: string,
    apiKey: string
  ): Promise<{ success: boolean; message: string; agents?: any[]; inboxes?: any[]; labels?: any[] }> {
    const result = await apiClient.post<any>('/api/chatwoot/test-connection', {
      baseUrl,
      accountId,
      apiKey,
    });
    // Normalize: ensure agents/inboxes/labels are always arrays
    return {
      success: result.success,
      message: result.message || (result.success ? 'Conexão estabelecida' : 'Falha na conexão'),
      agents: Array.isArray(result.agents) ? result.agents : [],
      inboxes: Array.isArray(result.inboxes) ? result.inboxes : [],
      labels: Array.isArray(result.labels) ? result.labels : [],
    };
  },

  async fetchChatwootAgents(baseUrl: string, accountId: string, apiKey: string) {
    // Try test-connection first (returns agents in new backend)
    try {
      const result = await this.testChatwootConnection(baseUrl, accountId, apiKey);
      if (result.agents && result.agents.length > 0) return result.agents;
    } catch (_) { /* fallback below */ }
    // Fallback: dedicated agents endpoint
    try {
      return await apiClient.post<any[]>('/api/chatwoot/agents/fetch', { baseUrl, accountId, apiKey });
    } catch (_) {
      return [];
    }
  },
};
