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
      };
    } catch (error: any) {
      return { success: false, error: error.message || 'Erro ao criar contato' };
    }
  },

  // REMOVED: criacao integrada com plataforma externa de atendimento

  async applyStageTagToContact(
    contactId: string,
    tagId: string,
    source: 'kanban' | 'system' = 'kanban'
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
