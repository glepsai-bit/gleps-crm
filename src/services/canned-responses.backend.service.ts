/**
 * Canned Responses Backend Service (T-022 — chat interno)
 *
 * CRUD de respostas prontas (model Prisma `CannedResponse`).
 * - Escopadas por accountId no backend (resolvido via JWT).
 * - shortCode é normalizado server-side (lowercase, sem barra inicial).
 *   Ex.: "/Saudacao " -> "saudacao".
 * - Conflito de shortCode dentro da conta retorna 409 (ConflictError no service).
 *
 * Backend: backend/src/services/canned-response.service.ts
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

export interface CannedResponse {
  id: string;
  accountId: string;
  shortCode: string;
  content: string;
  description: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCannedResponseInput {
  shortCode: string;
  content: string;
  description?: string | null;
}

export interface UpdateCannedResponseInput {
  shortCode?: string;
  content?: string;
  description?: string | null;
}

function unwrap<T>(resp: any): T {
  return (resp?.data ?? resp) as T;
}

function mapCannedResponse(raw: any): CannedResponse {
  return {
    id: raw.id,
    accountId: raw.accountId ?? raw.account_id,
    shortCode: raw.shortCode ?? raw.short_code ?? '',
    content: raw.content ?? '',
    description: raw.description ?? null,
    createdById: raw.createdById ?? raw.created_by_id ?? null,
    createdAt: raw.createdAt ?? raw.created_at,
    updatedAt: raw.updatedAt ?? raw.updated_at ?? raw.createdAt ?? raw.created_at,
  };
}

export const cannedResponsesBackendService = {
  /**
   * Lista respostas prontas da conta autenticada. Quando `search` é informado,
   * o backend filtra (case-insensitive) por shortCode/content/description.
   */
  async listCannedResponses(search?: string): Promise<CannedResponse[]> {
    const params: Record<string, string> = {};
    if (search && search.trim().length > 0) {
      params.search = search.trim();
    }
    const resp = await apiClient.get<any>(API_ENDPOINTS.CANNED_RESPONSES.LIST, {
      params: Object.keys(params).length > 0 ? params : undefined,
    });
    const items = unwrap<any[]>(resp);
    return Array.isArray(items) ? items.map(mapCannedResponse) : [];
  },

  /**
   * Busca uma resposta pronta por id (escopo garantido pelo backend).
   */
  async get(id: string): Promise<CannedResponse> {
    if (!id) throw new Error('id é obrigatório');
    const resp = await apiClient.get<any>(API_ENDPOINTS.CANNED_RESPONSES.GET(id));
    return mapCannedResponse(unwrap<any>(resp));
  },

  /**
   * Cria nova resposta pronta. Lança erro 409 se shortCode já existir na conta.
   */
  async create(input: CreateCannedResponseInput): Promise<CannedResponse> {
    if (!input?.shortCode?.trim()) throw new Error('shortCode é obrigatório');
    if (!input?.content?.trim()) throw new Error('content é obrigatório');
    const resp = await apiClient.post<any>(API_ENDPOINTS.CANNED_RESPONSES.CREATE, {
      shortCode: input.shortCode,
      content: input.content,
      description: input.description ?? null,
    });
    return mapCannedResponse(unwrap<any>(resp));
  },

  /**
   * Atualização parcial. Mantém valores não enviados.
   */
  async update(id: string, input: UpdateCannedResponseInput): Promise<CannedResponse> {
    if (!id) throw new Error('id é obrigatório');
    const resp = await apiClient.patch<any>(
      API_ENDPOINTS.CANNED_RESPONSES.UPDATE(id),
      input
    );
    return mapCannedResponse(unwrap<any>(resp));
  },

  /**
   * Remove a resposta pronta.
   */
  async delete(id: string): Promise<void> {
    if (!id) throw new Error('id é obrigatório');
    await apiClient.delete(API_ENDPOINTS.CANNED_RESPONSES.DELETE(id));
  },
};

export default cannedResponsesBackendService;
