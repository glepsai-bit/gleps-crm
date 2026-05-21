/**
 * Users Backend Service
 * 
 * Uses Express API via apiClient instead of Supabase.
 * Maps camelCase backend responses to snake_case UI format.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { Profile, CreateUserInput } from './users.cloud.service';

/**
 * Maps a camelCase backend user object to the snake_case Profile shape expected by the UI.
 */
function mapProfile(raw: any): Profile {
  return {
    id: raw.id,
    user_id: raw.id, // backend uses 'id' as the user id directly
    account_id: raw.accountId ?? raw.account_id ?? null,
    nome: raw.nome,
    email: raw.email,
    status: raw.status || 'active',
    permissions: raw.permissions || ['dashboard'],
    chatwoot_agent_id: raw.chatwootAgentId ?? raw.chatwoot_agent_id ?? null,
    created_at: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    updated_at: raw.updatedAt ?? raw.updated_at ?? new Date().toISOString(),
    role: raw.role,
  };
}

export const usersBackendService = {
  async list(accountId?: string): Promise<Profile[]> {
    const params = accountId ? { accountId } : undefined;
    const response = await apiClient.get<any>(
      API_ENDPOINTS.USERS.LIST, 
      { params }
    );
    // Backend returns { data: [...], meta: {...} } or just an array
    const items = Array.isArray(response) ? response : (response?.data || response);
    return (Array.isArray(items) ? items : []).map(mapProfile);
  },

  async getById(userId: string): Promise<Profile | null> {
    const response = await apiClient.get<any>(API_ENDPOINTS.USERS.GET(userId));
    const raw = response?.data ?? response;
    return raw ? mapProfile(raw) : null;
  },

  async create(input: CreateUserInput): Promise<Profile> {
    const response = await apiClient.post<any>(API_ENDPOINTS.USERS.CREATE, {
      email: input.email,
      password: input.password,
      nome: input.nome,
      role: input.role,
      accountId: input.account_id,
      permissions: input.permissions,
      chatwootAgentId: input.chatwoot_agent_id,
    });
    const raw = response?.data ?? response;
    return mapProfile(raw);
  },

  async update(userId: string, input: Partial<Profile> & { role?: 'admin' | 'agent' }): Promise<Profile> {
    const response = await apiClient.put<any>(API_ENDPOINTS.USERS.UPDATE(userId), {
      nome: input.nome,
      status: input.status,
      role: input.role,
      permissions: input.permissions,
      chatwootAgentId: input.chatwoot_agent_id,
    });
    const raw = response?.data ?? response;
    return mapProfile(raw);
  },

  async delete(userId: string, adminPassword: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.USERS.DELETE(userId), {
      headers: {
        'x-confirm-password': adminPassword,
      },
    });
  },
};
