/**
 * Contacts Backend Service
 * 
 * Uses Express API via apiClient instead of Supabase.
 * Returns normalized CreateContactResult to match cloud service interface.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { 
  CreateContactInput, 
  CreateContactWithChatwootInput, 
  CreateContactResult, 
  DeleteLeadResult 
} from './contacts.cloud.service';

export const contactsBackendService = {
  async createContact(input: CreateContactInput): Promise<CreateContactResult> {
    try {
      const res = await apiClient.post<any>(API_ENDPOINTS.CONTACTS.CREATE, {
        nome: input.nome,
        telefone: input.telefone,
        email: input.email,
        origem: input.origem,
        accountId: input.account_id,
      });
      const contact = res.data || res;
      return {
        success: true,
        contact_id: contact.id,
        chatwoot_contact_id: contact.chatwootContactId || null,
        chatwoot_conversation_id: contact.chatwootConversationId || null,
      };
    } catch (error: any) {
      return { success: false, error: error.message || 'Erro ao criar contato' };
    }
  },

  async createContactWithChatwoot(input: CreateContactWithChatwootInput): Promise<CreateContactResult> {
    try {
      const res = await apiClient.post<any>(API_ENDPOINTS.CONTACTS.CREATE, {
        nome: input.nome,
        telefone: input.telefone,
        email: input.email,
        origem: input.origem,
        accountId: input.account_id,
        createConversation: input.create_conversation,
        initialStageTagId: input.initial_stage_tag_id,
      });
      const contact = res.data || res;
      return {
        success: true,
        contact_id: contact.id,
        chatwoot_contact_id: contact.chatwootContactId || null,
        chatwoot_conversation_id: contact.chatwootConversationId || null,
      };
    } catch (error: any) {
      return { success: false, error: error.message || 'Erro ao criar contato no Chatwoot' };
    }
  },

  async applyStageTagToContact(
    contactId: string,
    tagId: string,
    source: 'kanban' | 'chatwoot' | 'system' = 'kanban'
  ): Promise<{ success: boolean; error?: string }> {
    return apiClient.post<{ success: boolean; error?: string }>(
      API_ENDPOINTS.TAGS.ADD_TO_CONTACT(contactId),
      { tagId, source }
    );
  },

  async deleteLead(contactId: string): Promise<DeleteLeadResult> {
    try {
      await apiClient.delete(API_ENDPOINTS.CONTACTS.DELETE(contactId));
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || 'Erro ao remover lead' };
    }
  },
};
