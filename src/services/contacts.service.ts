/**
 * Contacts Service
 * 
 * Handles all contact/lead-related API calls.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { 
  ContactListParams, 
  CreateContactRequest, 
  UpdateContactRequest,
  MoveContactRequest,
  AddNoteRequest,
  PaginatedResponse 
} from '@/api/types';
import type { Contact, LeadNote } from '@/types/crm';
import { apiFeatures } from '@/config/api.config';

// Mock imports for development
import { mockContacts } from '@/mocks/data/mockData';

export const contactsService = {
  /**
   * List contacts with optional filters
   */
  list: async (params?: ContactListParams): Promise<PaginatedResponse<Contact>> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      let filtered = [...mockContacts];
      
      if (params?.search) {
        const search = params.search.toLowerCase();
        filtered = filtered.filter(c => 
          c.nome?.toLowerCase().includes(search) ||
          c.email?.toLowerCase().includes(search) ||
          c.telefone?.includes(search)
        );
      }
      
      if (params?.origem) {
        filtered = filtered.filter(c => c.origem === params.origem);
      }
      
      const page = params?.page || 1;
      const limit = params?.limit || 20;
      const start = (page - 1) * limit;
      const end = start + limit;
      
      return {
        data: filtered.slice(start, end),
        meta: {
          page,
          limit,
          total: filtered.length,
          totalPages: Math.ceil(filtered.length / limit),
        },
      };
    }
    
    return apiClient.get<PaginatedResponse<Contact>>(API_ENDPOINTS.CONTACTS.LIST, { params });
  },

  /**
   * Get a single contact by ID
   */
  get: async (id: string): Promise<Contact> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const contact = mockContacts.find(c => c.id === id);
      if (!contact) {
        throw { message: 'Contato não encontrado', status: 404 };
      }
      return contact;
    }
    
    return apiClient.get<Contact>(API_ENDPOINTS.CONTACTS.GET(id));
  },

  /**
   * Create a new contact
   */
  create: async (data: CreateContactRequest): Promise<Contact> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const newContact: Contact = {
        id: `contact-${Date.now()}`,
        account_id: 'acc-1',
        nome: data.nome,
        telefone: data.telefone || null,
        email: data.email || null,
        origem: data.origem || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      
      mockContacts.push(newContact);
      return newContact;
    }
    
    return apiClient.post<Contact>(API_ENDPOINTS.CONTACTS.CREATE, data);
  },

  /**
   * Update an existing contact
   */
  update: async (id: string, data: UpdateContactRequest): Promise<Contact> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockContacts.findIndex(c => c.id === id);
      if (index === -1) {
        throw { message: 'Contato não encontrado', status: 404 };
      }
      
      mockContacts[index] = {
        ...mockContacts[index],
        ...data,
        updated_at: new Date().toISOString(),
      };
      
      return mockContacts[index];
    }
    
    return apiClient.put<Contact>(API_ENDPOINTS.CONTACTS.UPDATE(id), data);
  },

  /**
   * Delete a contact
   */
  delete: async (id: string): Promise<void> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockContacts.findIndex(c => c.id === id);
      if (index === -1) {
        throw { message: 'Contato não encontrado', status: 404 };
      }
      
      mockContacts.splice(index, 1);
      return;
    }
    
    return apiClient.delete(API_ENDPOINTS.CONTACTS.DELETE(id));
  },

  /**
   * Search contacts
   */
  search: async (query: string): Promise<Contact[]> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const search = query.toLowerCase();
      return mockContacts.filter(c => 
        c.nome?.toLowerCase().includes(search) ||
        c.email?.toLowerCase().includes(search) ||
        c.telefone?.includes(search)
      ).slice(0, 10);
    }
    
    return apiClient.get<Contact[]>(API_ENDPOINTS.CONTACTS.SEARCH, { 
      params: { q: query } 
    });
  },

  /**
   * Move contact to a different stage
   */
  moveToStage: async (id: string, data: MoveContactRequest): Promise<void> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      // In mock mode, stage management is handled by TagContext
      return;
    }
    
    return apiClient.post(API_ENDPOINTS.CONTACTS.MOVE_STAGE(id), data);
  },

  /**
   * Get notes for a contact
   */
  getNotes: async (contactId: string): Promise<LeadNote[]> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      // Mock notes - would be stored separately in real implementation
      return [];
    }
    
    return apiClient.get<LeadNote[]>(API_ENDPOINTS.CONTACTS.NOTES(contactId));
  },

  /**
   * Add a note to a contact
   */
  addNote: async (contactId: string, data: AddNoteRequest): Promise<LeadNote> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const newNote: LeadNote = {
        id: `note-${Date.now()}`,
        contact_id: contactId,
        author_id: 'current-user',
        author_name: 'Usuário Atual',
        content: data.content,
        created_at: new Date().toISOString(),
      };
      
      return newNote;
    }
    
    return apiClient.post<LeadNote>(API_ENDPOINTS.CONTACTS.ADD_NOTE(contactId), data);
  },
};

export default contactsService;
