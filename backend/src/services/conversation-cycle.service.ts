/**
 * CONVERSATION CYCLE SERVICE — T-022 (lifecycle architecture)
 *
 * Bug B (architecture): Conversation guardava resolvedAt/resolvedBy/firstResponseAt
 * em colunas diretas. Reabertura ZERAVA essas colunas, perdendo o ciclo anterior.
 * Métricas (resolvedByAi/resolvedByHuman/avgFirstResponse) consultavam essas
 * colunas atuais — não contavam ciclos anteriores.
 *
 * Arquitetura nova: cada ciclo open->resolved fica registrado SEPARADO em
 * ConversationCycle. Reopen cria novo ciclo, não apaga o anterior.
 *
 *   - openCycle(conversationId, accountId)
 *       cria um ConversationCycle(openedAt=now) e seta Conversation.openCycleId
 *
 *   - closeCycle(conversationId, accountId, {resolvedBy, resolvedByUserId, snapshot?})
 *       fecha o ciclo ativo (resolvedAt, resolvedBy, snapshot, durationSec)
 *       e nullifica Conversation.openCycleId
 *
 *   - recordFirstResponse(conversationId, accountId, byUserId)
 *       seta firstResponseAt/firstResponseByUserId no ciclo aberto, se nulo
 *
 *   - incrementMessageCount(conversationId, accountId, senderType)
 *       incrementa customer_messages_count ou agent_messages_count no ciclo aberto
 *
 *   - findOpenCycle(conversationId, accountId)
 *       retorna o ciclo ativo da conversa (ou null)
 *
 *   - getMetrics(accountId, filters)
 *       agrega por ConversationCycle (KPIs ao invés de Conversation atual)
 *
 * NOTA importante de compatibilidade:
 *   Conversation.resolvedAt / resolvedBy / firstResponseAt SEGUEM existindo e
 *   continuam refletindo o ÚLTIMO ciclo — a UI atual não precisa mudar. Eles
 *   passam a ser uma "view" do último ciclo (escritos pelos services lifecycle).
 */

import type { Prisma, ConversationCycle } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export type CycleResolvedBy = 'ai' | 'human' | 'timeout';
export type CycleSenderType = 'customer' | 'agent';

export interface CloseCycleInput {
  resolvedBy: CycleResolvedBy;
  resolvedByUserId?: string | null;
  /**
   * Snapshot opcional do estado da conversa no momento da resolução.
   * Se omitido, o service captura via lookup leve (priority/team/assignee/labels).
   */
  snapshot?: Record<string, unknown>;
  // SLA v2 — outcome obrigatorio (quando vindo do controller), internalRating
  // opcional, reason opcional, csatRequested controla se vai pedir CSAT depois.
  outcome?: string | null;
  internalRating?: number | null;
  resolveReason?: string | null;
  csatRequested?: boolean;
}

export interface CycleMetricsFilters {
  fromDate: Date;
  toDate: Date;
  inboxId?: string;
  teamId?: string;
  agentId?: string;
}

export interface CycleMetricsResult {
  totalCycles: number;
  openCycles: number;
  resolvedCycles: number;
  resolvedByAi: number;
  resolvedByHuman: number;
  resolvedByTimeout: number;
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

// ============================================
// Service
// ============================================

class ConversationCycleService {
  // ============================================
  // findOpenCycle
  // ============================================

