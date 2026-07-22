/**
 * Teams Backend Service (T-022)
 *
 * CRUD de times de atendimento (Prisma `Team`) + membership (`TeamMember`).
 *
 * Backend: backend/src/routes/team.routes.ts -> teamController -> teamService.
 * Auth: JWT + accountId obrigatório.
 *  - CREATE/UPDATE/DELETE: admin only.
 *  - addMember/removeMember: admin OR leader do time (checado no controller).
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

export type TeamMemberRole = 'member' | 'leader';

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  role: TeamMemberRole;
  createdAt: string;
}

export interface Team {
  id: string;
  accountId: string;
  name: string;
  description: string | null;
  allowAutoAssign: boolean;
  sharedVisibility: boolean;
  businessHours: any | null;
  createdAt: string;
  updatedAt: string;
}

export type TeamWithMembers = Team & { members: TeamMember[] };

export interface CreateTeamInput {
  name: string;
  description?: string;
  allowAutoAssign?: boolean;
  sharedVisibility?: boolean;
  businessHours?: any;
}

export interface UpdateTeamInput {
  name?: string;
  description?: string | null;
  allowAutoAssign?: boolean;
  sharedVisibility?: boolean;
  businessHours?: any;
}

export interface AddTeamMemberInput {
  userId: string;
  role?: TeamMemberRole;
}

// ============================================
// Mappers (defensivos: backend devolve camelCase)
// ============================================

function mapTeamMember(raw: any): TeamMember {
  return {
    id: raw.id,
    teamId: raw.teamId ?? raw.team_id,
    userId: raw.userId ?? raw.user_id,
    role: (raw.role ?? 'member') as TeamMemberRole,
    createdAt: raw.createdAt ?? raw.created_at,
  };
}

function mapTeam(raw: any): Team {
  return {
    id: raw.id,
    accountId: raw.accountId ?? raw.account_id,
    name: raw.name,
    description: raw.description ?? null,
    allowAutoAssign: raw.allowAutoAssign ?? raw.allow_auto_assign ?? false,
    sharedVisibility: raw.sharedVisibility ?? raw.shared_visibility ?? true,
    businessHours: raw.businessHours ?? raw.business_hours ?? null,
    createdAt: raw.createdAt ?? raw.created_at,
    updatedAt: raw.updatedAt ?? raw.updated_at,
  };
}

function mapTeamWithMembers(raw: any): TeamWithMembers {
  const team = mapTeam(raw);
  const members = Array.isArray(raw?.members) ? raw.members.map(mapTeamMember) : [];
  return { ...team, members };
}

function unwrap<T = any>(response: any): T {
  // Controllers retornam { data: ... }. Mantém compat com formatos legados.
  return (response?.data ?? response) as T;
}

// ============================================
// Service
// ============================================

export const teamsBackendService = {
  async listTeams(): Promise<TeamWithMembers[]> {
    const response = await apiClient.get<any>(API_ENDPOINTS.TEAMS.LIST);
    const raw = unwrap<any[]>(response);
    return (Array.isArray(raw) ? raw : []).map(mapTeamWithMembers);
  },

  async getTeam(id: string): Promise<TeamWithMembers> {
    const response = await apiClient.get<any>(API_ENDPOINTS.TEAMS.GET(id));
    return mapTeamWithMembers(unwrap(response));
  },

  async createTeam(body: CreateTeamInput): Promise<Team> {
    const response = await apiClient.post<any>(API_ENDPOINTS.TEAMS.CREATE, body);
    return mapTeam(unwrap(response));
  },

  async updateTeam(id: string, body: UpdateTeamInput): Promise<Team> {
    // Backend usa PATCH em /teams/:id (ver team.routes.ts).
    const response = await apiClient.patch<any>(API_ENDPOINTS.TEAMS.UPDATE(id), body);
    return mapTeam(unwrap(response));
  },

  async deleteTeam(id: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.TEAMS.DELETE(id));
  },

  // ----- Membership -----

  async addTeamMember(teamId: string, body: AddTeamMemberInput): Promise<TeamMember> {
    const response = await apiClient.post<any>(API_ENDPOINTS.TEAMS.MEMBERS(teamId), body);
    return mapTeamMember(unwrap(response));
  },

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.TEAMS.REMOVE_MEMBER(teamId, userId));
  },

  // ----- Times do usuário logado -----

  async listMyTeams(): Promise<Team[]> {
    const response = await apiClient.get<any>(API_ENDPOINTS.TEAMS.BY_USER_ME);
    const raw = unwrap<any[]>(response);
    return (Array.isArray(raw) ? raw : []).map(mapTeam);
  },
};

export default teamsBackendService;
