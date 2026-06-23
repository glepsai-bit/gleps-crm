/**
 * API Keys Backend Service
 *
 * Lista, cria e revoga API keys de uma conta via Express API.
 * Endpoints (backend já implementado):
 *   GET    /api/api-keys/accounts/:accountId
 *   POST   /api/api-keys/accounts/:accountId        body: { name, scopes? }
 *   DELETE /api/api-keys/:id?accountId=...
 *
 * O backend nunca retorna o hash. O plaintextKey é retornado APENAS UMA VEZ
 * no momento da criação — daí o aviso na UI ("Copie agora — não será exibido
 * novamente.").
 */

import { apiClient } from '@/api/client';

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  /** Texto plano — exibido uma única vez no momento da criação. */
  plaintextKey: string;
  prefix: string;
  createdAt: string;
}

export interface CreateApiKeyInput {
  name: string;
  scopes?: string[];
}

function unwrap<T>(resp: any): T {
  return (resp?.data ?? resp) as T;
}

class ApiKeysBackendService {
  async listApiKeys(accountId: string): Promise<ApiKey[]> {
    if (!accountId) return [];
    const resp = await apiClient.get<any>(`/api/api-keys/accounts/${accountId}`);
    const items = unwrap<any[]>(resp);
    return Array.isArray(items) ? items.map(this.mapApiKey) : [];
  }

  async createApiKey(
    accountId: string,
    input: CreateApiKeyInput
  ): Promise<CreatedApiKey> {
    if (!accountId) throw new Error('accountId é obrigatório');
    if (!input?.name?.trim()) throw new Error('Nome é obrigatório');

    const resp = await apiClient.post<any>(
      `/api/api-keys/accounts/${accountId}`,
      {
        name: input.name.trim(),
        scopes: input.scopes ?? [],
      }
    );
    const raw = unwrap<any>(resp);
    return {
      id: raw.id,
      name: raw.name,
      plaintextKey: raw.plaintextKey,
      prefix: raw.prefix,
      createdAt: raw.createdAt,
    };
  }

  async revokeApiKey(id: string, accountId: string): Promise<void> {
    if (!id) throw new Error('id da API key é obrigatório');
    if (!accountId) throw new Error('accountId é obrigatório');
    await apiClient.delete(`/api/api-keys/${id}`, {
      params: { accountId },
    });
  }

  private mapApiKey(raw: any): ApiKey {
    return {
      id: raw.id,
      name: raw.name,
      prefix: raw.prefix ?? raw.keyPrefix ?? '',
      scopes: Array.isArray(raw.scopes) ? raw.scopes : [],
      lastUsedAt: raw.lastUsedAt ?? null,
      revokedAt: raw.revokedAt ?? null,
      createdAt: raw.createdAt,
    };
  }
}

export const apiKeysBackendService = new ApiKeysBackendService();
