/**
 * CHAT METRICS SERVICE — T-022 Sprint 4 (Chat interno)
 *
 * Substitui parte do `chatwoot-metrics.service.ts` para o chat interno
 * próprio (models Conversation / Message / SLABreach / User / Team / Inbox).
 *
 * Fonte de verdade = banco local (Postgres via Prisma). Multi-tenant: toda
 * query escopada por accountId.
 *
 * Métricas calculadas:
 *   - totalConversations / openConversations / resolvedConversations
 *   - avgFirstResponseMin / avgResolutionMin
 *   - resolvedByAi / resolvedByHuman
 *   - slaBreaches
 *   - breakdowns por agente, por time, por inbox
 *
 * Filtros suportados: fromDate, toDate (obrigatórios), inboxId, teamId, agentId.
 *
 * Singleton: `chatMetricsService`.
 */

import { prisma } from '../config/database';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export interface MetricsFilters {
  fromDate: Date;
  toDate: Date;
  inboxId?: string;
  teamId?: string;
  agentId?: string;
}

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

export interface AgentPeriod {
  fromDate: Date;
  toDate: Date;
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
// Helpers
// ============================================

function diffMinutes(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 60000;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return Math.round((sum / values.length) * 100) / 100;
}

class ChatMetricsService {
  /**
   * Métricas agregadas do chat interno para uma conta no período.
   */
  async getMetrics(
    accountId: string,
    filters: MetricsFilters
  ): Promise<ChatMetricsResult> {
    const { fromDate, toDate, inboxId, teamId, agentId } = filters;

    if (!(fromDate instanceof Date) || !(toDate instanceof Date)) {
      throw new Error('fromDate e toDate devem ser instâncias de Date');
    }
    if (fromDate > toDate) {
      throw new Error('fromDate não pode ser maior que toDate');
    }

    const where = {
      accountId,
      createdAt: { gte: fromDate, lte: toDate },
      ...(inboxId ? { inboxId } : {}),
      ...(teamId ? { teamId } : {}),
      ...(agentId ? { assigneeId: agentId } : {}),
    };

    logger.debug('[chat-metrics] getMetrics', { accountId, filters });

    const conversations = await prisma.conversation.findMany({
      where,
      select: {
        id: true,
        status: true,
        resolvedBy: true,
        resolvedAt: true,
        firstResponseAt: true,
        createdAt: true,
        inboxId: true,
        teamId: true,
        assigneeId: true,
        inbox: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
        assignee: { select: { id: true, nome: true } },
      },
    });

    const totalConversations = conversations.length;
    const openConversations = conversations.filter((c) =>
      ['open', 'pending', 'snoozed'].includes(c.status)
    ).length;
    const resolvedConversations = conversations.filter(
      (c) => c.status === 'resolved'
    ).length;

    const resolvedByAi = conversations.filter(
      (c) => c.status === 'resolved' && c.resolvedBy === 'ai'
    ).length;
    const resolvedByHuman = conversations.filter(
      (c) => c.status === 'resolved' && c.resolvedBy === 'human'
    ).length;

    const frtSamples: number[] = [];
    const resolutionSamples: number[] = [];
    for (const c of conversations) {
      if (c.firstResponseAt) {
        frtSamples.push(diffMinutes(c.firstResponseAt, c.createdAt));
      }
      if (c.resolvedAt) {
        resolutionSamples.push(diffMinutes(c.resolvedAt, c.createdAt));
      }
    }

    const avgFirstResponseMin = average(frtSamples);
    const avgResolutionMin = average(resolutionSamples);

    // SLA breaches no mesmo período (por breachedAt) — também filtrado por
    // accountId via Conversation, e respeitando filtros opcionais.
    const slaBreaches = await prisma.sLABreach.count({
      where: {
        breachedAt: { gte: fromDate, lte: toDate },
        conversation: {
          accountId,
          ...(inboxId ? { inboxId } : {}),
          ...(teamId ? { teamId } : {}),
          ...(agentId ? { assigneeId: agentId } : {}),
        },
      },
    });

    // ============================================
    // Breakdowns
    // ============================================

    const byAgentMap = new Map<string, {
      agentName: string;
      total: number;
      resolved: number;
      open: number;
      frt: number[];
      res: number[];
    }>();
    const byTeamMap = new Map<string, { teamName: string; total: number; resolved: number; open: number }>();
    const byInboxMap = new Map<string, { inboxName: string; total: number; resolved: number; open: number }>();

    for (const c of conversations) {
      const isResolved = c.status === 'resolved';
      const isOpen = ['open', 'pending', 'snoozed'].includes(c.status);

      // Por agente (ignora conversas sem assignee)
      if (c.assigneeId && c.assignee) {
        const cur = byAgentMap.get(c.assigneeId) ?? {
          agentName: c.assignee.nome,
          total: 0,
          resolved: 0,
          open: 0,
          frt: [],
          res: [],
        };
        cur.total += 1;
        if (isResolved) cur.resolved += 1;
        if (isOpen) cur.open += 1;
        if (c.firstResponseAt) cur.frt.push(diffMinutes(c.firstResponseAt, c.createdAt));
        if (c.resolvedAt) cur.res.push(diffMinutes(c.resolvedAt, c.createdAt));
        byAgentMap.set(c.assigneeId, cur);
      }

      // Por time
      if (c.teamId && c.team) {
        const cur = byTeamMap.get(c.teamId) ?? {
          teamName: c.team.name,
          total: 0,
          resolved: 0,
          open: 0,
        };
        cur.total += 1;
        if (isResolved) cur.resolved += 1;
        if (isOpen) cur.open += 1;
        byTeamMap.set(c.teamId, cur);
      }

      // Por inbox
      if (c.inboxId && c.inbox) {
        const cur = byInboxMap.get(c.inboxId) ?? {
          inboxName: c.inbox.name,
          total: 0,
          resolved: 0,
          open: 0,
        };
        cur.total += 1;
        if (isResolved) cur.resolved += 1;
        if (isOpen) cur.open += 1;
        byInboxMap.set(c.inboxId, cur);
      }
    }

    const byAgent: AgentMetricRow[] = Array.from(byAgentMap.entries())
      .map(([agentId, v]) => ({
        agentId,
        agentName: v.agentName,
        total: v.total,
        resolved: v.resolved,
        open: v.open,
        avgFirstResponseMin: average(v.frt),
        avgResolutionMin: average(v.res),
      }))
      .sort((a, b) => b.total - a.total);

    const byTeam: TeamMetricRow[] = Array.from(byTeamMap.entries())
      .map(([teamId, v]) => ({
        teamId,
        teamName: v.teamName,
        total: v.total,
        resolved: v.resolved,
        open: v.open,
      }))
      .sort((a, b) => b.total - a.total);

    const byInbox: InboxMetricRow[] = Array.from(byInboxMap.entries())
      .map(([inboxId, v]) => ({
        inboxId,
        inboxName: v.inboxName,
        total: v.total,
        resolved: v.resolved,
        open: v.open,
      }))
      .sort((a, b) => b.total - a.total);

    return {
      totalConversations,
      openConversations,
      resolvedConversations,
      avgFirstResponseMin,
      avgResolutionMin,
      resolvedByAi,
      resolvedByHuman,
      slaBreaches,
      byAgent,
      byTeam,
      byInbox,
    };
  }