  async findOpenCycle(
    conversationId: string,
    accountId: string
  ): Promise<ConversationCycle | null> {
    // Caminho rápido: usa openCycleId direto se ainda apontar.
    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { openCycleId: true },
    });
    if (!conv) return null;
    if (conv.openCycleId) {
      const cycle = await prisma.conversationCycle.findFirst({
        where: { id: conv.openCycleId, accountId, conversationId },
      });
      if (cycle && !cycle.resolvedAt) return cycle;
    }
    // Fallback: procura último ciclo sem resolvedAt (ex.: legado/backfill).
    return prisma.conversationCycle.findFirst({
      where: { conversationId, accountId, resolvedAt: null },
      orderBy: { openedAt: 'desc' },
    });
  }

  // ============================================
  // openCycle
  // ============================================

  /**
   * Cria um novo ConversationCycle para a conversa e seta Conversation.openCycleId.
   * Idempotente: se já houver ciclo aberto, retorna ele sem criar duplicata.
   */
  async openCycle(
    conversationId: string,
    accountId: string,
    opts: { openedAt?: Date } = {}
  ): Promise<ConversationCycle> {
    const existingOpen = await this.findOpenCycle(conversationId, accountId);
    if (existingOpen) {
      return existingOpen;
    }

    const openedAt = opts.openedAt ?? new Date();

    // Cria + aponta openCycleId numa única transação curta.
    return prisma.$transaction(async (tx) => {
      const cycle = await tx.conversationCycle.create({
        data: {
          conversationId,
          accountId,
          openedAt,
        },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { openCycleId: cycle.id },
      });
      return cycle;
    });
  }

  // ============================================
  // closeCycle
  // ============================================

  /**
   * Fecha o ciclo aberto da conversa.
   * - Seta resolvedAt = now (ou opts.resolvedAt)
   * - Seta resolvedBy, resolvedByUserId
   * - Calcula durationSec a partir de openedAt
   * - Persiste snapshot do estado atual (priority/assignee/team/labels) se não fornecido
   * - Nullifica Conversation.openCycleId
   *
   * No-op silencioso (e logado em debug) se não houver ciclo aberto — ex.: dupla
   * chamada de resolve por race entre webhook e UI.
   */
  async closeCycle(
    conversationId: string,
    accountId: string,
    input: CloseCycleInput,
    opts: { resolvedAt?: Date } = {}
  ): Promise<ConversationCycle | null> {
    const openCycle = await this.findOpenCycle(conversationId, accountId);
    if (!openCycle) {
      logger.debug('[cycle] closeCycle no-op — nenhum ciclo aberto', {
        conversationId,
        accountId,
      });
      return null;
    }

    const resolvedAt = opts.resolvedAt ?? new Date();
    const durationSec = Math.max(
      0,
      Math.round((resolvedAt.getTime() - openCycle.openedAt.getTime()) / 1000)
    );

    const snapshot =
      input.snapshot ?? (await this.buildSnapshot(conversationId, accountId));

    return prisma.$transaction(async (tx) => {
      const updated = await tx.conversationCycle.update({
        where: { id: openCycle.id },
        data: {
          resolvedAt,
          resolvedBy: input.resolvedBy,
          resolvedByUserId: input.resolvedByUserId ?? null,
          durationSec,
          snapshot: (snapshot ?? {}) as Prisma.InputJsonValue,
          // SLA v2 — campos novos. Sempre que vier (mesmo null), aplica.
          ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
          ...(input.internalRating !== undefined
            ? { internalRating: input.internalRating }
            : {}),
          ...(input.resolveReason !== undefined
            ? { resolveReason: input.resolveReason }
            : {}),
          ...(input.csatRequested !== undefined
            ? { csatRequested: input.csatRequested }
            : {}),
        },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { openCycleId: null },
      });
      return updated;
    });
  }

  // ============================================
  // recordFirstResponse
  // ============================================

  /**
   * Marca primeira resposta no ciclo ativo, se ainda não setada.
   * Idempotente: chamadas subsequentes são no-op.
   */
  async recordFirstResponse(
    conversationId: string,
    accountId: string,
    byUserId: string | null
  ): Promise<ConversationCycle | null> {
    const openCycle = await this.findOpenCycle(conversationId, accountId);
    if (!openCycle) {
      // Sem ciclo aberto: pode ser uma conversa legada não-migrada — opcionalmente
      // poderíamos abrir um ciclo aqui, mas o openCycle é responsabilidade do
      // conversation.service. Logamos em debug e seguimos.
      logger.debug('[cycle] recordFirstResponse sem ciclo aberto', {
        conversationId,
        accountId,
      });
      return null;
    }
    if (openCycle.firstResponseAt) return openCycle;

    return prisma.conversationCycle.update({
      where: { id: openCycle.id },
      data: {
        firstResponseAt: new Date(),
        firstResponseByUserId: byUserId ?? null,
      },
    });
  }

  // ============================================
  // incrementMessageCount
  // ============================================

  async incrementMessageCount(
    conversationId: string,
    accountId: string,
    senderType: CycleSenderType
  ): Promise<void> {
    const openCycle = await this.findOpenCycle(conversationId, accountId);
    if (!openCycle) {
      logger.debug('[cycle] incrementMessageCount sem ciclo aberto', {
        conversationId,
        accountId,
        senderType,
      });
      return;
    }

    const field =
      senderType === 'customer' ? 'customerMessagesCount' : 'agentMessagesCount';

    await prisma.conversationCycle.update({
      where: { id: openCycle.id },
      data: { [field]: { increment: 1 } },
    });
  }

  // ============================================
  // markSlaBreached
  // ============================================

  async markSlaBreached(
    conversationId: string,
    accountId: string,
    breachedAt: Date = new Date()
  ): Promise<ConversationCycle | null> {
    const openCycle = await this.findOpenCycle(conversationId, accountId);
    if (!openCycle) return null;
    if (openCycle.slaBreached) return openCycle;

    return prisma.conversationCycle.update({
      where: { id: openCycle.id },
      data: {
        slaBreached: true,
        slaBreachedAt: breachedAt,
      },
    });
  }

  // ============================================
  // listCycles (histórico)
  // ============================================

  async listCycles(
    conversationId: string,
    accountId: string
  ): Promise<ConversationCycle[]> {
    return prisma.conversationCycle.findMany({
      where: { conversationId, accountId },
      orderBy: { openedAt: 'desc' },
    });
  }

  // ============================================
  // getMetrics — agregações por ciclo
  // ============================================

  /**
   * KPIs agregados por ConversationCycle no período.
   * Substitui o cálculo via Conversation atual para que ciclos passados de
   * uma conversa reaberta também contem.
   *
   * Filtros opcionais (inboxId/teamId/agentId) viajam pelo Conversation parent
   * — ou seja, a métrica reflete o estado ATUAL da conversa, não o snapshot
   * do momento. Para usar o snapshot, troque o where por
   * `snapshot: { path: ['assigneeId'], equals: agentId }` (requer Postgres jsonb).
   */
  async getMetrics(
    accountId: string,
    filters: CycleMetricsFilters
  ): Promise<CycleMetricsResult> {
    const { fromDate, toDate, inboxId, teamId, agentId } = filters;

    if (!(fromDate instanceof Date) || !(toDate instanceof Date)) {
      throw new Error('fromDate e toDate devem ser instâncias de Date');
    }
    if (fromDate > toDate) {
      throw new Error('fromDate não pode ser maior que toDate');
    }

    // Conversa parent é filtrada via relation. Ciclos no período = abertos OU
    // resolvidos dentro da janela (espelha lógica de chat-metrics.service).
    const where: Prisma.ConversationCycleWhereInput = {
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
    };

    const cycles = await prisma.conversationCycle.findMany({
      where,
      select: {
        id: true,
        openedAt: true,
        resolvedAt: true,
        resolvedBy: true,
        firstResponseAt: true,
        slaBreached: true,
      },
    });

    const totalCycles = cycles.length;
    const resolvedCycles = cycles.filter((c) => c.resolvedAt).length;
    const openCycles = totalCycles - resolvedCycles;

    const resolvedByAi = cycles.filter(
      (c) => c.resolvedAt && c.resolvedBy === 'ai'
    ).length;
    const resolvedByHuman = cycles.filter(
      (c) => c.resolvedAt && c.resolvedBy === 'human'
    ).length;
    const resolvedByTimeout = cycles.filter(
      (c) => c.resolvedAt && c.resolvedBy === 'timeout'
    ).length;

    const frtSamples: number[] = [];
    const resolutionSamples: number[] = [];
    for (const c of cycles) {
      if (c.firstResponseAt) {
        frtSamples.push(diffMinutes(c.firstResponseAt, c.openedAt));
      }
      if (c.resolvedAt) {
        resolutionSamples.push(diffMinutes(c.resolvedAt, c.openedAt));
      }
    }

    const slaBreaches = cycles.filter((c) => c.slaBreached).length;

    return {
      totalCycles,
      openCycles,
      resolvedCycles,
      resolvedByAi,
      resolvedByHuman,
      resolvedByTimeout,
      avgFirstResponseMin: average(frtSamples),
      avgResolutionMin: average(resolutionSamples),
      slaBreaches,
    };
  }

  // ============================================
  // buildSnapshot — privado
  // ============================================

  /**
   * Constrói snapshot do estado atual da conversa para persistir no ciclo
   * no momento da resolução. Inclui priority, assignee, team e labels — o
   * suficiente pra análises retroativas (ex.: "quanto o agente X resolveu no
   * mês mesmo tendo sido transferido depois").
   *
   * Best-effort: erros aqui não devem abortar o close — caímos em {} silenciosamente.
   */
  private async buildSnapshot(
    conversationId: string,
    accountId: string
  ): Promise<Record<string, unknown>> {
    try {
      const conv = await prisma.conversation.findFirst({
        where: { id: conversationId, accountId },
        select: {
          priority: true,
          assigneeId: true,
          teamId: true,
          inboxId: true,
          labels: { select: { tagId: true } },
        },
      });
      if (!conv) return {};
      return {
        priority: conv.priority,
        assigneeId: conv.assigneeId,
        teamId: conv.teamId,
        inboxId: conv.inboxId,
        labelTagIds: conv.labels.map((l) => l.tagId),
        capturedAt: new Date().toISOString(),
      };
    } catch (err) {
      logger.debug('[cycle] buildSnapshot falhou — snapshot vazio', {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }
}

export const conversationCycleService = new ConversationCycleService();
