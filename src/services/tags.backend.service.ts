/**
 * Tags Backend Service
 * 
 * Uses Express API via apiClient instead of Supabase.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { Tag, LeadTag, ImportLabelsResult, SyncContactsResult } from './tags.cloud.service';

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
    chatwoot_label_id: t.chatwoot_label_id ?? t.chatwootLabelId ?? null,
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
    return apiClient.get<LeadTag[]>(API_ENDPOINTS.TAGS.BY_CONTACT(contactId));
  },

  async applyStageTag(contactId: string, tagId: string, source: string = 'kanban'): Promise<void> {
    await apiClient.post(API_ENDPOINTS.TAGS.ADD_TO_CONTACT(contactId), {
      tagId,
      source,
    });
  },

  async updateContactLabelsInChatwoot(
    accountId: string,
    contactId: string,
    newStageTagId: string,
    oldStageTagId?: string
  ): Promise<{ success: boolean }> {
    return apiClient.post<{ success: boolean }>(API_ENDPOINTS.CHATWOOT.SYNC, {
      action: 'update-contact-labels',
      accountId,
      contactId,
      newStageTagId,
      oldStageTagId,
    });
  },

  async pushLabelToChatwoot(
    accountId: string,
    action: 'create' | 'update' | 'delete',
    label: { title: string; color: string; description?: string },
    tagId?: string,
    chatwootLabelId?: number
  ): Promise<{ success: boolean; chatwoot_label_id?: number }> {
    return apiClient.post<{ success: boolean; chatwoot_label_id?: number }>(
      API_ENDPOINTS.CHATWOOT.SYNC,
      { action: 'push-label', accountId, labelAction: action, label, tagId, chatwootLabelId }
    );
  },

  async pushAllLabelsToChatwoot(accountId: string, resetIds = false) {
    return apiClient.post<{
      success: boolean;
      pushed: number;
      linked: number;
      errors: string[];
      details: Array<{ name: string; action: string; reason?: string }>;
    }>(API_ENDPOINTS.CHATWOOT.SYNC, {
      action: 'push-all-labels',
      accountId,
      resetIds,
    });
  },

  async syncChatwootLabels(accountId: string): Promise<ImportLabelsResult> {
    return apiClient.post<ImportLabelsResult>(API_ENDPOINTS.CHATWOOT.SYNC, {
      action: 'sync-labels',
      accountId,
    });
  },

  async syncChatwootContacts(accountId: string): Promise<SyncContactsResult> {
    return apiClient.post<SyncContactsResult>(API_ENDPOINTS.CHATWOOT.SYNC, {
      action: 'sync-contacts',
      accountId,
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