  /**
   * Métricas individuais de um agente no período (assigneeId = userId).
   */
  async getAgentMetrics(
    accountId: string,
    userId: string,
    period: AgentPeriod
  ): Promise<AgentMetricsResult> {
    const { fromDate, toDate } = period;

    if (!(fromDate instanceof Date) || !(toDate instanceof Date)) {
      throw new Error('fromDate e toDate devem ser instâncias de Date');
    }
    if (fromDate > toDate) {
      throw new Error('fromDate não pode ser maior que toDate');
    }

    const conversations = await prisma.conversation.findMany({
      where: {
        accountId,
        assigneeId: userId,
        createdAt: { gte: fromDate, lte: toDate },
      },
      select: {
        status: true,
        resolvedBy: true,
        resolvedAt: true,
        firstResponseAt: true,
        createdAt: true,
      },
    });

    const total = conversations.length;
    const resolved = conversations.filter((c) => c.status === 'resolved').length;
    const open = conversations.filter((c) =>
      ['open', 'pending', 'snoozed'].includes(c.status)
    ).length;

    const resolvedByAi = conversations.filter(
      (c) => c.status === 'resolved' && c.resolvedBy === 'ai'
    ).length;
    const resolvedByHuman = conversations.filter(
      (c) => c.status === 'resolved' && c.resolvedBy === 'human'
    ).length;

    const frt: number[] = [];
    const res: number[] = [];
    for (const c of conversations) {
      if (c.firstResponseAt) frt.push(diffMinutes(c.firstResponseAt, c.createdAt));
      if (c.resolvedAt) res.push(diffMinutes(c.resolvedAt, c.createdAt));
    }

    const slaBreaches = await prisma.sLABreach.count({
      where: {
        breachedAt: { gte: fromDate, lte: toDate },
        conversation: {
          accountId,
          assigneeId: userId,
        },
      },
    });

    return {
      userId,
      total,
      resolved,
      open,
      resolvedByAi,
      resolvedByHuman,
      avgFirstResponseMin: average(frt),
      avgResolutionMin: average(res),
      slaBreaches,
    };
  }
}

export const chatMetricsService = new ChatMetricsService();
