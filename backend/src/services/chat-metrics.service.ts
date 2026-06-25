/**
 * CHAT METRICS SERVICE — T-022 Sprint 4 (Chat interno)
 *
 * Métricas do chat interno próprio (models Conversation / Message /
 * SLABreach / User / Team / Inbox). Não usa fontes externas.
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
// T-022 — Retornos (returning leads) e atendimento ao vivo
// ============================================

export interface ReturningLeadsFilters {
  fromDate?: Date;
  toDate?: Date;
  inboxId?: string;
  teamId?: string;
  agentId?: string;
}

export interface ReturningLeadsResult {
  count: number;
  /** contactIds (Contact.id) dos leads que retornaram no período */
  leadIds: string[];
}

export interface LiveAttendanceBucket {
  count: number;
  conversationIds: string[];
}

export interface LiveAttendanceResult {
  ia: LiveAttendanceBucket;
  humano: LiveAttendanceBucket;
  emAberto: LiveAttendanceBucket;
  total: number;
}

export interface ReturningLeadListItem {
  contactId: string;
  contactName: string | null;
  contactPhone: string | null;
  cyclesCount: number;
  lastReopenAt: Date;
  lastConversationId: string;
  inboxId: string | null;
  inboxName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
}

export interface ReturningLeadsListResult {
  data: ReturningLeadListItem[];
  total: number;
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

    // ============================================
    // KPIs por CICLO (Bug B): agrega ConversationCycle dentro da janela.
    // Reabertura cria novo ciclo → ciclo anterior continua contando aqui,
    // diferente do método antigo que olhava só Conversation.resolvedAt atual.
    //
    // Filtros (inboxId/teamId/agentId) viajam pelo Conversation parent —
    // reflete o estado atual da conversa. (Para snapshot histórico,
    // ler cycle.snapshot.)
    // ============================================
    const cycles = await prisma.conversationCycle.findMany({
      where: {
        accountId,
        OR: [
          { openedAt: { gte: fromDate, lte: toDate } },
          { resolvedAt: { gte: fromDate, lte: toDate } },
        ],
        ...(inboxId || teamId || agentId
          ? {
              conversation: {
                ...(inboxId ? { inboxId } : {}),
                ...(teamId ? { teamId } : {}),
                ...(agentId ? { assigneeId: agentId } : {}),
              },
            }
          : {}),
      },
      select: {
        openedAt: true,
        resolvedAt: true,
        resolvedBy: true,
        firstResponseAt: true,
      },
    });

    const resolvedByAi = cycles.filter(
      (cy) => cy.resolvedAt && cy.resolvedBy === 'ai'
    ).length;
    const resolvedByHuman = cycles.filter(
      (cy) => cy.resolvedAt && cy.resolvedBy === 'human'
    ).length;

