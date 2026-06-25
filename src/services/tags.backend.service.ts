/**
 * Tags Backend Service
 *
 * Uses Express API via apiClient.
 *
 * REMOVED (FitPark): sync para sistema externo de labels (legado) — todos os
 * metodos *toExternal/*Labels/*Contacts foram removidos no escopo T-022.
 * Tags agora vivem so no proprio CRM.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { Tag, LeadTag } from './tags.cloud.service';

function mapBackendTag(t: any): Tag {
  return {
    id: t.id,
    account_id: t.account_id ?? t.accountId,
    funnel_id: t.funnel_id ?? t.funnelId,
    name: t.name,
    slug: t.slug,
    type: t.type,
    color: t.color,
    ordem: t.ordem ?? 0,
    ativo: t.ativo ?? true,
    created_at: t.created_at ?? t.createdAt,
  };
}

export const tagsBackendService = {
  async listStageTags(accountId: string): Promise<Tag[]> {
    const response = await apiClient.get<Tag[] | { data: Tag[] }>(API_ENDPOINTS.TAGS.LIST, {
      params: { type: 'stage', ativo: true, accountId },
    });
    const raw = Array.isArray(response) ? response : (response as any).data || [];
    return raw.map(mapBackendTag);
  },

  async listAllTags(accountId: string): Promise<Tag[]> {
    const response = await apiClient.get<Tag[] | { data: Tag[] }>(API_ENDPOINTS.TAGS.LIST, {
      params: { ativo: true, accountId },
    });
    const raw = Array.isArray(response) ? response : (response as any).data || [];
    return raw.map(mapBackendTag);
  },

  async createStageTag(input: {
    accountId: string;
    funnelId: string;
    name: string;
    color: string;
    ordem?: number;
  }): Promise<Tag> {
    return apiClient.post<Tag>(API_ENDPOINTS.TAGS.CREATE, {
      name: input.name,
      type: 'stage',
      color: input.color,
      funnelId: input.funnelId,
      ordem: input.ordem,
    });
  },

  async updateTag(tagId: string, input: Partial<Pick<Tag, 'name' | 'color' | 'ordem' | 'ativo'>>): Promise<Tag> {
    return apiClient.put<Tag>(API_ENDPOINTS.TAGS.UPDATE(tagId), input);
  },

  async deleteTag(tagId: string, options?: { force?: boolean; migrateToId?: string }): Promise<void> {
    const params: Record<string, string> = {};
    if (options?.force) params.force = 'true';
    if (options?.migrateToId) params.migrateToId = options.migrateToId;
    return apiClient.delete(API_ENDPOINTS.TAGS.DELETE(tagId), { params });
  },

  async swapTagOrder(tagId1: string, tagId2: string): Promise<void> {
    return apiClient.post(API_ENDPOINTS.TAGS.REORDER, {
      tagIds: [tagId1, tagId2],
    });
  },

  async getLeadTags(contactId: string): Promise<LeadTag[]> {
    // Backend devolve { data: LeadTag[] } (contact.controller.getTags).
    // Sem unwrap o componente recebe um objeto e `.map`/`.length` explodem
    // (bug do ContactSidePanel ao selecionar conversa em /admin/chat).
    const response = await apiClient.get<LeadTag[] | { data: LeadTag[] }>(
      API_ENDPOINTS.TAGS.BY_CONTACT(contactId)
    );
    if (Array.isArray(response)) return response;
    const data = (response as { data?: unknown })?.data;
    return Array.isArray(data) ? (data as LeadTag[]) : [];
  },

  async applyStageTag(contactId: string, tagId: string, source: string = 'kanban'): Promise<void> {
    await apiClient.post(API_ENDPOINTS.TAGS.ADD_TO_CONTACT(contactId), {
      tagId,
      source,
    });
  },

  async getTagHistory(contactId: string) {
    return apiClient.get<any[]>(API_ENDPOINTS.TAGS.HISTORY(contactId));
  },

  async getDefaultFunnel(accountId: string) {
    const response = await apiClient.get<any>(API_ENDPOINTS.FUNNELS.LIST, { params: { accountId } });
    const funnels = Array.isArray(response) ? response : (response?.data || []);
    return funnels.find((f: any) => f.is_default || f.isDefault) || funnels[0] || null;
  },

  async createDefaultFunnel(accountId: string) {
    const response = await apiClient.post<any>(API_ENDPOINTS.FUNNELS.CREATE, {
      name: 'Funil Principal',
      accountId,
      isDefault: true,
    });
    return response?.data ?? response;
  },
};
