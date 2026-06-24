import type { SLAPolicy, SLABreach } from '@prisma/client';
import { Prisma } from '@prisma/client';
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
}

export interface UpdatePolicyInput {
  name?: string;
  firstResponseMin?: number;
  resolutionMin?: number;
  businessHoursOnly?: boolean;
  active?: boolean;
}

export interface CheckBreachesResult {
  detected: number;
}

type BreachType = 'first_response' | 'resolution';

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
  async checkBreaches(): Promise<CheckBreachesResult> {
    const now = new Date();
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

      const createdAtMs = conversation.createdAt.getTime();
      const elapsedSec = Math.floor((now.getTime() - createdAtMs) / 1000);

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
          new Date(createdAtMs + policy.firstResponseMin * 60_000),
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
          new Date(createdAtMs + policy.resolutionMin * 60_000),
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
