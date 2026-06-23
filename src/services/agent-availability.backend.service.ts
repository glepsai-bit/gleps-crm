/**
 * Agent Availability Backend Service — T-022 Sprint 4 (chat interno)
 *
 * Cliente do módulo de presença/disponibilidade de agentes.
 * Os endpoints rodam no namespace `/api/availability` (Express) e o middleware
 * `authenticate` exige o JWT padrão (apiClient já injeta).
 *
 * Status possíveis: 'online' | 'away' | 'busy' | 'offline'.
 *
 * Mapeamento (camelCase do backend → snake_case usado pela UI), seguindo o
 * padrão dos outros *.backend.service.ts (ex.: users.backend.service.ts).
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

// ============================================
// Types
// ============================================

export type AvailabilityStatus = 'online' | 'away' | 'busy' | 'offline';

/** Linha de `agent_availability` (PK = userId) na forma usada pela UI. */
export interface AgentAvailability {
  user_id: string;
  status: AvailabilityStatus;
  last_active_at: string;
  created_at: string;
  updated_at: string;
}

/** Usuário online retornado por GET /availability/online (campos públicos). */
export interface OnlineAgent {
  id: string;
  nome: string;
  email: string;
  role: string;
  avatar_url: string | null;
}

// ============================================
// Mappers
// ============================================

function mapAvailability(raw: any): AgentAvailability {
  return {
    user_id: raw.userId ?? raw.user_id,
    status: (raw.status ?? 'offline') as AvailabilityStatus,
    last_active_at:
      raw.lastActiveAt ?? raw.last_active_at ?? new Date().toISOString(),
    created_at: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    updated_at: raw.updatedAt ?? raw.updated_at ?? new Date().toISOString(),
  };
}

function mapOnlineAgent(raw: any): OnlineAgent {
  return {
    id: raw.id,
    nome: raw.nome,
    email: raw.email,
    role: raw.role,
    avatar_url: raw.avatarUrl ?? raw.avatar_url ?? null,
  };
}

function unwrap<T = any>(response: any): T {
  // Backend padroniza `{ data: ... }`; aceitar também resposta crua.
  return (response?.data ?? response) as T;
}

// ============================================
// Service
// ============================================

export const agentAvailabilityBackendService = {
  /**
   * GET /availability/me — status do usuário autenticado.
   * Se ainda não existir registro, o backend cria com 'offline'.
   */
  async getMyAvailability(): Promise<AgentAvailability> {
    const response = await apiClient.get<any>(API_ENDPOINTS.AVAILABILITY.ME);
    return mapAvailability(unwrap(response));
  },

  /**
   * POST /availability/me — define manualmente o status do usuário autenticado.
   */
  async setMyStatus(status: AvailabilityStatus): Promise<AgentAvailability> {
    const response = await apiClient.post<any>(API_ENDPOINTS.AVAILABILITY.ME, {
      status,
    });
    return mapAvailability(unwrap(response));
  },

  /**
   * POST /availability/heartbeat — keep-alive (atualiza `lastActiveAt`).
   * Promove 'offline' → 'online' automaticamente; preserva 'away'/'busy'.
   */
  async heartbeat(): Promise<void> {
    await apiClient.post<any>(API_ENDPOINTS.AVAILABILITY.HEARTBEAT);
  },

  /**
   * GET /availability/online — lista os agentes atualmente online da conta.
   * Super admin sem conta corrente recebe 403 do backend.
   */
  async listOnlineAgents(): Promise<OnlineAgent[]> {
    const response = await apiClient.get<any>(API_ENDPOINTS.AVAILABILITY.ONLINE);
    const items = unwrap<any>(response);
    return (Array.isArray(items) ? items : []).map(mapOnlineAgent);
  },
};

export default agentAvailabilityBackendService;
