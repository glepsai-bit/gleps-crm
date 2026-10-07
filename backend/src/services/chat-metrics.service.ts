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
 *   - Dashboard 06/10 (aditivo): anterior (mesmos KPIs no período anterior),
 *     reunioes, transferidasParaHumano, origem e os campos novos de fechamento.
 *     Regras em docs/METRICAS_DASHBOARD.md › "Dashboard — métricas novas (06/10)".
 *
 * Filtros suportados: fromDate, toDate (obrigatórios), inboxId, teamId, agentId.
 *
 * Singleton: `chatMetricsService`.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { ValidationError, NotFoundError } from '../utils/errors';

/**
 * Range máximo permitido para consultas de métricas (em dias).
 * Acima disso o payload explode (>3000 buckets diários inflam recharts/JSON)
 * e nenhum dashboard útil precisa de janela maior que 1 ano.
 * Aplicado em getMetrics e nas variantes que aceitam fromDate/toDate.
 */
const MAX_RANGE_DAYS = 365;
const MS_PER_DAY = 86400000;

// ============================================
// Types
// ============================================

export interface MetricsFilters {
  fromDate: Date;
  toDate: Date;
  inboxId?: string;
  teamId?: string;
  agentId?: string;
  /**
   * IANA timezone (ex: "America/Sao_Paulo") usado para bucketizar `dailyVolume`
   * por dia LOCAL ao invés de UTC. Sem isso, uma conversa criada às 22h de SP
   * (01:00Z do dia seguinte) cai no bucket do dia errado para o operador BR.
   *
   * Quando omitido, mantém comportamento legado (UTC) — preserva chamadas
   * antigas/snapshots existentes.
   */
  tz?: string;
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

/**
 * ETAPA B — fechamentos do período. Vem das etapas fixas do funil (papel
 * 'fechamento'/'perda') e das vendas pagas; ignora os filtros de inbox/time/
 * agente porque são números do contato, não da conversa.
 * Regras em docs/METRICAS_DASHBOARD.md › "Qualidade & Conversão".
 */
export interface FechamentoMetrics {
  /** Contatos distintos que entraram em etapa de fechamento no período. */
  conversoes: number;
  /** Contatos criados no período (base da taxa). */
  novosContatos: number;
  /** conversoes / novosContatos em % (0–100, 1 casa). null = sem base. */
  taxaConversao: number | null;
  /** Soma das Sales paid com paidAt no período (R$). */
  receita: number;
  /** Quantas Sales paid no período. */
  vendasComValor: number;
  /** Contatos distintos que entraram em etapa de perda no período. */
  perdas: number;
  // --- Dashboard 06/10 (funil "do primeiro contato ao fechamento") ---
  /** Contatos criados no período com ≥1 Conversation respondida (firstResponseAt). */
  atendidos: number;
  /** Contatos criados no período com ≥1 CalendarEvent scheduled/completed. */
  comReuniao: number;
  /** receita ÷ vendasComValor (R$, 2 casas). null = sem venda com valor. */
  ticketMedio: number | null;
  /** Sales pending com origem 'fechamento' criadas no período (fechou sem informar valor). */
  semValor: number;
}

/**
 * Dashboard 06/10 — os mesmos KPIs da linha 1 aplicados ao período
 * imediatamente anterior (mesma duração). O front calcula a variação.
 * Respeita os mesmos filtros de conversa (inbox/time/agente) do período atual;
 * `reunioes` ignora esses filtros, como no bloco `reunioes`.
 */
export interface PeriodoAnteriorMetrics {
  totalConversations: number;
  resolvedConversations: number;
  avgFirstResponseMin: number | null;
  avgResolutionMin: number | null;
  reunioes: number;
}

export interface ReunioesPorDiaBucket {
  date: string; // yyyy-mm-dd
  total: number;
}

/**
 * Dashboard 06/10 — reuniões MARCADAS no período (CalendarEvent.createdAt),
 * status scheduled/completed (held e cancelled ficam fora). Ignora
 * inbox/time/agente: é número da agenda, não da conversa.
 */
export interface ReunioesMetrics {
  total: number;
  /** Marcadas pelo agente de IA (conversationId NOT NULL). */
  peloAgente: number;
  /** Só os dias com evento — o front preenche os zeros. */
  porDia: ReunioesPorDiaBucket[];
}

/**
 * Dashboard 06/10 — conversas criadas no período em que a IA falou com o
 * cliente E um humano também falou (mensagens não-privadas).
 */
export interface TransferidasParaHumanoMetrics {
  total: number;
  /** total ÷ conversas com ≥1 mensagem da IA, em % (0–100, 1 casa). null = sem base. */
  pct: number | null;
}

/**
 * Dashboard 06/10 — origem dos contatos criados no período, pela PRIMEIRA
 * conversa de cada um. Ignora inbox/time/agente.
 */
export interface OrigemContatosMetrics {
  /** Primeira conversa com sourceType 'ctwa' (clique em anúncio Meta). */
  anuncio: number;
  /** O resto: organic, null ou sem conversa. */
  organico: number;
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
  fechamento: FechamentoMetrics;
  // --- Dashboard 06/10 (tudo aditivo) ---
  anterior: PeriodoAnteriorMetrics;
  reunioes: ReunioesMetrics;
  transferidasParaHumano: TransferidasParaHumanoMetrics;
  origem: OrigemContatosMetrics;
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
  /**
   * Dashboard 06/10 — das conversas em `emAberto`, quantas estão com o cliente
   * esperando há mais de 5 min: última mensagem não-privada é do cliente e tem
   * mais de 5 min, ou a conversa não tem mensagem nenhuma e foi criada há mais
   * de 5 min.
   */
  esperandoHaMais5Min: number;
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
 * Cache de Intl.DateTimeFormat por timezone — instanciar formatter é caro
 * (alguns ms) e nós chamamos por conversa em loop.
 */
const dayFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDayFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = dayFormatterCache.get(tz);
  if (!fmt) {
    // en-CA produz yyyy-mm-dd nativamente sem precisar montar via parts.
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatterCache.set(tz, fmt);
  }
  return fmt;
}

/**
 * Valida que `tz` é uma IANA timezone aceita por Intl. Se não for, joga
 * ValidationError pro controller responder 400 com mensagem clara.
 */
function assertValidTimezone(tz: string): void {
  try {
    // Construtor lança RangeError em string inválida.
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  } catch {
    throw new ValidationError(`Timezone inválido: ${tz}`);
  }
}

/**
 * Chave yyyy-mm-dd no fuso `tz`. Quando `tz` é omitido, cai pro modo UTC
 * legado pra preservar consumidores que não passam o filtro.
 */
function dayKeyInTz(d: Date, tz: string | undefined): string {
  if (!tz) return utcDayKey(d);
  return getDayFormatter(tz).format(d);
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

/**
 * Gera lista de chaves yyyy-mm-dd entre `from` e `to` (inclusive) no fuso
 * `tz`. Quando `tz` é omitido, cai pro `eachUtcDayKey` legado.
 *
 * Avança em incrementos de 12h em UTC (menor que qualquer offset DST possível)
 * e usa o formatter pra extrair o dia local, dedupando via Set. Isso lida
 * corretamente com dias "perdidos" ou "duplicados" pelo DST sem precisar de
 * matemática de timezone manual.
 */
function eachDayKeyInTz(from: Date, to: Date, tz: string | undefined): string[] {
  if (!tz) return eachUtcDayKey(from, to);

  const fmt = getDayFormatter(tz);
  const seen = new Set<string>();
  const keys: string[] = [];

  const stepMs = 12 * 60 * 60 * 1000; // 12h
  const MAX_STEPS = 366 * 10 * 2; // 10 anos em passos de 12h
  let cursor = from.getTime();
  const endMs = to.getTime();
  let safety = 0;
  while (cursor <= endMs && safety < MAX_STEPS) {
    const key = fmt.format(new Date(cursor));
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
    cursor += stepMs;
    safety += 1;
  }
  // Garante que o dia de `to` entre mesmo se o último passo passou (ex: to=23:30 local).
  const lastKey = fmt.format(to);
  if (!seen.has(lastKey)) {
    seen.add(lastKey);
    keys.push(lastKey);
  }
  return keys;
}

// ============================================
// Dashboard 06/10 — helpers
// ============================================

/** Status de CalendarEvent que contam como "reunião marcada". */
const STATUS_REUNIAO_MARCADA = ['scheduled', 'completed'] as const;

/** Sale.origem gravada pelo gatilho de fechamento (sale.service › ORIGEM_FECHAMENTO). */
const ORIGEM_SALE_FECHAMENTO = 'fechamento';

/** Quanto tempo o cliente pode ficar sem resposta antes de virar "esperando". */
const ESPERA_MAX_MS = 5 * 60 * 1000;

type FiltrosDeConversa = Pick<MetricsFilters, 'inboxId' | 'teamId' | 'agentId'>;

/**
 * Janela imediatamente anterior ao período, de mesma duração. Como o período
 * é inclusivo nas duas pontas, a anterior termina 1 ms antes do `from` atual.
 */
function periodoAnterior(fromDate: Date, toDate: Date): { fromDate: Date; toDate: Date } {
  const duracao = toDate.getTime() - fromDate.getTime();
  const to = new Date(fromDate.getTime() - 1);
  return { fromDate: new Date(to.getTime() - duracao), toDate: to };
}

/**
 * `where` de Conversation usado pelos KPIs da linha 1: criada OU resolvida
 * no período, mais os filtros opcionais. Centralizado pra que o período
 * anterior conte exatamente como o atual.
 */
function whereConversas(
  accountId: string,
  fromDate: Date,
  toDate: Date,
  f: FiltrosDeConversa
): Prisma.ConversationWhereInput {
  return {
    accountId,
    OR: [
      { createdAt: { gte: fromDate, lte: toDate } },
      { resolvedAt: { gte: fromDate, lte: toDate } },
    ],
    ...(f.inboxId ? { inboxId: f.inboxId } : {}),
    ...(f.teamId ? { teamId: f.teamId } : {}),
    ...(f.agentId ? { assigneeId: f.agentId } : {}),
  };
}

/**
 * Os mesmos filtros opcionais em SQL, pra queries raw em que a conversa está
 * com alias `c`. Sem filtro vira fragmento vazio.
 */
function filtrosDeConversaSql(f: FiltrosDeConversa): Prisma.Sql {
  const partes: Prisma.Sql[] = [];
  if (f.inboxId) partes.push(Prisma.sql`AND c.inbox_id = ${f.inboxId}::uuid`);
  if (f.teamId) partes.push(Prisma.sql`AND c.team_id = ${f.teamId}::uuid`);
  if (f.agentId) partes.push(Prisma.sql`AND c.assignee_id = ${f.agentId}::uuid`);
  return partes.length > 0 ? Prisma.join(partes, ' ') : Prisma.empty;
}

/** Mesmo arredondamento de `average()` (2 casas), aceitando null do AVG. */
function arredonda2(v: number | null | undefined): number | null {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return Math.round(v * 100) / 100;
}

/** Percentual 0–100 com 1 casa; null quando não há base. */
function percentual(parte: number, base: number): number | null {
  return base > 0 ? Math.round((parte / base) * 1000) / 10 : null;
}

class ChatMetricsService {
  /**
   * Métricas agregadas do chat interno para uma conta no período.
   */
  async getMetrics(
    accountId: string,
    filters: MetricsFilters
  ): Promise<ChatMetricsResult> {
    const { fromDate, toDate, inboxId, teamId, agentId, tz } = filters;

    if (!(fromDate instanceof Date) || !(toDate instanceof Date)) {
      throw new Error('fromDate e toDate devem ser instâncias de Date');
    }
    if (fromDate > toDate) {
      throw new Error('fromDate não pode ser maior que toDate');
    }
    if (tz) assertValidTimezone(tz);

    // FIX (T2-METRICS-RANGE): cap em 365 dias. Sem isso, um range de "30 anos"
    // gera 3660 buckets diários (~198KB de JSON) e trava o recharts no FE.
    // Erro semântico (ValidationError) pra o controller responder 400.
    const diffDays = (toDate.getTime() - fromDate.getTime()) / MS_PER_DAY;
    if (diffDays > MAX_RANGE_DAYS) {
      throw new ValidationError(
        `Range máximo permitido é ${MAX_RANGE_DAYS} dias`
      );
    }

    // FIX (review): inclui conversas resolvidas no período mesmo que tenham
    // sido criadas antes. Ex: ticket criado há 60d e resolvido hoje precisa
    // aparecer no dashboard "últimos 30d" para a taxa de resolução não vir
    // artificialmente baixa.
    const where = whereConversas(accountId, fromDate, toDate, { inboxId, teamId, agentId });

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
    //
    // FIX (L-DASH-2): bucketiza por dia LOCAL ao timezone do account
    // (parâmetro `tz`) ao invés de UTC, pra que conversas das 22h-23h locais
    // (que caem no dia seguinte em UTC) apareçam no dia certo do gráfico.
    // Quando `tz` é omitido, mantém comportamento legado (UTC).
    // ============================================
    const dayKeys = eachDayKeyInTz(fromDate, toDate, tz);
    const dailyMap = new Map<string, { total: number; resolved: number; open: number }>();
    for (const key of dayKeys) {
      dailyMap.set(key, { total: 0, resolved: 0, open: 0 });
    }
    for (const c of conversations) {
      // Usa createdAt pra bucket de "novas conversas" — alinhado ao gráfico
      // existente. Conversas resolvidas no período mas criadas fora caem no
      // bucket da data de criação se estiver dentro; caso contrário, criamos
      // o bucket pela data de resolução pra elas aparecerem como "resolvidas".
      const createdKey = dayKeyInTz(c.createdAt, tz);
      if (dailyMap.has(createdKey)) {
        const bucket = dailyMap.get(createdKey)!;
        bucket.total += 1;
        if (c.status === 'resolved') bucket.resolved += 1;
        if (['open', 'pending', 'snoozed'].includes(c.status)) bucket.open += 1;
      } else if (c.resolvedAt) {
        const resolvedKey = dayKeyInTz(c.resolvedAt, tz);
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

    // Dashboard 06/10 — blocos aditivos. Cada um é agregado no Postgres e
    // independente dos outros, então rodam em paralelo.
    const [fechamento, anterior, reunioes, transferidasParaHumano, origem] =
      await Promise.all([
        this.getFechamentoMetrics(accountId, fromDate, toDate),
        this.getPeriodoAnteriorMetrics(accountId, filters),
        this.getReunioesMetrics(accountId, fromDate, toDate, tz),
        this.getTransferidasParaHumano(accountId, filters),
        this.getOrigemContatos(accountId, fromDate, toDate),
      ]);

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
      fechamento,
      anterior,
      reunioes,
      transferidasParaHumano,
      origem,
    };
  }

  // ==========================================================================
  // Dashboard 06/10 — blocos novos (tudo agregado no Postgres)
  // ==========================================================================

  /**
   * Os KPIs da linha 1 no período imediatamente anterior. As contagens usam
   * o MESMO `where` do período atual; as médias são o mesmo cálculo dos ciclos
   * (firstResponseAt − openedAt, resolvedAt − openedAt, em minutos), só que
   * feito pelo AVG do Postgres em vez de carregar os ciclos — arredondado a
   * 2 casas como `average()`.
   */
  async getPeriodoAnteriorMetrics(
    accountId: string,
    filters: MetricsFilters
  ): Promise<PeriodoAnteriorMetrics> {
    const { inboxId, teamId, agentId } = filters;
    const { fromDate, toDate } = periodoAnterior(filters.fromDate, filters.toDate);
    const where = whereConversas(accountId, fromDate, toDate, { inboxId, teamId, agentId });
    const filtros = filtrosDeConversaSql({ inboxId, teamId, agentId });

    const [totalConversations, resolvedConversations, medias, reunioes] = await Promise.all([
      prisma.conversation.count({ where }),
      prisma.conversation.count({ where: { ...where, status: 'resolved' } }),
      prisma.$queryRaw<Array<{ frt: number | null; res: number | null }>>`
        /* chat-metrics:anterior */
        SELECT
          (AVG(EXTRACT(EPOCH FROM (cy.first_response_at - cy.opened_at)) / 60.0)
             FILTER (WHERE cy.first_response_at IS NOT NULL))::float8 AS frt,
          (AVG(EXTRACT(EPOCH FROM (cy.resolved_at - cy.opened_at)) / 60.0)
             FILTER (WHERE cy.resolved_at IS NOT NULL))::float8 AS res
        FROM conversation_cycles cy
        JOIN conversations c ON c.id = cy.conversation_id
        WHERE cy.account_id = ${accountId}::uuid
          AND (
            (cy.opened_at >= ${fromDate}::timestamptz AND cy.opened_at <= ${toDate}::timestamptz)
            OR (cy.resolved_at >= ${fromDate}::timestamptz AND cy.resolved_at <= ${toDate}::timestamptz)
          )
          ${filtros}
      `,
      prisma.calendarEvent.count({
        where: {
          accountId,
          createdAt: { gte: fromDate, lte: toDate },
          status: { in: [...STATUS_REUNIAO_MARCADA] },
        },
      }),
    ]);

    return {
      totalConversations,
      resolvedConversations,
      avgFirstResponseMin: arredonda2(medias[0]?.frt),
      avgResolutionMin: arredonda2(medias[0]?.res),
      reunioes,
    };
  }

  /**
   * Reuniões marcadas no período, por dia. Uma query: GROUP BY do dia de
   * `created_at` no mesmo fuso de `dailyVolume` (`tz`, ou UTC quando omitido),
   * com o total e o subtotal do agente (conversationId NOT NULL).
   */
  async getReunioesMetrics(
    accountId: string,
    fromDate: Date,
    toDate: Date,
    tz?: string
  ): Promise<ReunioesMetrics> {
    const fuso = tz ?? 'UTC';
    const rows = await prisma.$queryRaw<
      Array<{ date: string; total: number; pelo_agente: number }>
    >`
      /* chat-metrics:reunioes */
      SELECT
        to_char(created_at AT TIME ZONE ${fuso}, 'YYYY-MM-DD') AS date,
        COUNT(*)::int AS total,
        (COUNT(*) FILTER (WHERE conversation_id IS NOT NULL))::int AS pelo_agente
      FROM calendar_events
      WHERE account_id = ${accountId}::uuid
        AND created_at >= ${fromDate}::timestamptz
        AND created_at <= ${toDate}::timestamptz
        AND status IN ('scheduled', 'completed')
      GROUP BY 1
      ORDER BY 1
    `;

    let total = 0;
    let peloAgente = 0;
    const porDia: ReunioesPorDiaBucket[] = [];
    for (const r of rows) {
      total += r.total;
      peloAgente += r.pelo_agente;
      porDia.push({ date: r.date, total: r.total });
    }
    return { total, peloAgente, porDia };
  }

  /**
   * Conversas criadas no período em que a IA falou E um humano falou (as duas
   * via mensagens não-privadas — nota interna não é "assumir"). Base do
   * percentual: conversas em que a IA falou. Uma query com EXISTS duplo.
   */
  async getTransferidasParaHumano(
    accountId: string,
    filters: MetricsFilters
  ): Promise<TransferidasParaHumanoMetrics> {
    const { fromDate, toDate, inboxId, teamId, agentId } = filters;
    const filtros = filtrosDeConversaSql({ inboxId, teamId, agentId });

    const rows = await prisma.$queryRaw<Array<{ total: number; com_ia: number }>>`
      /* chat-metrics:transferidas */
      SELECT
        (COUNT(*) FILTER (WHERE t.com_ia AND t.com_humano))::int AS total,
        (COUNT(*) FILTER (WHERE t.com_ia))::int AS com_ia
      FROM (
        SELECT
          EXISTS (
            SELECT 1 FROM messages m
            WHERE m.conversation_id = c.id AND m.sender_type = 'ai_bot' AND m.is_private = false
          ) AS com_ia,
          EXISTS (
            SELECT 1 FROM messages m
            WHERE m.conversation_id = c.id AND m.sender_type = 'agent' AND m.is_private = false
          ) AS com_humano
        FROM conversations c
        WHERE c.account_id = ${accountId}::uuid
          AND c.created_at >= ${fromDate}::timestamptz
          AND c.created_at <= ${toDate}::timestamptz
          ${filtros}
      ) t
    `;

    const total = rows[0]?.total ?? 0;
    const comIa = rows[0]?.com_ia ?? 0;
    return { total, pct: percentual(total, comIa) };
  }

  /**
   * Origem dos contatos criados no período: a PRIMEIRA conversa de cada um
   * (menor createdAt) veio de anúncio (`sourceType = 'ctwa'`) ou não. Quem
   * não tem conversa conta como orgânico. Uma query com subselect correlato.
   */
  async getOrigemContatos(
    accountId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<OrigemContatosMetrics> {
    const rows = await prisma.$queryRaw<Array<{ anuncio: number; organico: number }>>`
      /* chat-metrics:origem */
      SELECT
        (COUNT(*) FILTER (WHERE t.primeira_origem = 'ctwa'))::int AS anuncio,
        (COUNT(*) FILTER (WHERE t.primeira_origem IS DISTINCT FROM 'ctwa'))::int AS organico
      FROM (
        SELECT (
          SELECT c.source_type FROM conversations c
          WHERE c.contact_id = ct.id
          ORDER BY c.created_at ASC, c.id ASC
          LIMIT 1
        ) AS primeira_origem
        FROM contacts ct
        WHERE ct.account_id = ${accountId}::uuid
          AND ct.created_at >= ${fromDate}::timestamptz
          AND ct.created_at <= ${toDate}::timestamptz
      ) t
    `;

    return { anuncio: rows[0]?.anuncio ?? 0, organico: rows[0]?.organico ?? 0 };
  }

  /**
   * ETAPA B — "Atendimento → Venda" de verdade (antes era 0% fixo).
   *
   * - conversões: contatos DISTINTOS com entrada ('added' no tag_history) em
   *   etapa papel='fechamento' dentro do período. Distinto porque o lead que
   *   sai e volta da etapa é um fechamento só.
   * - base: contatos criados no período. É taxa de coorte aproximada — quem
   *   entrou há 2 meses e fechou hoje conta no numerador de hoje; é o que o
   *   operador espera ver ("quanto do que entrou virou venda").
   * - receita: Sales paid com paidAt no período, qualquer origem (Kanban ou
   *   Financeiro) — dinheiro é dinheiro.
   * - perdas: idem conversões, em papel='perda'.
   */
  async getFechamentoMetrics(
    accountId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<FechamentoMetrics> {
    const periodo = { gte: fromDate, lte: toDate };

    const entradasEm = (papel: 'fechamento' | 'perda') =>
      prisma.tagHistory.findMany({
        where: {
          action: 'added',
          createdAt: periodo,
          contactId: { not: null },
          tag: { accountId, papel },
        },
        select: { contactId: true },
        distinct: ['contactId'],
      });

    const [fechamentos, perdas, novosContatos, pagas, atendidos, comReuniao, semValor] =
      await Promise.all([
        entradasEm('fechamento'),
        entradasEm('perda'),
        prisma.contact.count({ where: { accountId, createdAt: periodo } }),
        prisma.sale.aggregate({
          where: { accountId, status: 'paid', paidAt: periodo },
          _sum: { valor: true },
          _count: { _all: true },
        }),
        // Dashboard 06/10 — etapas do funil "do primeiro contato ao fechamento".
        // Os dois `some` viram EXISTS no Postgres: uma query cada, sem N+1.
        prisma.contact.count({
          where: {
            accountId,
            createdAt: periodo,
            conversations: { some: { firstResponseAt: { not: null } } },
          },
        }),
        prisma.contact.count({
          where: {
            accountId,
            createdAt: periodo,
            calendarEvents: { some: { status: { in: [...STATUS_REUNIAO_MARCADA] } } },
          },
        }),
        prisma.sale.count({
          where: {
            accountId,
            status: 'pending',
            origem: ORIGEM_SALE_FECHAMENTO,
            createdAt: periodo,
          },
        }),
      ]);

    const conversoes = fechamentos.length;
    const taxaConversao = percentual(conversoes, novosContatos);
    const receita = Number(pagas._sum.valor ?? 0);
    const vendasComValor = pagas._count._all;

    return {
      conversoes,
      novosContatos,
      taxaConversao,
      receita,
      vendasComValor,
      perdas: perdas.length,
      atendidos,
      comReuniao,
      ticketMedio: vendasComValor > 0 ? arredonda2(receita / vendasComValor) : null,
      semValor,
    };
  }

  /**
   * Métricas individuais de um agente no período (assigneeId = userId).
   *
   * FIX (L-DASH-1): valida que `userId` existe E pertence a `accountId` antes
   * de calcular. Sem isso, qualquer UUID inexistente (ou de outra conta) volta
   * 200 com zeros — vaza existência via canal de tempo de resposta e confunde
   * o FE (que aceita "agente válido com zero atividade" como estado legítimo).
   *
   * L-DASH-3 (follow-up): paginar/streamar quando os logs ficarem grandes.
   * Hoje os SELECTs são limitados pelo período (default 30d) e por
   * `accountId + assigneeId`, então o set permanece pequeno em produção.
   * Quando a janela máxima de 365d for batida com volume real (>50k cycles
   * por agente), reescrever em SQL agregado (GROUP BY) ou paginar via
   * cursor para evitar carregar tudo em memória.
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

    // L-DASH-1: garante que o user existe na conta. Cross-tenant ou UUID
    // inexistente → 404 (NotFoundError vira HTTP 404 no errorHandler).
    const userExists = await prisma.user.findFirst({
      where: { id: userId, accountId },
      select: { id: true },
    });
    if (!userExists) {
      throw new NotFoundError('Usuário');
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
        createdAt: true,
      },
    });

    if (conversations.length === 0) {
      return {
        ia: { count: 0, conversationIds: [] },
        humano: { count: 0, conversationIds: [] },
        emAberto: { count: 0, conversationIds: [] },
        total: 0,
        esperandoHaMais5Min: 0,
      };
    }

    const ids = conversations.map((c) => c.id);

    // Última Message NÃO-privada por conversa (system_note/private notas internas
    // não devem influenciar quem está "conduzindo" o atendimento). Traz também
    // o `created_at` pra medir há quanto tempo o cliente espera (mesma query).
    const lastSenders = await prisma.$queryRaw<
      Array<{ conversation_id: string; sender_type: string; created_at: Date }>
    >`
      SELECT DISTINCT ON (conversation_id) conversation_id, sender_type, created_at
      FROM messages
      WHERE conversation_id = ANY(${ids}::uuid[])
        AND is_private = false
      ORDER BY conversation_id, created_at DESC
    `;
    const lastByConv = new Map<string, { senderType: string; createdAt: Date }>();
    for (const r of lastSenders) {
      lastByConv.set(r.conversation_id, {
        senderType: r.sender_type,
        createdAt: new Date(r.created_at),
      });
    }

    const ia: string[] = [];
    const humano: string[] = [];
    const emAberto: string[] = [];
    let esperandoHaMais5Min = 0;
    const limiteEspera = Date.now() - ESPERA_MAX_MS;

    for (const c of conversations) {
      const attrs =
        (c.customAttributes as Record<string, unknown> | null) ?? {};
      const humanActive = attrs.human_active === true;
      const handlerActive = attrs.handler_active === true;
      const ultima = lastByConv.get(c.id);
      const lastSender = ultima?.senderType;

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

      // Dashboard 06/10 — cliente esperando há mais de 5 min: a última
      // mensagem é dele (e velha), ou ninguém disse nada desde que a conversa
      // abriu (e ela é velha).
      const esperandoDesde = ultima
        ? ultima.senderType === 'customer'
          ? ultima.createdAt
          : null
        : c.createdAt;
      if (esperandoDesde && esperandoDesde.getTime() < limiteEspera) {
        esperandoHaMais5Min += 1;
      }
    }

    return {
      ia: { count: ia.length, conversationIds: ia },
      humano: { count: humano.length, conversationIds: humano },
      emAberto: { count: emAberto.length, conversationIds: emAberto },
      total: conversations.length,
      esperandoHaMais5Min,
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
   *
   * L-DASH-3 (follow-up): a paginação atual roda *em memória* — a query do
   * Postgres traz TODOS os ciclos/conversas/contatos do período e o slice
   * acontece depois (linhas 980-982). Funciona até alguns milhares de leads
   * recorrentes; em contas FitPark com >10k contatos retornando, mover o
   * `LIMIT/OFFSET` (ou `cursor`) pra dentro das queries Prisma e calcular
   * `total` via `count` separado. Trocar `findMany` por SQL agregado
   * (GROUP BY contactId HAVING COUNT(*) >= 2) também elimina o `Map` em JS.
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
    // FIX (T2-RETURNING-FILTERS-PARTIAL): reaplica os mesmos filtros (inbox/
    // team/agent) usados no getReturningLeadsCount. Sem isso, lastConversationId
    // podia apontar pra uma conversa de outro team/agent — drill-down mostrava
    // dados de fora do filtro.
    const convs = await prisma.conversation.findMany({
      where: {
        accountId,
        contactId: { in: leadIds },
        ...(filters.inboxId ? { inboxId: filters.inboxId } : {}),
        ...(filters.teamId ? { teamId: filters.teamId } : {}),
        ...(filters.agentId ? { assigneeId: filters.agentId } : {}),
      },
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