    const frtSamples: number[] = [];
    const resolutionSamples: number[] = [];
    for (const cy of cycles) {
      if (cy.firstResponseAt) {
        frtSamples.push(diffMinutes(cy.firstResponseAt, cy.openedAt));
      }
      if (cy.resolvedAt) {
        resolutionSamples.push(diffMinutes(cy.resolvedAt, cy.openedAt));
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

    // Bug B: AI vs Humano por ciclo. Conta TODOS os ciclos resolvidos
    // pelo agente (resolvedByUserId), mesmo de conversas reabertas
    // depois — não só o resolveBy atual da conversa.
    const agentCycles = await prisma.conversationCycle.findMany({
      where: {
        accountId,
        OR: [
          { openedAt: { gte: fromDate, lte: toDate } },
          { resolvedAt: { gte: fromDate, lte: toDate } },
        ],
        conversation: { assigneeId: userId },
      },
      select: {
        openedAt: true,
        resolvedAt: true,
        resolvedBy: true,
        firstResponseAt: true,
      },
    });

    const resolvedByAi = agentCycles.filter(
      (cy) => cy.resolvedAt && cy.resolvedBy === 'ai'
    ).length;
    const resolvedByHuman = agentCycles.filter(
      (cy) => cy.resolvedAt && cy.resolvedBy === 'human'
    ).length;

    const frt: number[] = [];
    const res: number[] = [];
    for (const cy of agentCycles) {
      if (cy.firstResponseAt) frt.push(diffMinutes(cy.firstResponseAt, cy.openedAt));
      if (cy.resolvedAt) res.push(diffMinutes(cy.resolvedAt, cy.openedAt));
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

  // ==========================================================================
  // T-022 — Leads que RETORNARAM (>=2 ciclos)
  // ==========================================================================

  /**
   * Conta leads (contacts) que tiveram >=2 ciclos em ConversationCycle no período.
   *
   * Regra: um lead "retornou" quando a mesma conversa foi resolvida e depois
   * reaberta (ou quando o contato gerou mais de uma conversa resolvida). O sinal
   * é "este Contact tem >=2 ConversationCycle". Filtramos por openedAt do ciclo
   * dentro da janela e excluímos contatos cujo único ciclo é o primeiro contato
   * (>=2 ciclos garante que houve reabertura/retorno).
   *
   * Schema atual não tem `opened_reason` em ConversationCycle — então usamos o
   * critério estrutural ">=2 ciclos para o mesmo contato" como proxy de retorno.
   * Filtros inboxId/teamId/agentId viajam pela Conversation parent (estado atual,
   * compatível com getMetrics).
   *
   * @returns count + array dos contactIds que retornaram
   */
  async getReturningLeadsCount(
    accountId: string,
    filters: ReturningLeadsFilters = {}
  ): Promise<ReturningLeadsResult> {
    const { fromDate, toDate, inboxId, teamId, agentId } = filters;
    if (fromDate && toDate && fromDate > toDate) {
      throw new Error('fromDate não pode ser maior que toDate');
    }

    logger.debug('[chat-metrics] getReturningLeadsCount', { accountId, filters });

    // Busca ciclos no período, restrito aos filtros — depois agrupa em memória
    // por contactId. Trazemos só o que precisa pra contar (não há JOIN pesado).
    const cycles = await prisma.conversationCycle.findMany({
      where: {
        accountId,
        ...(fromDate || toDate
          ? {
              openedAt: {
                ...(fromDate ? { gte: fromDate } : {}),
                ...(toDate ? { lte: toDate } : {}),
              },
            }
          : {}),
        conversation: {
          accountId,
          contactId: { not: null },
          ...(inboxId ? { inboxId } : {}),
          ...(teamId ? { teamId } : {}),
          ...(agentId ? { assigneeId: agentId } : {}),
        },
      },
      select: {
        conversation: { select: { contactId: true } },
      },
    });

    // Conta ciclos por contato dentro do período.
    const cyclesPerContact = new Map<string, number>();
    for (const cy of cycles) {
      const cid = cy.conversation?.contactId;
      if (!cid) continue;
      cyclesPerContact.set(cid, (cyclesPerContact.get(cid) ?? 0) + 1);
    }

    // Considera "retornou" quem tem >=2 ciclos NO PERÍODO, OU tem ciclo no
    // período mas já tinha ciclo resolvido antes (não é primeiro contato).
    const candidatesNoPeriod = Array.from(cyclesPerContact.entries())
      .filter(([, n]) => n >= 2)
      .map(([cid]) => cid);

    // Para os que têm só 1 ciclo no período, verifica se existe ciclo anterior
    // resolvido fora da janela (sinal de retorno após hiato).
    const singletons = Array.from(cyclesPerContact.entries())
      .filter(([, n]) => n === 1)
      .map(([cid]) => cid);

    let withPriorResolved: string[] = [];
    if (singletons.length > 0 && fromDate) {
      const priorCycles = await prisma.conversationCycle.findMany({
        where: {
          accountId,
          resolvedAt: { not: null, lt: fromDate },
          conversation: {
            accountId,
            contactId: { in: singletons },
          },
        },
        select: {
          conversation: { select: { contactId: true } },
        },
        distinct: ['conversationId'],
      });
      const set = new Set<string>();
      for (const c of priorCycles) {
        if (c.conversation?.contactId) set.add(c.conversation.contactId);
      }
      withPriorResolved = Array.from(set);
    }

    const leadIds = Array.from(new Set([...candidatesNoPeriod, ...withPriorResolved]));
    return { count: leadIds.length, leadIds };
  }

  // ==========================================================================
  // T-022 — Atendimento ao vivo (IA / Humano / Em aberto)
  // ==========================================================================

  /**
   * Snapshot do que está ATIVO agora: status='open' classificado em três baldes
   * mutuamente exclusivos.
   *
   * Heurística (ordem de precedência):
   *   1. Humano  — assigneeId IS NOT NULL OR customAttributes.human_active=true
   *   2. IA      — customAttributes.handler_active=true OR última Message do
   *                bot (senderType='ai_bot') E não está marcado como humano
   *   3. EmAberto — restante: sem assignee, sem flag de humano, sem sinal de IA
   *
   * Heurística da última Message: como o senderType da última mensagem é o sinal
   * mais robusto de quem está conduzindo, fazemos uma subquery do lado do Postgres
   * com DISTINCT ON pra evitar N+1.
   */
  async getLiveAttendance(accountId: string): Promise<LiveAttendanceResult> {
    logger.debug('[chat-metrics] getLiveAttendance', { accountId });

    const conversations = await prisma.conversation.findMany({
      where: { accountId, status: 'open' },
      select: {
        id: true,
        assigneeId: true,
        customAttributes: true,
      },
    });

    if (conversations.length === 0) {
      return {
        ia: { count: 0, conversationIds: [] },
        humano: { count: 0, conversationIds: [] },
        emAberto: { count: 0, conversationIds: [] },
        total: 0,
      };
    }

    const ids = conversations.map((c) => c.id);

    // Última Message NÃO-privada por conversa (system_note/private notas internas
    // não devem influenciar quem está "conduzindo" o atendimento).
    const lastSenders = await prisma.$queryRaw<
      Array<{ conversation_id: string; sender_type: string }>
    >`
      SELECT DISTINCT ON (conversation_id) conversation_id, sender_type
      FROM messages
      WHERE conversation_id = ANY(${ids}::uuid[])
        AND is_private = false
      ORDER BY conversation_id, created_at DESC
    `;
    const lastSenderByConv = new Map<string, string>();
    for (const r of lastSenders) {
      lastSenderByConv.set(r.conversation_id, r.sender_type);
    }

    const ia: string[] = [];
    const humano: string[] = [];
    const emAberto: string[] = [];

    for (const c of conversations) {
      const attrs =
        (c.customAttributes as Record<string, unknown> | null) ?? {};
      const humanActive = attrs.human_active === true;
      const handlerActive = attrs.handler_active === true;
      const lastSender = lastSenderByConv.get(c.id);

      // 1. Humano: assignee humano OU flag explícita.
      if (c.assigneeId || humanActive) {
        humano.push(c.id);
        continue;
      }

      // 2. IA: flag de handler ativo OU última mensagem foi do bot e humano
      // não tomou controle.
      if (handlerActive || (lastSender === 'ai_bot' && !humanActive)) {
        ia.push(c.id);
        continue;
      }

      // 3. Em aberto: sem assignee, sem flag de humano e sem sinal de IA.
      emAberto.push(c.id);
    }

    return {
      ia: { count: ia.length, conversationIds: ia },
      humano: { count: humano.length, conversationIds: humano },
      emAberto: { count: emAberto.length, conversationIds: emAberto },
      total: conversations.length,
    };
  }

  // ==========================================================================
  // T-022 — Drill-down: lista paginada de leads que retornaram
  // ==========================================================================

  /**
   * Lista paginada dos leads que retornaram no período — usada pelo modal de
   * drill-down do card "Retornos" no dashboard. Reaproveita a regra de
   * `getReturningLeadsCount` e enriquece com nome/telefone do contato + última
   * conversa (inbox/agente atual).
   */
  async getReturningLeadsList(
    accountId: string,
    filters: ReturningLeadsFilters = {},
    page = 1,
    perPage = 20
  ): Promise<ReturningLeadsListResult> {
    const safePage = Math.max(1, Math.floor(page));
    const safePerPage = Math.min(100, Math.max(1, Math.floor(perPage)));

    const { leadIds } = await this.getReturningLeadsCount(accountId, filters);
    if (leadIds.length === 0) {
      return { data: [], total: 0 };
    }

    // Conta ciclos por contato no período (pra exibir "X retornos" no item).
    const cycleCountRows = await prisma.conversationCycle.groupBy({
      by: ['conversationId'],
      where: {
        accountId,
        ...(filters.fromDate || filters.toDate
          ? {
              openedAt: {
                ...(filters.fromDate ? { gte: filters.fromDate } : {}),
                ...(filters.toDate ? { lte: filters.toDate } : {}),
              },
            }
          : {}),
        conversation: { contactId: { in: leadIds } },
      },
      _count: { _all: true },
      _max: { openedAt: true },
    });

    // Mapeia conversationId -> contactId pra agregar por contato.
    const convs = await prisma.conversation.findMany({
      where: { accountId, contactId: { in: leadIds } },
      select: {
        id: true,
        contactId: true,
        inboxId: true,
        assigneeId: true,
        inbox: { select: { id: true, name: true } },
        assignee: { select: { id: true, nome: true } },
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    const lastConvByContact = new Map<string, typeof convs[number]>();
    for (const c of convs) {
      if (!c.contactId) continue;
      if (!lastConvByContact.has(c.contactId)) {
        lastConvByContact.set(c.contactId, c);
      }
    }

    // Agrega ciclos por contato (somando todos os ciclos das conversas do
    // contato) e pega a data do ciclo mais recente como "lastReopenAt".
    const contactByConv = new Map<string, string>();
    for (const c of convs) {
      if (c.contactId) contactByConv.set(c.id, c.contactId);
    }
    const cyclesByContact = new Map<
      string,
      { count: number; lastReopenAt: Date }
    >();
    for (const row of cycleCountRows) {
      const cid = contactByConv.get(row.conversationId);
      if (!cid) continue;
      const cur = cyclesByContact.get(cid) ?? {
        count: 0,
        lastReopenAt: new Date(0),
      };
      cur.count += row._count._all;
      if (row._max.openedAt && row._max.openedAt > cur.lastReopenAt) {
        cur.lastReopenAt = row._max.openedAt;
      }
      cyclesByContact.set(cid, cur);
    }

    // Busca dados dos contatos.
    const contacts = await prisma.contact.findMany({
      where: { accountId, id: { in: leadIds } },
      select: { id: true, nome: true, telefone: true },
    });
    const contactById = new Map(contacts.map((c) => [c.id, c]));

    const allItems: ReturningLeadListItem[] = leadIds
      .map((cid) => {
        const contact = contactById.get(cid);
        const lastConv = lastConvByContact.get(cid);
        const agg = cyclesByContact.get(cid) ?? {
          count: 0,
          lastReopenAt: new Date(0),
        };
        if (!contact || !lastConv) return null;
        return {
          contactId: cid,
          contactName: contact.nome ?? null,
          contactPhone: contact.telefone ?? null,
          cyclesCount: agg.count,
          lastReopenAt: agg.lastReopenAt,
          lastConversationId: lastConv.id,
          inboxId: lastConv.inboxId ?? null,
          inboxName: lastConv.inbox?.name ?? null,
          assigneeId: lastConv.assigneeId ?? null,
          assigneeName: lastConv.assignee?.nome ?? null,
        } as ReturningLeadListItem;
      })
      .filter((x): x is ReturningLeadListItem => x !== null)
      .sort((a, b) => b.lastReopenAt.getTime() - a.lastReopenAt.getTime());

    const total = allItems.length;
    const start = (safePage - 1) * safePerPage;
    const data = allItems.slice(start, start + safePerPage);

    return { data, total };
  }
}

export const chatMetricsService = new ChatMetricsService();
