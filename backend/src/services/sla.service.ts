import type { SLAPolicy, SLABreach } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { toZonedTime } from 'date-fns-tz';
import { prisma } from '../config/database';
import { NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import { eventService } from './event.service';
import { webhookOutboundService } from './webhook-outbound.service';

// ============================================
// Types
// ============================================

export interface CreatePolicyInput {
  name: string;
  firstResponseMin: number;
  resolutionMin: number;
  businessHoursOnly?: boolean;
  // SLA v2 — campos de horario comercial e pausa
  pauseWhenWaitingCustomer?: boolean;
  businessHoursStart?: string | null;
  businessHoursEnd?: string | null;
  businessDays?: number[];
  timezone?: string;
}

export interface UpdatePolicyInput {
  name?: string;
  firstResponseMin?: number;
  resolutionMin?: number;
  businessHoursOnly?: boolean;
  active?: boolean;
  // SLA v2 — campos de horario comercial e pausa
  pauseWhenWaitingCustomer?: boolean;
  businessHoursStart?: string | null;
  businessHoursEnd?: string | null;
  businessDays?: number[];
  timezone?: string;
}

export interface CheckBreachesResult {
  detected: number;
}

type BreachType = 'first_response' | 'resolution';

// ============================================
// SLA v2 — Business hours helpers
// ============================================

/**
 * Parse "HH:MM" → { hours, minutes }. Retorna null se invalido.
 */
function parseHHMM(s: string | null | undefined): { h: number; m: number } | null {
  if (!s) return null;
  const m = s.match(/^([0-2]\d):([0-5]\d)$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23) return null;
  return { h, m: mi };
}

/**
 * Calcula segundos uteis (dentro do horario comercial) decorridos entre
 * `from` e `to`, considerando os campos da policy:
 *   - businessHoursStart / businessHoursEnd ("HH:MM")
 *   - businessDays (array de int 0..6, 0=domingo)
 *   - timezone (IANA, ex: "America/Sao_Paulo")
 *
 * Se a policy nao tiver businessHoursStart/End definidos, retorna o elapsed
 * puro (segundos corridos), preservando comportamento legado.
 *
 * Implementacao: walk minuto a minuto eh caro mas correto. Como o cron roda
 * em conversas open (geralmente < 1000), e cada slice e < 24h, o custo eh
 * aceitavel. Se virar gargalo, refatorar pra calculo em janelas diarias.
 */
export function calculateBusinessElapsedSec(
  from: Date,
  to: Date,
  policy: Pick<
    SLAPolicy,
    'businessHoursStart' | 'businessHoursEnd' | 'businessDays' | 'timezone'
  >
): number {
  // Sem horario comercial configurado — usa elapsed puro
  const start = parseHHMM(policy.businessHoursStart);
  const end = parseHHMM(policy.businessHoursEnd);
  if (!start || !end) {
    return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
  }

  const tz = policy.timezone || 'UTC';
  const days = policy.businessDays && policy.businessDays.length > 0
    ? policy.businessDays
    : [1, 2, 3, 4, 5];

  if (to.getTime() <= from.getTime()) return 0;

  // Walk em passos de 1 minuto. Soma os minutos que cairem dentro de
  // (dia comercial) AND (start <= hora < end) na timezone da policy.
  const STEP_MS = 60 * 1000;
  let cursor = from.getTime();
  const endMs = to.getTime();
  let businessMs = 0;

  while (cursor < endMs) {
    const slice = Math.min(STEP_MS, endMs - cursor);
    const zoned = toZonedTime(new Date(cursor), tz);
    const day = zoned.getDay();
    const hour = zoned.getHours();
    const minute = zoned.getMinutes();
    const minuteOfDay = hour * 60 + minute;
    const startMin = start.h * 60 + start.m;
    const endMin = end.h * 60 + end.m;

    if (days.includes(day) && minuteOfDay >= startMin && minuteOfDay < endMin) {
      businessMs += slice;
    }
    cursor += STEP_MS;
  }

  return Math.max(0, Math.floor(businessMs / 1000));
}

class SLAService {
  // ============================================
  // Helpers
  // ============================================

  /**
   * Ensure a policy belongs to the given account.
   * Throws NotFoundError otherwise.
   */
  private async ensurePolicy(id: string, accountId: string): Promise<SLAPolicy> {
    const policy = await prisma.sLAPolicy.findFirst({
      where: { id, accountId },
    });

    if (!policy) {
      throw new NotFoundError('Politica de SLA');
    }

    return policy;
  }

  private validatePolicyInput(input: Partial<CreatePolicyInput>): void {
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        throw new ValidationError('name e obrigatorio');
      }
      if (name.length > 120) {
        throw new ValidationError('name deve ter no maximo 120 caracteres');
      }
    }

    if (input.firstResponseMin !== undefined) {
      if (!Number.isFinite(input.firstResponseMin) || input.firstResponseMin <= 0) {
        throw new ValidationError('firstResponseMin deve ser um inteiro positivo');
      }
    }

    if (input.resolutionMin !== undefined) {
      if (!Number.isFinite(input.resolutionMin) || input.resolutionMin <= 0) {
        throw new ValidationError('resolutionMin deve ser um inteiro positivo');
      }
    }
  }

  // ============================================
  // CRUD de policies
  // ============================================

  /**
   * Lista todas as politicas de SLA de uma conta.
   */
  async listPolicies(accountId: string): Promise<SLAPolicy[]> {
    return prisma.sLAPolicy.findMany({
      where: { accountId },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
  }

  /**
   * Cria uma nova politica de SLA.
   */
  async createPolicy(accountId: string, input: CreatePolicyInput): Promise<SLAPolicy> {
    this.validatePolicyInput(input);

    const name = input.name.trim();

    const policy = await prisma.sLAPolicy.create({
      data: {
        accountId,
        name,
        firstResponseMin: Math.floor(input.firstResponseMin),
        resolutionMin: Math.floor(input.resolutionMin),
        businessHoursOnly: input.businessHoursOnly ?? true,
        // SLA v2 — defaults sensatos: pausa off, horario 09:00-18:00 seg-sex,
        // timezone Sao Paulo. Aceita override do input.
        pauseWhenWaitingCustomer: input.pauseWhenWaitingCustomer ?? false,
        businessHoursStart: input.businessHoursStart ?? null,
        businessHoursEnd: input.businessHoursEnd ?? null,
        businessDays: input.businessDays ?? [1, 2, 3, 4, 5],
        timezone: input.timezone ?? 'America/Sao_Paulo',
      },
    });

    logger.info('[sla] policy created', {
      accountId,
      policyId: policy.id,
      name: policy.name,
    });

    await eventService.create({
      accountId,
      eventType: 'sla.policy_created',
      entityType: 'sla_policy',
      entityId: policy.id,
      payload: {
        name: policy.name,
        firstResponseMin: policy.firstResponseMin,
        resolutionMin: policy.resolutionMin,
      },
    });

    return policy;
  }

  /**
   * Atualiza parcialmente uma politica de SLA (escopada por accountId).
   */
  async updatePolicy(
    id: string,
    accountId: string,
    input: UpdatePolicyInput
  ): Promise<SLAPolicy> {
    await this.ensurePolicy(id, accountId);
    this.validatePolicyInput(input);

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.firstResponseMin !== undefined) {
      data.firstResponseMin = Math.floor(input.firstResponseMin);
    }
    if (input.resolutionMin !== undefined) {
      data.resolutionMin = Math.floor(input.resolutionMin);
    }
    if (input.businessHoursOnly !== undefined) {
      data.businessHoursOnly = input.businessHoursOnly;
    }
    if (input.active !== undefined) data.active = input.active;
    // SLA v2 — campos novos (pausa + horario comercial). null em
    // businessHoursStart/End e tratado pelo schema (campo opcional).
    if (input.pauseWhenWaitingCustomer !== undefined) {
      data.pauseWhenWaitingCustomer = input.pauseWhenWaitingCustomer;
    }
    if (input.businessHoursStart !== undefined) {
      data.businessHoursStart = input.businessHoursStart;
    }
    if (input.businessHoursEnd !== undefined) {
      data.businessHoursEnd = input.businessHoursEnd;
    }
    if (input.businessDays !== undefined) {
      data.businessDays = input.businessDays;
    }
    if (input.timezone !== undefined) {
      data.timezone = input.timezone;
    }

    const policy = await prisma.sLAPolicy.update({
      where: { id },
      data,
    });

    logger.info('[sla] policy updated', { accountId, policyId: id });

    await eventService.create({
      accountId,
      eventType: 'sla.policy_updated',
      entityType: 'sla_policy',
      entityId: policy.id,
      payload: { changes: data },
    });

    return policy;
  }

  /**
   * Remove uma politica de SLA. Conversas relacionadas terao slaPolicyId
   * resetado para null (onDelete: SetNull no schema).
   */
  async deletePolicy(id: string, accountId: string): Promise<void> {
    await this.ensurePolicy(id, accountId);

    await prisma.sLAPolicy.delete({ where: { id } });

    logger.info('[sla] policy deleted', { accountId, policyId: id });

    await eventService.create({
      accountId,
      eventType: 'sla.policy_deleted',
      entityType: 'sla_policy',
      entityId: id,
    });
  }

  // ============================================
  // Aplicacao em conversation
  // ============================================

  /**
   * Aplica uma politica de SLA a uma conversation.
   * Ambas precisam pertencer ao mesmo accountId.
   */
  async applyPolicyToConversation(
    conversationId: string,
    accountId: string,
    policyId: string
  ): Promise<void> {
    const policy = await this.ensurePolicy(policyId, accountId);

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { id: true },
    });

    if (!conversation) {
      throw new NotFoundError('Conversation');
    }

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { slaPolicyId: policy.id },
    });

    logger.info('[sla] policy applied to conversation', {
      accountId,
      conversationId,
      policyId: policy.id,
    });

    await eventService.create({
      accountId,
      eventType: 'sla.policy_applied',
      entityType: 'conversation',
      entityId: conversationId,
      payload: { policyId: policy.id, policyName: policy.name },
    });
  }

  // ============================================
  // Worker: deteccao de breaches
  // ============================================

  /**
   * Roda como cron worker. Busca conversations open com sla_policy_id
   * e detecta breaches de:
   * - first_response: sem firstResponseAt apos firstResponseMin minutos
   * - resolution: status != resolved apos resolutionMin minutos
   *
   * Skip se ja existe um SLABreach do mesmo tipo para a conversation.
   * Emite sla.breached via eventService + webhookOutboundService.
   */
  async checkBreaches(now: Date = new Date()): Promise<CheckBreachesResult> {
    let detected = 0;

    const conversations = await prisma.conversation.findMany({
      where: {
        status: 'open',
        slaPolicyId: { not: null },
        slaPolicy: { active: true },
      },
      include: { slaPolicy: true },
    });

    for (const conversation of conversations) {
      const policy = conversation.slaPolicy;
      if (!policy) continue;

      // SLA v2 — pausa quando aguarda cliente: se a ultima mensagem foi do
      // agente/IA, o cronometro NAO conta enquanto espera o cliente. Soma
      // segundos uteis ate a ultima msg do cliente (ou ate agora se cliente
      // foi o ultimo a falar).
      let effectiveEnd: Date = now;
      if (policy.pauseWhenWaitingCustomer) {
        const lastMsg = await prisma.message.findFirst({
          where: { conversationId: conversation.id, isPrivate: false },
          orderBy: { createdAt: 'desc' },
          select: { senderType: true, createdAt: true },
        });
        if (lastMsg && lastMsg.senderType !== 'customer') {
          // Cronometro pausa neste ponto — usa createdAt da ultima msg como fim
          effectiveEnd = lastMsg.createdAt;
        }
      }

      // SLA v2 — horario comercial: usa calculateBusinessElapsedSec quando
      // businessHoursStart/End configurados, senao elapsed puro.
      const elapsedSec = calculateBusinessElapsedSec(
        conversation.createdAt,
        effectiveEnd,
        policy
      );

      // first_response: ainda nao houve primeira resposta e estourou o prazo
      if (
        !conversation.firstResponseAt &&
        elapsedSec > policy.firstResponseMin * 60
      ) {
        const created = await this.createBreachIfMissing(
          conversation.id,
          conversation.accountId,
          policy,
          'first_response',
          new Date(conversation.createdAt.getTime() + policy.firstResponseMin * 60_000),
          now
        );
        if (created) detected += 1;
      }

      // resolution: nao esta resolvida e estourou o prazo
      if (
        conversation.status !== 'resolved' &&
        elapsedSec > policy.resolutionMin * 60
      ) {
        const created = await this.createBreachIfMissing(
          conversation.id,
          conversation.accountId,
          policy,
          'resolution',
          new Date(conversation.createdAt.getTime() + policy.resolutionMin * 60_000),
          now
        );
        if (created) detected += 1;
      }
    }

    if (detected > 0) {
      logger.info('[sla] checkBreaches detected new breaches', { detected });
    }

    return { detected };
  }

  /**
   * Helper interno: cria um SLABreach se ainda nao existir um do mesmo
   * tipo para a conversation. Retorna true quando criou.
   */
  private async createBreachIfMissing(
    conversationId: string,
    accountId: string,
    policy: SLAPolicy,
    breachType: BreachType,
    expectedAt: Date,
    breachedAt: Date
  ): Promise<boolean> {
    // CRON-002: confiamos no unique @@unique([conversationId, breachType])
    // para evitar duplicacao em multi-replica. O check-then-act
    // (findFirst + create) tinha race condition: duas instancias
    // poderiam passar o findFirst e criar dois breaches identicos,
    // disparando webhook sla.breached duplicado.
    let breach;
    try {
      breach = await prisma.sLABreach.create({
        data: {
          conversationId,
          slaPolicyId: policy.id,
          breachType,
          expectedAt,
          breachedAt,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Outra replica criou primeiro — nao e erro, so nao criamos.
        return false;
      }
      throw err;
    }

    logger.warn('[sla] breach detected', {
      accountId,
      conversationId,
      policyId: policy.id,
      breachType,
      breachId: breach.id,
    });

    const payload = {
      breachId: breach.id,
      conversationId,
      slaPolicyId: policy.id,
      policyName: policy.name,
      breachType,
      expectedAt: expectedAt.toISOString(),
      breachedAt: breachedAt.toISOString(),
    };

    // Audit event
    await eventService.create({
      accountId,
      eventType: 'sla.breached',
      entityType: 'conversation',
      entityId: conversationId,
      payload,
    });

    // Webhook outbound (fire-and-forget; nao quebra a deteccao se falhar)
    try {
      await webhookOutboundService.emit(accountId, 'sla.breached', payload);
    } catch (err) {
      logger.error(
        '[sla] failed to emit sla.breached webhook',
        err instanceof Error ? err : new Error(String(err)),
        { accountId, conversationId, breachId: breach.id }
      );
    }

    return true;
  }

  // ============================================
  // Consultas e bookkeeping de breaches
  // ============================================

  /**
   * Lista breaches de uma conversation (escopada por accountId via join).
   */
  async getBreachesByConversation(
    conversationId: string,
    accountId: string
  ): Promise<SLABreach[]> {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { id: true },
    });

    if (!conversation) {
      throw new NotFoundError('Conversation');
    }

    return prisma.sLABreach.findMany({
      where: { conversationId },
      orderBy: { breachedAt: 'desc' },
    });
  }

  // ============================================
  // SLA v2 — Dashboard
  // ============================================

  /**
   * Agregacao para dashboard SLA. Calcula:
   *   - totalConversations / resolvedWithinSla
   *   - breachedFirstResponse / breachedResolution
   *   - avgFirstResponseSec / avgResolutionSec
   *   - outcomes: distribuicao por outcome
   *   - csatAvg / csatResponseRate (ignora null)
   *   - byAgent: ranking de agentes
   *   - aiVsHuman: comparativo IA vs Humano
   *
   * Usa ConversationCycle como fonte de verdade — cada ciclo open->resolved
   * conta. Reaberturas geram ciclos novos, preservando o historico.
   */
  async getDashboard(
    accountId: string,
    filters: { fromDate: Date; toDate: Date }
  ): Promise<{
    totalConversations: number;
    resolvedWithinSla: number;
    breachedFirstResponse: number;
    breachedResolution: number;
    avgFirstResponseSec: number | null;
    avgResolutionSec: number | null;
    outcomes: Record<string, number>;
    csatAvg: number | null;
    csatResponseRate: number;
    byAgent: Array<{
      userId: string;
      name: string;
      resolved: number;
      csatAvg: number | null;
      breaches: number;
    }>;
    aiVsHuman: {
      ai: { resolved: number; csat: number | null; breaches: number };
      human: { resolved: number; csat: number | null; breaches: number };
    };
  }> {
    const { fromDate, toDate } = filters;
    if (!(fromDate instanceof Date) || !(toDate instanceof Date)) {
      throw new ValidationError('fromDate e toDate sao obrigatorios');
    }
    if (fromDate > toDate) {
      throw new ValidationError('fromDate nao pode ser maior que toDate');
    }

    const cycles = await prisma.conversationCycle.findMany({
      where: {
        accountId,
        OR: [
          { openedAt: { gte: fromDate, lte: toDate } },
          { resolvedAt: { gte: fromDate, lte: toDate } },
        ],
      },
      select: {
        id: true,
        conversationId: true,
        openedAt: true,
        resolvedAt: true,
        resolvedBy: true,
        resolvedByUserId: true,
        firstResponseAt: true,
        outcome: true,
        customerCsat: true,
        csatRequested: true,
        csatSentAt: true,
        slaBreached: true,
        durationSec: true,
      },
    });

    // Lookup de breaches por conversation (filtrados pelo periodo)
    const conversationIds = Array.from(new Set(cycles.map((c) => c.conversationId)));
    const breaches = conversationIds.length
      ? await prisma.sLABreach.findMany({
          where: {
            conversationId: { in: conversationIds },
            breachedAt: { gte: fromDate, lte: toDate },
          },
          select: { conversationId: true, breachType: true },
        })
      : [];

    const breachedFirstResponse = breaches.filter(
      (b) => b.breachType === 'first_response'
    ).length;
    const breachedResolution = breaches.filter(
      (b) => b.breachType === 'resolution'
    ).length;
    const breachedConvIds = new Set(breaches.map((b) => b.conversationId));

    const totalConversations = conversationIds.length;
    const resolvedCycles = cycles.filter((c) => c.resolvedAt);
    const resolvedWithinSla = resolvedCycles.filter(
      (c) => !c.slaBreached && !breachedConvIds.has(c.conversationId)
    ).length;

    // Durations
    const frtSamples: number[] = [];
    const resolutionSamples: number[] = [];
    for (const c of cycles) {
      if (c.firstResponseAt) {
        frtSamples.push(
          Math.max(0, Math.floor((c.firstResponseAt.getTime() - c.openedAt.getTime()) / 1000))
        );
      }
      if (c.resolvedAt) {
        const dur =
          c.durationSec ??
          Math.max(0, Math.floor((c.resolvedAt.getTime() - c.openedAt.getTime()) / 1000));
        resolutionSamples.push(dur);
      }
    }
    const avg = (arr: number[]): number | null =>
      arr.length === 0
        ? null
        : Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100;

    // Outcomes
    const outcomes: Record<string, number> = {};
    for (const c of cycles) {
      if (!c.outcome) continue;
      outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1;
    }

    // CSAT — ignora null (so conta resposta efetiva). csatResponseRate = respondidos / pedidos
    const csatValues = cycles
      .map((c) => c.customerCsat)
      .filter((v): v is number => v !== null && v !== undefined);
    const csatAvg = avg(csatValues);
    const csatRequestedCount = cycles.filter((c) => c.csatSentAt).length;
    const csatResponseRate =
      csatRequestedCount === 0
        ? 0
        : Math.round((csatValues.length / csatRequestedCount) * 1000) / 1000;

    // By agent — apenas ciclos resolvidos por humano com resolvedByUserId
    const agentBuckets = new Map<
      string,
      { resolved: number; csatSum: number; csatCount: number; breaches: number }
    >();
    for (const c of cycles) {
      if (!c.resolvedAt || c.resolvedBy !== 'human' || !c.resolvedByUserId) continue;
      const bucket = agentBuckets.get(c.resolvedByUserId) ?? {
        resolved: 0,
        csatSum: 0,
        csatCount: 0,
        breaches: 0,
      };
      bucket.resolved += 1;
      if (c.customerCsat != null) {
        bucket.csatSum += c.customerCsat;
        bucket.csatCount += 1;
      }
      if (c.slaBreached || breachedConvIds.has(c.conversationId)) {
        bucket.breaches += 1;
      }
      agentBuckets.set(c.resolvedByUserId, bucket);
    }
    const userIds = Array.from(agentBuckets.keys());
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds }, accountId },
          select: { id: true, nome: true, email: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u.nome ?? u.email]));
    const byAgent = userIds
      .map((uid) => {
        const b = agentBuckets.get(uid)!;
        return {
          userId: uid,
          name: userMap.get(uid) ?? 'Desconhecido',
          resolved: b.resolved,
          csatAvg: b.csatCount === 0 ? null : Math.round((b.csatSum / b.csatCount) * 100) / 100,
          breaches: b.breaches,
        };
      })
      .sort((a, b) => b.resolved - a.resolved);

    // AI vs Human
    const aiCycles = cycles.filter((c) => c.resolvedAt && c.resolvedBy === 'ai');
    const humanCycles = cycles.filter((c) => c.resolvedAt && c.resolvedBy === 'human');
    const csatOf = (arr: typeof cycles): number | null => {
      const vals = arr.map((c) => c.customerCsat).filter((v): v is number => v != null);
      return vals.length === 0 ? null : Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100;
    };
    const breachesOf = (arr: typeof cycles): number =>
      arr.filter((c) => c.slaBreached || breachedConvIds.has(c.conversationId)).length;

    return {
      totalConversations,
      resolvedWithinSla,
      breachedFirstResponse,
      breachedResolution,
      avgFirstResponseSec: avg(frtSamples),
      avgResolutionSec: avg(resolutionSamples),
      outcomes,
      csatAvg,
      csatResponseRate,
      byAgent,
      aiVsHuman: {
        ai: {
          resolved: aiCycles.length,
          csat: csatOf(aiCycles),
          breaches: breachesOf(aiCycles),
        },
        human: {
          resolved: humanCycles.length,
          csat: csatOf(humanCycles),
          breaches: breachesOf(humanCycles),
        },
      },
    };
  }

  /**
   * Marca um breach como notificado (registra notifiedAt = now).
   * Escopado por accountId via join em conversation para evitar
   * que um tenant marque breach de outro tenant.
   */
  async markBreachNotified(breachId: string, accountId: string): Promise<SLABreach> {
    const breach = await prisma.sLABreach.findFirst({
      where: {
        id: breachId,
        conversation: { accountId },
      },
      select: { id: true },
    });

    if (!breach) {
      throw new NotFoundError('SLA breach');
    }

    return prisma.sLABreach.update({
      where: { id: breach.id },
      data: { notifiedAt: new Date() },
    });
  }
}

export const slaService = new SLAService();
