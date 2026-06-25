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
  /** SLA breaches no período atribuídos a este agente */
  slaBreaches: number;
}

export interface TeamMetricRow {
  teamId: string;
  teamName: string;
  total: number;
  resolved: number;
  open: number;
  slaBreaches: number;
}

export interface InboxMetricRow {
  inboxId: string;
  inboxName: string;
  total: number;
  resolved: number;
  open: number;
  slaBreaches: number;
}

/**
 * Bucket diário do volume de conversas no período.
 * Datas em ISO yyyy-mm-dd (UTC) — FE formata para exibição.
 */
export interface DailyVolumeBucket {
  date: string; // yyyy-mm-dd
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
  /** Série temporal por dia (preenchida com zeros nos dias sem dados) */
  dailyVolume: DailyVolumeBucket[];
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

/**
 * Retorna a representação UTC yyyy-mm-dd para usar como chave de bucket diário.
 * Usar UTC garante chave estável independente do timezone do servidor (Docker
 * pode estar em UTC enquanto o navegador está em America/Sao_Paulo). O FE
 * formata para o fuso do usuário se precisar.
 */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Gera lista de chaves yyyy-mm-dd entre `from` e `to` (inclusive), em UTC.
 * Garante que dias sem dados apareçam como 0 no gráfico ao invés de sumir.
 */
function eachUtcDayKey(from: Date, to: Date): string[] {
  const keys: string[] = [];
  const start = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate()
  ));
  const end = new Date(Date.UTC(
    to.getUTCFullYear(),
    to.getUTCMonth(),
    to.getUTCDate()
  ));
  const cursor = new Date(start);
  // hard-stop pra evitar loop infinito em entradas malucas (>10 anos)
  const MAX_DAYS = 366 * 10;
  let safety = 0;
  while (cursor.getTime() <= end.getTime() && safety < MAX_DAYS) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    safety += 1;
  }
  return keys;
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

    // FIX (review): inclui conversas resolvidas no período mesmo que tenham
    // sido criadas antes. Ex: ticket criado há 60d e resolvido hoje precisa
    // aparecer no dashboard "últimos 30d" para a taxa de resolução não vir
    // artificialmente baixa.
    const where = {
      accountId,
      OR: [
        { createdAt: { gte: fromDate, lte: toDate } },
        { resolvedAt: { gte: fromDate, lte: toDate } },
      ],
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
    // Trazemos também conversationId pra atribuir o breach ao agente/time/inbox
    // correto (review medium-finding).
    const slaBreachRows = await prisma.sLABreach.findMany({
      where: {
        breachedAt: { gte: fromDate, lte: toDate },
        conversation: {
          accountId,
          ...(inboxId ? { inboxId } : {}),
          ...(teamId ? { teamId } : {}),
          ...(agentId ? { assigneeId: agentId } : {}),
        },
      },
      select: {
        conversationId: true,
        conversation: {
          select: {
            assigneeId: true,
            teamId: true,
            inboxId: true,
          },
        },
      },
    });
    const slaBreaches = slaBreachRows.length;

    // Mapas auxiliares pra somar breaches por agente/time/inbox.
    // Uma conversa pode ter múltiplos breaches (first_response + resolution)
    // — contamos cada um individualmente, é o que o KPI total já reflete.
    const slaByAgent = new Map<string, number>();
    const slaByTeam = new Map<string, number>();
    const slaByInbox = new Map<string, number>();
    for (const row of slaBreachRows) {
      const conv = row.conversation;
      if (!conv) continue;
      if (conv.assigneeId) {
        slaByAgent.set(conv.assigneeId, (slaByAgent.get(conv.assigneeId) ?? 0) + 1);
      }
      const teamKey = conv.teamId ?? '__none__';
      slaByTeam.set(teamKey, (slaByTeam.get(teamKey) ?? 0) + 1);
      const inboxKey = conv.inboxId ?? '__none__';
      slaByInbox.set(inboxKey, (slaByInbox.get(inboxKey) ?? 0) + 1);
    }

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

      // Por time — inclui bucket 'Sem time atribuído' quando teamId é null
      // (FIX BUG-4: gráfico donut ficava vazio quando todas as conversas
      // estavam sem time atribuído).
      {
        const teamKey = c.teamId ?? '__none__';
        const teamName = c.team?.name ?? 'Sem time atribuído';
        const cur = byTeamMap.get(teamKey) ?? {
          teamName,
          total: 0,
          resolved: 0,
          open: 0,
        };
        cur.total += 1;
        if (isResolved) cur.resolved += 1;
        if (isOpen) cur.open += 1;
        byTeamMap.set(teamKey, cur);
      }

      // Por inbox — inclui bucket 'Canal desconhecido' quando inboxId é null
      // (FIX BUG-4: conversas Evolution legadas sem inboxId não apareciam).
      {
        const inboxKey = c.inboxId ?? '__none__';
        const inboxName = c.inbox?.name ?? 'Canal desconhecido';
        const cur = byInboxMap.get(inboxKey) ?? {
          inboxName,
          total: 0,
          resolved: 0,
          open: 0,
        };
        cur.total += 1;
        if (isResolved) cur.resolved += 1;
        if (isOpen) cur.open += 1;
        byInboxMap.set(inboxKey, cur);
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
        slaBreaches: slaByAgent.get(agentId) ?? 0,
      }))
      .sort((a, b) => b.total - a.total);

    const byTeam: TeamMetricRow[] = Array.from(byTeamMap.entries())
      .map(([teamId, v]) => ({
        // Mantém string vazia ao invés do sentinel interno '__none__' para
        // não vazar implementação ao FE — bucket "Sem time" ainda diferenciável
        // pelo teamName.
        teamId: teamId === '__none__' ? '' : teamId,
        teamName: v.teamName,
        total: v.total,
        resolved: v.resolved,
        open: v.open,
        slaBreaches: slaByTeam.get(teamId) ?? 0,
      }))
      .sort((a, b) => b.total - a.total);

    const byInbox: InboxMetricRow[] = Array.from(byInboxMap.entries())
      .map(([inboxId, v]) => ({
        inboxId: inboxId === '__none__' ? '' : inboxId,
        inboxName: v.inboxName,
        total: v.total,
        resolved: v.resolved,
        open: v.open,
        slaBreaches: slaByInbox.get(inboxId) ?? 0,
      }))
      .sort((a, b) => b.total - a.total);

    // ============================================
    // Série diária (FIX BUG-3: substitui placeholder do FE que dividia o
    // total pelo nº de dias e gerava a linha laranja "flat 0.45")
    // ============================================
    const dayKeys = eachUtcDayKey(fromDate, toDate);
    const dailyMap = new Map<string, { total: number; resolved: number; open: number }>();
    for (const key of dayKeys) {
      dailyMap.set(key, { total: 0, resolved: 0, open: 0 });
    }
    for (const c of conversations) {
      // Usa createdAt pra bucket de "novas conversas" — alinhado ao gráfico
      // existente. Conversas resolvidas no período mas criadas fora caem no
      // bucket da data de criação se estiver dentro; caso contrário, criamos
      // o bucket pela data de resolução pra elas aparecerem como "resolvidas".
      const createdKey = utcDayKey(c.createdAt);
      if (dailyMap.has(createdKey)) {
        const bucket = dailyMap.get(createdKey)!;
        bucket.total += 1;
        if (c.status === 'resolved') bucket.resolved += 1;
        if (['open', 'pending', 'snoozed'].includes(c.status)) bucket.open += 1;
      } else if (c.resolvedAt) {
        const resolvedKey = utcDayKey(c.resolvedAt);
        if (dailyMap.has(resolvedKey)) {
          const bucket = dailyMap.get(resolvedKey)!;
          // Não conta como total (foi criada fora do período) — apenas
          // contribui pra contagem de resolvidas naquele dia.
          if (c.status === 'resolved') bucket.resolved += 1;
        }
      }
    }
    const dailyVolume: DailyVolumeBucket[] = dayKeys.map((date) => {
      const v = dailyMap.get(date)!;
      return { date, total: v.total, resolved: v.resolved, open: v.open };
    });

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
      dailyVolume,
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
        OR: [
          { createdAt: { gte: fromDate, lte: toDate } },
          { resolvedAt: { gte: fromDate, lte: toDate } },
        ],
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
