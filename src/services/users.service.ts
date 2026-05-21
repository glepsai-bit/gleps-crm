/**
 * Users Service
 * 
 * Handles all user-related API calls.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { 
  UserListParams, 
  CreateUserRequest, 
  UpdateUserRequest,
  PaginatedResponse 
} from '@/api/types';
import type { User } from '@/types/crm';
import { apiFeatures } from '@/config/api.config';

// Mock imports for development
import { mockUsers } from '@/mocks/data/mockData';

export const usersService = {
  /**
   * List users with optional filters
   */
  list: async (params?: UserListParams): Promise<PaginatedResponse<User>> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      let filtered = [...mockUsers];
      
      if (params?.role) {
        filtered = filtered.filter(u => u.role === params.role);
      }
      
      if (params?.status) {
        filtered = filtered.filter(u => u.status === params.status);
      }
      
      if (params?.accountId) {
        filtered = filtered.filter(u => u.account_id === params.accountId);
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
    
    return apiClient.get<PaginatedResponse<User>>(API_ENDPOINTS.USERS.LIST, { params });
  },

  /**
   * Get a single user by ID
   */
  get: async (id: string): Promise<User> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const user = mockUsers.find(u => u.id === id);
      if (!user) {
        throw { message: 'Usuário não encontrado', status: 404 };
      }
      return user;
    }
    
    return apiClient.get<User>(API_ENDPOINTS.USERS.GET(id));
  },

  /**
   * Create a new user
   */
  create: async (data: CreateUserRequest): Promise<User> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Check if email already exists
      if (mockUsers.some(u => u.email === data.email)) {
        throw { message: 'Email já cadastrado', status: 400 };
      }
      
      const newUser: User = {
        id: `user-${Date.now()}`,
        account_id: data.accountId,
        nome: data.nome,
        email: data.email,
        role: data.role,
        status: 'active',
        permissions: data.permissions || [],
        chatwoot_agent_id: data.chatwootAgentId || null,
        last_login_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      
      mockUsers.push(newUser);
      return newUser;
    }
    
    return apiClient.post<User>(API_ENDPOINTS.USERS.CREATE, data);
  },

  /**
   * Update an existing user
   */
  update: async (id: string, data: UpdateUserRequest): Promise<User> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockUsers.findIndex(u => u.id === id);
      if (index === -1) {
        throw { message: 'Usuário não encontrado', status: 404 };
      }
      
      // Check if changing email to one that already exists
      if (data.email && data.email !== mockUsers[index].email) {
        if (mockUsers.some(u => u.email === data.email)) {
          throw { message: 'Email já cadastrado', status: 400 };
        }
      }
      
      mockUsers[index] = {
        ...mockUsers[index],
        ...(data.nome && { nome: data.nome }),
        ...(data.email && { email: data.email }),
        ...(data.role && { role: data.role }),
        ...(data.status && { status: data.status }),
        ...(data.permissions && { permissions: data.permissions }),
        ...(data.chatwootAgentId !== undefined && { chatwoot_agent_id: data.chatwootAgentId }),
        updated_at: new Date().toISOString(),
      };
      
      return mockUsers[index];
    }
    
    return apiClient.put<User>(API_ENDPOINTS.USERS.UPDATE(id), data);
  },

  /**
   * Delete a user
   */
  delete: async (id: string): Promise<void> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockUsers.findIndex(u => u.id === id);
      if (index === -1) {
        throw { message: 'Usuário não encontrado', status: 404 };
      }
      
      mockUsers.splice(index, 1);
      return;
    }
    
    return apiClient.delete(API_ENDPOINTS.USERS.DELETE(id));
  },

  /**
   * Get users by account
   */
  getByAccount: async (accountId: string): Promise<User[]> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      return mockUsers.filter(u => u.account_id === accountId);
    }
    
    return apiClient.get<User[]>(API_ENDPOINTS.USERS.BY_ACCOUNT(accountId));
  },

  /**
   * Update user status
   */
  updateStatus: async (id: string, status: 'active' | 'inactive' | 'suspended'): Promise<User> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockUsers.findIndex(u => u.id === id);
      if (index === -1) {
        throw { message: 'Usuário não encontrado', status: 404 };
      }
      
      mockUsers[index] = {
        ...mockUsers[index],
        status,
        updated_at: new Date().toISOString(),
      };
      
      return mockUsers[index];
    }
    
    return apiClient.patch<User>(API_ENDPOINTS.USERS.UPDATE_STATUS(id), { status });
  },

  /**
   * Update user permissions
   */
  updatePermissions: async (id: string, permissions: string[]): Promise<User> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockUsers.findIndex(u => u.id === id);
      if (index === -1) {
        throw { message: 'Usuário não encontrado', status: 404 };
      }
      
      mockUsers[index] = {
        ...mockUsers[index],
        permissions,
        updated_at: new Date().toISOString(),
      };
      
      return mockUsers[index];
    }
    
    return apiClient.patch<User>(API_ENDPOINTS.USERS.UPDATE_PERMISSIONS(id), { permissions });
  },
};

export default usersService;
