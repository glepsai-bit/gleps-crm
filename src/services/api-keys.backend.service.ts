/**
 * API Keys Backend Service
 *
 * Lista, cria e revoga API keys de uma conta via Express API.
 * Endpoints (backend já implementado):
 *   GET    /api/api-keys/accounts/:accountId
 *   POST   /api/api-keys/accounts/:accountId        body: { name }
 *   DELETE /api/api-keys/:id?accountId=...
 *
 * O backend nunca retorna o hash. O plaintextKey é retornado APENAS UMA VEZ
 * no momento da criação — daí o aviso na UI ("Copie agora — não será exibido
 * novamente.").
 *
 * TODO(t022-future): scopes são placeholder e foram removidos da UI/payload.
 * Toda chave criada tem god-mode no escopo da accountId dona. Ver
 * backend/src/middlewares/apiKey.middleware.ts para o plano de habilitar
 * requireScope().
 */

import { apiClient } from '@/api/client';

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  /**
   * TODO(t022-future): scopes nunca é checado pelo backend hoje. Mantido no
   * tipo só por compat com a resposta do banco. Sempre vem [] em chaves novas.
   */
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
  // TODO(t022-future): scopes removido — toda chave tem god-mode na conta.
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

    // TODO(t022-future): scopes não enviado — backend ignora e força [].
    const resp = await apiClient.post<any>(
      `/api/api-keys/accounts/${accountId}`,
      {
        name: input.name.trim(),
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
