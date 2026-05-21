/**
 * Authentication Service
 * 
 * Handles all authentication-related API calls.
 * Currently uses mock data, ready to be replaced with real API calls.
 */

import { apiClient, tokenManager } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { LoginRequest, LoginResponse, RefreshTokenResponse } from '@/api/types';
import { apiFeatures } from '@/config/api.config';

// Mock imports for development
import { mockUsers, mockAccounts } from '@/mocks/data/mockData';

// Demo credentials for development
const DEMO_CREDENTIALS: Record<string, string> = {
  'superadmin@sistema.com': 'Admin@123',
  'carlos@clinicavidaplena.com': 'Admin@123',
  'ana@clinicavidaplena.com': 'Agent@123',
  'pedro@clinicavidaplena.com': 'Agent@123',
  'marina@techsolutions.com': 'Admin@123',
  'lucas@techsolutions.com': 'Agent@123',
};

export const authService = {
  /**
   * Login with email and password
   */
  login: async (credentials: LoginRequest): Promise<LoginResponse> => {
    if (apiFeatures.useMocks) {
      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Validate credentials
      const validPassword = DEMO_CREDENTIALS[credentials.email];
      if (!validPassword || validPassword !== credentials.password) {
        throw { message: 'Credenciais inválidas', status: 401 };
      }
      
      // Find user
      const user = mockUsers.find(u => u.email === credentials.email);
      if (!user) {
        throw { message: 'Usuário não encontrado', status: 404 };
      }
      
      // Check user status
      if (user.status !== 'active') {
        throw { message: 'Usuário suspenso ou inativo', status: 403 };
      }
      
      // Check account status (except super_admin)
      if (user.role !== 'super_admin' && user.account_id) {
        const account = mockAccounts.find(a => a.id === user.account_id);
        if (account && account.status === 'paused') {
          throw { message: 'Conta suspensa. Entre em contato com o administrador.', status: 403 };
        }
      }
      
      // Get account
      const account = user.account_id 
        ? mockAccounts.find(a => a.id === user.account_id) || null 
        : null;
      
      // Generate mock tokens
      const token = `mock_token_${user.id}_${Date.now()}`;
      const refreshToken = `mock_refresh_${user.id}_${Date.now()}`;
      
      // Store tokens
      tokenManager.setToken(token);
      tokenManager.setRefreshToken(refreshToken);
      
      return {
        user: {
          id: user.id,
          email: user.email,
          nome: user.nome,
          role: user.role,
          permissions: user.permissions,
        },
        account: account ? {
          id: account.id,
          nome: account.nome,
          status: account.status,
        } : null,
        token,
        refreshToken,
      };
    }
    
    // Real API call
    const response = await apiClient.post<LoginResponse>(
      API_ENDPOINTS.AUTH.LOGIN,
      credentials,
      { skipAuth: true }
    );
    
    tokenManager.setToken(response.token);
    tokenManager.setRefreshToken(response.refreshToken);
    
    return response;
  },

  /**
   * Logout current user
   */
  logout: async (): Promise<void> => {
    if (apiFeatures.useMocks) {
      tokenManager.clearTokens();
      return;
    }
    
    try {
      await apiClient.post(API_ENDPOINTS.AUTH.LOGOUT);
    } finally {
      tokenManager.clearTokens();
    }
  },

  /**
   * Refresh authentication token
   */
  refreshToken: async (): Promise<RefreshTokenResponse> => {
    const refreshToken = tokenManager.getRefreshToken();
    if (!refreshToken) {
      throw { message: 'No refresh token available', status: 401 };
    }
    
    if (apiFeatures.useMocks) {
      const newToken = `mock_token_refreshed_${Date.now()}`;
      const newRefreshToken = `mock_refresh_refreshed_${Date.now()}`;
      
      tokenManager.setToken(newToken);
      tokenManager.setRefreshToken(newRefreshToken);
      
      return { token: newToken, refreshToken: newRefreshToken };
    }
    
    const response = await apiClient.post<RefreshTokenResponse>(
      API_ENDPOINTS.AUTH.REFRESH,
      { refreshToken },
      { skipAuth: true }
    );
    
    tokenManager.setToken(response.token);
    tokenManager.setRefreshToken(response.refreshToken);
    
    return response;
  },

  /**
   * Get current user profile
   */
  getCurrentUser: async () => {
    if (apiFeatures.useMocks) {
      const token = tokenManager.getToken();
      if (!token) {
        throw { message: 'Not authenticated', status: 401 };
      }
      
      // Extract user ID from mock token
      const match = token.match(/mock_token_(.+?)_/);
      if (match) {
        const userId = match[1];
        const user = mockUsers.find(u => u.id === userId);
        if (user) {
          const account = user.account_id 
            ? mockAccounts.find(a => a.id === user.account_id) || null 
            : null;
          return { user, account };
        }
      }
      
      throw { message: 'User not found', status: 404 };
    }
    
    return apiClient.get(API_ENDPOINTS.AUTH.ME);
  },

  /**
   * Impersonate another user (super_admin only)
   */
  impersonate: async (userId: string) => {
    if (apiFeatures.useMocks) {
      const targetUser = mockUsers.find(u => u.id === userId);
      if (!targetUser) {
        throw { message: 'Usuário não encontrado', status: 404 };
      }
      
      const targetAccount = targetUser.account_id 
        ? mockAccounts.find(a => a.id === targetUser.account_id) || null 
        : null;
      
      return { user: targetUser, account: targetAccount };
    }
    
    return apiClient.post(API_ENDPOINTS.AUTH.IMPERSONATE(userId));
  },

  /**
   * Exit impersonation mode
   */
  exitImpersonation: async () => {
    if (apiFeatures.useMocks) {
      // In mock mode, handled by context state
      return;
    }
    
    return apiClient.post(API_ENDPOINTS.AUTH.EXIT_IMPERSONATION);
  },

  /**
   * Check if user is authenticated
   */
  isAuthenticated: (): boolean => {
    return !!tokenManager.getToken();
  },
};

export default authService;
