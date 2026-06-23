/**
 * Chat Metrics Backend Service (T-022 — chat interno)
 *
 * Métricas agregadas do chat interno (model Conversation / Message / SLABreach).
 * Fonte de verdade = banco local (Postgres via Prisma). Multi-tenant: escopo
 * automático por accountId do usuário autenticado (super_admin precisa estar
 * impersonando).
 *
 * Backend:
 *   - backend/src/controllers/chat-metrics.controller.ts
 *   - backend/src/services/chat-metrics.service.ts
 *
 * Endpoints:
 *   GET /api/chat/metrics?fromDate&toDate&inboxId?&teamId?&agentId?
 *   GET /api/chat/metrics/agent/:userId?fromDate&toDate
 *
 * Janela padrão (se omitir fromDate/toDate): últimos 30 dias.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

// ============================================
// Tipos espelhando o service do backend
// ============================================

export interface AgentMetricRow {
  agentId: string;
  agentName: string;
  total: number;
  resolved: number;
  open: number;
  avgFirstResponseMin: number | null;
  avgResolutionMin: number | null;
}

export interface TeamMetricRow {
  teamId: string;
  teamName: string;
  total: number;
  resolved: number;
  open: number;
}

export interface InboxMetricRow {
  inboxId: string;
  inboxName: string;
  total: number;
  resolved: number;
  open: number;
}

export interface ChatMetricsResult {
  totalConversations: number;
  openConversations: number;
  resolvedConversations: number;
  avgFirstResponseMin: number | null;
  avgResolutionMin: number | null;
  resolvedByAi: number;
  resolvedByHuman: number;
  slaBreaches: number;
  byAgent: AgentMetricRow[];
  byTeam: TeamMetricRow[];
  byInbox: InboxMetricRow[];
}

export interface AgentMetricsResult {
  userId: string;
  total: number;
  resolved: number;
  open: number;
  resolvedByAi: number;
  resolvedByHuman: number;
  avgFirstResponseMin: number | null;
  avgResolutionMin: number | null;
  slaBreaches: number;
}

// ============================================
// Filtros
// ============================================

export interface ChatMetricsFilters {
  /** ISO 8601 com offset. Default = 30 dias atrás. */
  fromDate?: string | Date;
  /** ISO 8601 com offset. Default = agora. */
  toDate?: string | Date;
  inboxId?: string;
  teamId?: string;
  agentId?: string;
}

export interface AgentMetricsPeriod {
  fromDate?: string | Date;
  toDate?: string | Date;
}

// ============================================
// Helpers
// ============================================

function unwrap<T>(resp: any): T {
  return (resp?.data ?? resp) as T;
}

function toIso(value: string | Date | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function buildParams(
  filters: ChatMetricsFilters
): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  const from = toIso(filters.fromDate);
  const to = toIso(filters.toDate);
  if (from) params.fromDate = from;
  if (to) params.toDate = to;
  if (filters.inboxId) params.inboxId = filters.inboxId;
  if (filters.teamId) params.teamId = filters.teamId;
  if (filters.agentId) params.agentId = filters.agentId;
  return Object.keys(params).length > 0 ? params : undefined;
}

// ============================================
// Service
// ============================================

export const chatMetricsBackendService = {
  /**
   * Métricas agregadas no período + breakdowns por agente/time/inbox.
   * Backend valida que fromDate <= toDate.
   */
  async getChatMetrics(filters: ChatMetricsFilters = {}): Promise<ChatMetricsResult> {
    const resp = await apiClient.get<any>(API_ENDPOINTS.CHAT_METRICS.METRICS, {
      params: buildParams(filters),
    });
    return unwrap<ChatMetricsResult>(resp);
  },

  /**
   * Métricas individuais de um agente da conta autenticada.
   * Backend valida UUID do userId.
   */
  async getAgentMetrics(
    userId: string,
    period: AgentMetricsPeriod = {}
  ): Promise<AgentMetricsResult> {
    if (!userId) throw new Error('userId é obrigatório');
    const resp = await apiClient.get<any>(
      API_ENDPOINTS.CHAT_METRICS.AGENT_METRICS(userId),
      {
        params: buildParams({
          fromDate: period.fromDate,
          toDate: period.toDate,
        }),
      }
    );
    return unwrap<AgentMetricsResult>(resp);
  },
};

export default chatMetricsBackendService;
