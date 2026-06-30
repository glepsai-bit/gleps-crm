/**
 * Admin Users Backend Service (T-024)
 *
 * Consome /api/admin/users — rota dedicada ao admin de CONTA gerenciar agentes
 * (e eventualmente outros admins, se o requester for super_admin) da própria
 * tenancy. Não confundir com `users.backend.service.ts` (super_admin global).
 *
 * Backend: backend/src/routes/admin-user.routes.ts -> adminUserController.
 * Auth: JWT + role=admin|super_admin + accountId (forçado server-side).
 * DELETE exige header X-Confirm-Password com a senha do requester.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { UserRole, UserStatus } from '@/types/crm';

// ============================================
// Types
// ============================================

export type AdminUserRole = Extract<UserRole, 'agent' | 'admin'>;

export interface AdminUser {
  id: string;
  accountId: string;
  nome: string;
  email: string;
  role: AdminUserRole;
  status: UserStatus;
  permissions: string[];
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserListFilters {
  role?: AdminUserRole;
  status?: UserStatus;
  search?: string;
  page?: number;
  limit?: number;
}

export interface AdminUserListResult {
  data: AdminUser[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface AdminUserLimits {
  maxAgents: number;
  usedAgents: number;
  remainingAgents: number;
  maxUsers: number;
  usedUsers: number;
  plan: string | null;
}

export interface CreateAdminUserInput {
  nome: string;
  email: string;
  password: string;
  role: AdminUserRole;
  permissions?: string[];
}

export interface UpdateAdminUserInput {
  nome?: string;
  email?: string;
  role?: AdminUserRole;
  status?: UserStatus;
  permissions?: string[];
}

// ============================================
// Mappers (defensivos: backend devolve camelCase mas tolera snake_case)
// ============================================

function mapUser(raw: any): AdminUser {
  return {
    id: raw.id,
    accountId: raw.accountId ?? raw.account_id ?? '',
    nome: raw.nome ?? '',
    email: raw.email ?? '',
    role: (raw.role ?? 'agent') as AdminUserRole,
    status: (raw.status ?? 'active') as UserStatus,
    permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
    lastLoginAt: raw.lastLoginAt ?? raw.last_login_at ?? null,
    createdAt: raw.createdAt ?? raw.created_at ?? '',
    updatedAt: raw.updatedAt ?? raw.updated_at ?? '',
  };
}

// ============================================
// Service
// ============================================

export const adminUsersBackendService = {
  async list(filters: AdminUserListFilters = {}): Promise<AdminUserListResult> {
    const response = await apiClient.get<any>(API_ENDPOINTS.ADMIN_USERS.LIST, {
      params: {
        role: filters.role,
        status: filters.status,
        search: filters.search,
        page: filters.page,
        limit: filters.limit,
      },
    });

    const rawData = Array.isArray(response?.data) ? response.data : [];
    const meta = response?.meta ?? {
      total: rawData.length,
      page: 1,
      limit: rawData.length,
      totalPages: 1,
    };

    return {
      data: rawData.map(mapUser),
      meta: {
        total: meta.total ?? 0,
        page: meta.page ?? 1,
        limit: meta.limit ?? rawData.length,
        totalPages: meta.totalPages ?? 1,
      },
    };
  },

  async getById(id: string): Promise<AdminUser> {
    const response = await apiClient.get<any>(API_ENDPOINTS.ADMIN_USERS.GET(id));
    return mapUser(response?.data ?? response);
  },

  async getLimits(): Promise<AdminUserLimits> {
    const response = await apiClient.get<any>(API_ENDPOINTS.ADMIN_USERS.LIMITS);
    const raw = response?.data ?? response ?? {};
    return {
      maxAgents: Number(raw.maxAgents ?? 0),
      usedAgents: Number(raw.usedAgents ?? 0),
      remainingAgents: Number(raw.remainingAgents ?? 0),
      maxUsers: Number(raw.maxUsers ?? 0),
      usedUsers: Number(raw.usedUsers ?? 0),
      plan: raw.plan ?? null,
    };
  },

  async create(input: CreateAdminUserInput): Promise<AdminUser> {
    const response = await apiClient.post<any>(API_ENDPOINTS.ADMIN_USERS.CREATE, input);
    return mapUser(response?.data ?? response);
  },

  async update(id: string, input: UpdateAdminUserInput): Promise<AdminUser> {
    const response = await apiClient.put<any>(API_ENDPOINTS.ADMIN_USERS.UPDATE(id), input);
    return mapUser(response?.data ?? response);
  },

  /**
   * "Soft delete" UX: simplesmente marca status='inactive'. NÃO chama DELETE
   * porque o backend faz hard-delete (cascade em Sale/Conversation/TeamMember
   * históricas). Mantemos `delete` exposto pra quem realmente quer remover.
   */
  async softDelete(id: string): Promise<AdminUser> {
    return this.update(id, { status: 'inactive' });
  },

  /**
   * Hard delete via DELETE — exige senha do requester (X-Confirm-Password).
   * Cuidado: dados associados (Sale.responsavel, Conversation.assignee, etc.)
   * podem ser perdidos ou setados a NULL conforme onDelete do schema.
   */
  async delete(id: string, confirmPassword: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.ADMIN_USERS.DELETE(id), {
      headers: {
        'X-Confirm-Password': confirmPassword,
      },
    });
  },
};

export default adminUsersBackendService;
