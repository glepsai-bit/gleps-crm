/**
 * Accounts Service
 * 
 * Handles all account-related API calls (Super Admin only).
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { 
  AccountListParams, 
  CreateAccountRequest, 
  UpdateAccountRequest,
  PaginatedResponse 
} from '@/api/types';
import type { Account } from '@/types/crm';
import { apiFeatures } from '@/config/api.config';

// Mock imports for development
import { mockAccounts } from '@/mocks/data/mockData';

export const accountsService = {
  /**
   * List accounts with optional filters
   */
  list: async (params?: AccountListParams): Promise<PaginatedResponse<Account>> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      let filtered = [...mockAccounts];
      
      if (params?.status) {
        filtered = filtered.filter(a => a.status === params.status);
      }
      
      if (params?.search) {
        const search = params.search.toLowerCase();
        filtered = filtered.filter(a => 
          a.nome.toLowerCase().includes(search)
        );
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
    
    return apiClient.get<PaginatedResponse<Account>>(API_ENDPOINTS.ACCOUNTS.LIST, { params });
  },

  /**
   * Get a single account by ID
   */
  get: async (id: string): Promise<Account> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const account = mockAccounts.find(a => a.id === id);
      if (!account) {
        throw { message: 'Conta não encontrada', status: 404 };
      }
      return account;
    }
    
    return apiClient.get<Account>(API_ENDPOINTS.ACCOUNTS.GET(id));
  },

  /**
   * Create a new account
   */
  create: async (data: CreateAccountRequest): Promise<Account> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const newAccount: Account = {
        id: `acc-${Date.now()}`,
        nome: data.nome,
        timezone: data.timezone || 'America/Sao_Paulo',
        plano: data.plano || null,
        status: 'active',
        limite_usuarios: data.limiteUsuarios || 5,
        chatwoot_account_id: data.chatwootAccountId || null,
        chatwoot_api_key: data.chatwootApiKey || null,
        chatwoot_base_url: data.chatwootBaseUrl || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      
      mockAccounts.push(newAccount);
      return newAccount;
    }
    
    return apiClient.post<Account>(API_ENDPOINTS.ACCOUNTS.CREATE, data);
  },

  /**
   * Update an existing account
   */
  update: async (id: string, data: UpdateAccountRequest): Promise<Account> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockAccounts.findIndex(a => a.id === id);
      if (index === -1) {
        throw { message: 'Conta não encontrada', status: 404 };
      }
      
      mockAccounts[index] = {
        ...mockAccounts[index],
        ...(data.nome && { nome: data.nome }),
        ...(data.plano !== undefined && { plano: data.plano }),
        ...(data.status && { status: data.status }),
        ...(data.limiteUsuarios !== undefined && { limite_usuarios: data.limiteUsuarios }),
        ...(data.timezone && { timezone: data.timezone }),
        ...(data.chatwootAccountId !== undefined && { chatwoot_account_id: data.chatwootAccountId }),
        ...(data.chatwootApiKey !== undefined && { chatwoot_api_key: data.chatwootApiKey }),
        ...(data.chatwootBaseUrl !== undefined && { chatwoot_base_url: data.chatwootBaseUrl }),
        updated_at: new Date().toISOString(),
      };
      
      return mockAccounts[index];
    }
    
    return apiClient.put<Account>(API_ENDPOINTS.ACCOUNTS.UPDATE(id), data);
  },

  /**
   * Delete an account
   */
  delete: async (id: string): Promise<void> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockAccounts.findIndex(a => a.id === id);
      if (index === -1) {
        throw { message: 'Conta não encontrada', status: 404 };
      }
      
      mockAccounts.splice(index, 1);
      return;
    }
    
    return apiClient.delete(API_ENDPOINTS.ACCOUNTS.DELETE(id));
  },

  /**
   * Pause an account
   */
  pause: async (id: string): Promise<Account> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockAccounts.findIndex(a => a.id === id);
      if (index === -1) {
        throw { message: 'Conta não encontrada', status: 404 };
      }
      
      mockAccounts[index] = {
        ...mockAccounts[index],
        status: 'paused',
        updated_at: new Date().toISOString(),
      };
      
      return mockAccounts[index];
    }
    
    return apiClient.post<Account>(API_ENDPOINTS.ACCOUNTS.PAUSE(id));
  },

  /**
   * Activate an account
   */
  activate: async (id: string): Promise<Account> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockAccounts.findIndex(a => a.id === id);
      if (index === -1) {
        throw { message: 'Conta não encontrada', status: 404 };
      }
      
      mockAccounts[index] = {
        ...mockAccounts[index],
        status: 'active',
        updated_at: new Date().toISOString(),
      };
      
      return mockAccounts[index];
    }
    
    return apiClient.post<Account>(API_ENDPOINTS.ACCOUNTS.ACTIVATE(id));
  },

  /**
   * Get account statistics
   */
  getStats: async (id: string) => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      return {
        totalUsers: 5,
        activeUsers: 4,
        totalContacts: 150,
        totalSales: 45,
        revenue: 15000,
      };
    }
    
    return apiClient.get(API_ENDPOINTS.ACCOUNTS.STATS(id));
  },
};

export default accountsService;
