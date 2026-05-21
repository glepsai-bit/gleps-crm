/**
 * Tags Service
 * 
 * Handles all tag/stage-related API calls.
 * Tags serve dual purpose: Chatwoot labels and Kanban stages.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { 
  TagListParams, 
  CreateTagRequest, 
  UpdateTagRequest,
  ReorderTagsRequest,
  ApplyTagRequest 
} from '@/api/types';
import type { Tag, LeadTag, TagHistory } from '@/types/crm';
import { apiFeatures } from '@/config/api.config';

// Mock imports for development
import { mockTags } from '@/mocks/data/mockData';

export const tagsService = {
  /**
   * List tags with optional filters
   */
  list: async (params?: TagListParams): Promise<Tag[]> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      
      let filtered = [...mockTags];
      
      if (params?.funnelId) {
        filtered = filtered.filter(t => t.funnel_id === params.funnelId);
      }
      
      if (params?.type) {
        filtered = filtered.filter(t => t.type === params.type);
      }
      
      if (params?.ativo !== undefined) {
        filtered = filtered.filter(t => t.ativo === params.ativo);
      }
      
      // Sort by order
      filtered.sort((a, b) => a.ordem - b.ordem);
      
      return filtered;
    }
    
    return apiClient.get<Tag[]>(API_ENDPOINTS.TAGS.LIST, { params });
  },

  /**
   * Get stage tags only (for Kanban)
   */
  getStages: async (funnelId?: string): Promise<Tag[]> => {
    return tagsService.list({ 
      type: 'stage', 
      ativo: true,
      ...(funnelId && { funnelId }) 
    });
  },

  /**
   * Get a single tag by ID
   */
  get: async (id: string): Promise<Tag> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const tag = mockTags.find(t => t.id === id);
      if (!tag) {
        throw { message: 'Tag não encontrada', status: 404 };
      }
      return tag;
    }
    
    return apiClient.get<Tag>(API_ENDPOINTS.TAGS.GET(id));
  },

  /**
   * Create a new tag
   */
  create: async (data: CreateTagRequest): Promise<Tag> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const existingTags = mockTags.filter(t => t.funnel_id === data.funnelId);
      const maxOrdem = existingTags.length > 0 
        ? Math.max(...existingTags.map(t => t.ordem)) 
        : 0;
      
      const newTag: Tag = {
        id: `tag-${Date.now()}`,
        account_id: 'acc-1',
        funnel_id: data.funnelId,
        name: data.name,
        slug: data.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
        type: data.type,
        color: data.color,
        ordem: data.ordem ?? maxOrdem + 1,
        ativo: true,
        created_at: new Date().toISOString(),
      };
      
      mockTags.push(newTag);
      return newTag;
    }
    
    return apiClient.post<Tag>(API_ENDPOINTS.TAGS.CREATE, data);
  },

  /**
   * Update an existing tag
   */
  update: async (id: string, data: UpdateTagRequest): Promise<Tag> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockTags.findIndex(t => t.id === id);
      if (index === -1) {
        throw { message: 'Tag não encontrada', status: 404 };
      }
      
      mockTags[index] = {
        ...mockTags[index],
        ...(data.name && { 
          name: data.name,
          slug: data.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
        }),
        ...(data.color && { color: data.color }),
        ...(data.ordem !== undefined && { ordem: data.ordem }),
        ...(data.ativo !== undefined && { ativo: data.ativo }),
      };
      
      return mockTags[index];
    }
    
    return apiClient.put<Tag>(API_ENDPOINTS.TAGS.UPDATE(id), data);
  },

  /**
   * Delete a tag
   */
  delete: async (id: string): Promise<void> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockTags.findIndex(t => t.id === id);
      if (index === -1) {
        throw { message: 'Tag não encontrada', status: 404 };
      }
      
      mockTags.splice(index, 1);
      return;
    }
    
    return apiClient.delete(API_ENDPOINTS.TAGS.DELETE(id));
  },

  /**
   * Reorder tags
   */
  reorder: async (data: ReorderTagsRequest): Promise<void> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      data.tags.forEach(({ id, ordem }) => {
        const tag = mockTags.find(t => t.id === id);
        if (tag) {
          tag.ordem = ordem;
        }
      });
      
      return;
    }
    
    return apiClient.post(API_ENDPOINTS.TAGS.REORDER, data);
  },

  /**
   * Get tags applied to a contact
   */
  getByContact: async (contactId: string): Promise<LeadTag[]> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      // Mock lead tags - would be stored separately
      return [];
    }
    
    return apiClient.get<LeadTag[]>(API_ENDPOINTS.TAGS.BY_CONTACT(contactId));
  },

  /**
   * Apply a tag to a contact
   */
  applyToContact: async (contactId: string, data: ApplyTagRequest): Promise<LeadTag> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const newLeadTag: LeadTag = {
        id: `lead-tag-${Date.now()}`,
        contact_id: contactId,
        tag_id: data.tagId,
        applied_by_type: 'user',
        applied_by_id: 'current-user',
        source: data.source || 'kanban',
        created_at: new Date().toISOString(),
      };
      
      return newLeadTag;
    }
    
    return apiClient.post<LeadTag>(API_ENDPOINTS.TAGS.ADD_TO_CONTACT(contactId), data);
  },

  /**
   * Remove a tag from a contact
   */
  removeFromContact: async (contactId: string, tagId: string): Promise<void> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      return;
    }
    
    return apiClient.delete(API_ENDPOINTS.TAGS.REMOVE_FROM_CONTACT(contactId, tagId));
  },

  /**
   * Get tag history for a contact
   */
  getHistory: async (contactId: string): Promise<TagHistory[]> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      // Mock history - would be stored separately
      return [];
    }
    
    return apiClient.get<TagHistory[]>(API_ENDPOINTS.TAGS.HISTORY(contactId));
  },
};

export default tagsService;
