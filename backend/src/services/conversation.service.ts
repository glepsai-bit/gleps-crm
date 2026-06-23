import type { Conversation, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ValidationError } from '../utils/errors';
import { eventService } from './event.service';
import { logger } from '../utils/logger';
import { emitConversationUpdated, emitConversationAssigned } from '../socket';

/**
 * Wrapper defensivo: o Socket.IO pode não estar inicializado em testes
 * unitários que importam o service direto. Logamos em debug e seguimos.
 */
function safeEmitUpdated(accountId: string, id: string, conv: Conversation): void {
  try {
    emitConversationUpdated(accountId, id, conv);
  } catch (err) {
    logger.debug('[conversation] socket emit conversation:updated falhou', {
      conversationId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function safeEmitAssigned(accountId: string, id: string, assignee: unknown): void {
  try {
    emitConversationAssigned(accountId, id, assignee);
  } catch (err) {
    logger.debug('[conversation] socket emit conversation:assigned falhou', {
      conversationId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ============================================
// Types
// ============================================

export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'snoozed';
export type ConversationPriority = 'urgent' | 'high' | 'medium' | 'low';
export type ConversationResolvedBy = 'ai' | 'human' | 'timeout';

export interface ListConversationFilters {
  status?: ConversationStatus | string;
  assigneeId?: string | null;
  teamId?: string | null;
  inboxId?: string;
  labelId?: string;
  priority?: ConversationPriority | string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface GetConversationInclude {
  messages?: boolean;
  participants?: boolean;
  labels?: boolean;
}

export interface CreateConversationInput {
  inboxId: string;
  contactId?: string | null;
  externalId?: string | null;
  priority?: ConversationPriority;
  customAttributes?: Record<string, unknown>;
}

export interface TransferConversationInput {
  to: 'agent' | 'team';
  targetId: string | null;
  fromUserId: string;
  note?: string;
}

export interface ResolveConversationInput {
  resolvedBy: ConversationResolvedBy;
  userId: string;
}

export interface FindOrCreateForCustomerInput {
  externalId: string;
  contactId?: string | null;
  contactPhone?: string | null;
  contactName?: string | null;
}

const ALLOWED_STATUSES: ConversationStatus[] = ['open', 'pending', 'resolved', 'snoozed'];
const ALLOWED_PRIORITIES: ConversationPriority[] = ['urgent', 'high', 'medium', 'low'];

// ============================================
// Service
// ============================================

class ConversationService {
  // ============================================
  // list
  // ============================================

  async list(
    accountId: string,
    filters: ListConversationFilters = {}
  ): Promise<{ data: Conversation[]; total: number }> {
    const where: Prisma.ConversationWhereInput = { accountId };

    if (filters.status) where.status = filters.status;
    if (filters.priority) where.priority = filters.priority;
    if (filters.inboxId) where.inboxId = filters.inboxId;

    if (filters.assigneeId !== undefined) {
      where.assigneeId = filters.assigneeId === null ? null : filters.assigneeId;
    }
    if (filters.teamId !== undefined) {
      where.teamId = filters.teamId === null ? null : filters.teamId;
    }

    if (filters.labelId) {
      where.labels = { some: { tagId: filters.labelId } };
    }

    if (filters.search && filters.search.trim().length > 0) {
      const term = filters.search.trim();
      where.OR = [
        { externalId: { contains: term, mode: 'insensitive' } },
        { contact: { nome: { contains: term, mode: 'insensitive' } } },
        { contact: { telefone: { contains: term, mode: 'insensitive' } } },
        { contact: { email: { contains: term, mode: 'insensitive' } } },
      ];
    }

    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const [data, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          contact: { select: { id: true, nome: true, telefone: true, email: true } },
          inbox: { select: { id: true, name: true, channelType: true } },
          assignee: { select: { id: true, nome: true, email: true } },
          team: { select: { id: true, name: true } },
          labels: { include: { tag: true } },
        },
      }),
      prisma.conversation.count({ where }),
    ]);

    return { data, total };
  }

  // ============================================
  // get
  // ============================================

  async get(
    id: string,
    accountId: string,
    include: GetConversationInclude = {}
  ): Promise<Conversation> {
    const conversation = await prisma.conversation.findFirst({
      where: { id, accountId },
      include: {
        contact: { select: { id: true, nome: true, telefone: true, email: true } },
        inbox: { select: { id: true, name: true, channelType: true } },
        assignee: { select: { id: true, nome: true, email: true } },
        team: { select: { id: true, name: true } },
        messages: include.messages
          ? {
              orderBy: { createdAt: 'asc' },
              include: { attachments: true },
            }
          : false,
        participants: include.participants
          ? { include: { user: { select: { id: true, nome: true, email: true } } } }
          : false,
        labels: include.labels ? { include: { tag: true } } : false,
      },
    });

    if (!conversation) throw new NotFoundError('Conversa');

    return conversation as Conversation;
  }

  // ============================================
  // create
  // ============================================

  async create(accountId: string, input: CreateConversationInput): Promise<Conversation> {
    if (!input.inboxId) {
      throw new ValidationError('inboxId é obrigatório');
    }

    // Garante que o inbox pertence à conta
    const inbox = await prisma.inbox.findFirst({
      where: { id: input.inboxId, accountId },
      select: { id: true },
    });
    if (!inbox) throw new NotFoundError('Inbox');

    if (input.contactId) {
      const contact = await prisma.contact.findFirst({
        where: { id: input.contactId, accountId },
        select: { id: true },
      });
      if (!contact) throw new NotFoundError('Contato');
    }

    if (input.priority && !ALLOWED_PRIORITIES.includes(input.priority)) {
      throw new ValidationError(`Prioridade inválida: ${input.priority}`);
    }

    const conversation = await prisma.conversation.create({
      data: {
        accountId,
        inboxId: input.inboxId,
        contactId: input.contactId ?? null,
        externalId: input.externalId ?? null,
        priority: input.priority ?? 'medium',
        customAttributes: (input.customAttributes ?? {}) as any,
        status: 'open',
      },
    });

    await eventService.create({
      accountId,
      eventType: 'conversation.created',
      actorType: 'system',
      entityType: 'conversation',
      entityId: conversation.id,
      payload: {
        inboxId: input.inboxId,
        contactId: input.contactId ?? null,
        externalId: input.externalId ?? null,
      },
    });

    return conversation;
  }

  // ============================================
  // updateStatus
  // ============================================

  async updateStatus(
    id: string,
    accountId: string,
    status: ConversationStatus | string,
    userId: string
  ): Promise<Conversation> {
    if (!ALLOWED_STATUSES.includes(status as ConversationStatus)) {
      throw new ValidationError(`Status inválido: ${status}`);
    }

    const existing = await this.requireConversation(id, accountId);

    const data: Prisma.ConversationUpdateInput = { status };

    if (status === 'resolved' && !existing.resolvedAt) {
      data.resolvedAt = new Date();
      data.resolvedBy = 'human';
    }
    if (status !== 'snoozed' && existing.snoozedUntil) {
      data.snoozedUntil = null;
    }
    if (status === 'open' && existing.resolvedAt) {
      data.resolvedAt = null;
      data.resolvedBy = null;
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data,
    });

    await eventService.create({
      accountId,
      eventType: 'conversation.status_changed',
      actorType: 'user',
      actorId: userId,
      entityType: 'conversation',
      entityId: id,
      payload: { from: existing.status, to: status },
    });

    safeEmitUpdated(accountId, id, updated);

    return updated;
  }

  // ============================================
  // updatePriority
  // ============================================

  async updatePriority(
    id: string,
    accountId: string,
    priority: ConversationPriority | string,
    userId: string
  ): Promise<Conversation> {
    if (!ALLOWED_PRIORITIES.includes(priority as ConversationPriority)) {
      throw new ValidationError(`Prioridade inválida: ${priority}`);
    }

    const existing = await this.requireConversation(id, accountId);

    const updated = await prisma.conversation.update({
      where: { id },
      data: { priority },
    });

    await eventService.create({
      accountId,
      eventType: 'conversation.priority_changed',
      actorType: 'user',
      actorId: userId,
      entityType: 'conversation',
      entityId: id,
      payload: { from: existing.priority, to: priority },
    });

    safeEmitUpdated(accountId, id, updated);

    return updated;
  }

  // ============================================
  // assign (agente)
  // ============================================

  async assign(
    id: string,
    accountId: string,
    assigneeId: string | null,
    byUserId: string
  ): Promise<Conversation> {
    const existing = await this.requireConversation(id, accountId);

    if (assigneeId) {
      const user = await prisma.user.findFirst({
        where: { id: assigneeId, accountId },
        select: { id: true },
      });
      if (!user) throw new NotFoundError('Agente');
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data: { assigneeId },
    });

    await eventService.create({
      accountId,
      eventType: 'conversation.assigned',
      actorType: 'user',
      actorId: byUserId,
      entityType: 'conversation',
      entityId: id,
      payload: {
        from: existing.assigneeId,
        to: assigneeId,
      },
    });

    safeEmitAssigned(accountId, id, { type: 'agent', assigneeId });
    safeEmitUpdated(accountId, id, updated);

    return updated;
  }

  // ============================================
  // assignToTeam
  // ============================================

  async assignToTeam(
    id: string,
    accountId: string,
    teamId: string | null,
    byUserId: string
  ): Promise<Conversation> {
    const existing = await this.requireConversation(id, accountId);

    if (teamId) {
      const team = await prisma.team.findFirst({
        where: { id: teamId, accountId },
        select: { id: true },
      });
      if (!team) throw new NotFoundError('Time');
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data: { teamId },
    });

    await eventService.create({
      accountId,
      eventType: 'conversation.team_assigned',
      actorType: 'user',
      actorId: byUserId,
      entityType: 'conversation',
      entityId: id,
      payload: {
        from: existing.teamId,
        to: teamId,
      },
    });

    safeEmitAssigned(accountId, id, { type: 'team', teamId });
    safeEmitUpdated(accountId, id, updated);

    return updated;
  }

  // ============================================
  // transfer
  // ============================================

  async transfer(
    id: string,
    accountId: string,
    input: TransferConversationInput
  ): Promise<Conversation> {
    if (input.to !== 'agent' && input.to !== 'team') {
      throw new ValidationError(`Tipo de transferência inválido: ${input.to}`);
    }

    const existing = await this.requireConversation(id, accountId);

    let updated: Conversation;

    if (input.to === 'agent') {
      if (input.targetId) {
        const user = await prisma.user.findFirst({
          where: { id: input.targetId, accountId },
          select: { id: true },
        });
        if (!user) throw new NotFoundError('Agente');
      }
      updated = await prisma.conversation.update({
        where: { id },
        data: { assigneeId: input.targetId },
      });
    } else {
      if (input.targetId) {
        const team = await prisma.team.findFirst({
          where: { id: input.targetId, accountId },
          select: { id: true },
        });
        if (!team) throw new NotFoundError('Time');
      }
      updated = await prisma.conversation.update({
        where: { id },
        data: { teamId: input.targetId },
      });
    }

    // Cria nota privada do sistema sobre a transferência (se houver nota)
    if (input.note && input.note.trim().length > 0) {
      await prisma.conversationNote.create({
        data: {
          conversationId: id,
          userId: input.fromUserId,
          content: input.note.trim(),
        },
      });
    }

    await eventService.create({
      accountId,
      eventType: 'conversation.transferred',
      actorType: 'user',
      actorId: input.fromUserId,
      entityType: 'conversation',
      entityId: id,
      payload: {
        to: input.to,
        targetId: input.targetId,
        fromAssigneeId: existing.assigneeId,
        fromTeamId: existing.teamId,
        note: input.note ?? null,
      },
    });

    safeEmitAssigned(accountId, id, { type: input.to, targetId: input.targetId });
    safeEmitUpdated(accountId, id, updated);

    return updated;
  }

  // ============================================
  // snooze
  // ============================================

  async snooze(
    id: string,
    accountId: string,
    until: Date,
    userId: string
  ): Promise<Conversation> {
    if (!(until instanceof Date) || isNaN(until.getTime())) {
      throw new ValidationError('Data de snooze inválida');
    }
    if (until.getTime() <= Date.now()) {
      throw new ValidationError('Snooze deve ser no futuro');
    }

    await this.requireConversation(id, accountId);

    const updated = await prisma.conversation.update({
      where: { id },
      data: {
        status: 'snoozed',
        snoozedUntil: until,
      },
    });

    await eventService.create({
      accountId,
      eventType: 'conversation.snoozed',
      actorType: 'user',
      actorId: userId,
      entityType: 'conversation',
      entityId: id,
      payload: { until: until.toISOString() },
    });

    safeEmitUpdated(accountId, id, updated);

    return updated;
  }

  // ============================================
  // resolve
  // ============================================

  async resolve(
    id: string,
    accountId: string,
    input: ResolveConversationInput
  ): Promise<Conversation> {
    if (input.resolvedBy !== 'ai' && input.resolvedBy !== 'human' && input.resolvedBy !== 'timeout') {
      throw new ValidationError(`resolvedBy inválido: ${input.resolvedBy}`);
    }

    const existing = await this.requireConversation(id, accountId);

    if (existing.status === 'resolved') {
      // idempotente: retorna sem reemitir evento
      return existing;
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data: {
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: input.resolvedBy,
        snoozedUntil: null,
      },
    });

    await eventService.create({
      accountId,
      eventType: 'conversation.resolved',
      actorType: input.resolvedBy === 'ai' ? 'agent_bot' : 'user',
      actorId: input.resolvedBy === 'ai' ? undefined : input.userId,
      entityType: 'conversation',
      entityId: id,
      payload: {
        resolvedBy: input.resolvedBy,
        userId: input.userId,
      },
    });

    // Emite também o status_changed pra UIs que escutam só esse canal
    await eventService.create({
      accountId,
      eventType: 'conversation.status_changed',
      actorType: input.resolvedBy === 'ai' ? 'agent_bot' : 'user',
      actorId: input.resolvedBy === 'ai' ? undefined : input.userId,
      entityType: 'conversation',
      entityId: id,
      payload: { from: existing.status, to: 'resolved' },
    });

    safeEmitUpdated(accountId, id, updated);

    return updated;
  }

  // ============================================
  // reopen
  // ============================================

  async reopen(id: string, accountId: string, userId: string): Promise<Conversation> {
    const existing = await this.requireConversation(id, accountId);

    if (existing.status === 'open') {
      return existing;
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data: {
        status: 'open',
        resolvedAt: null,
        resolvedBy: null,
        snoozedUntil: null,
      },
    });

    await eventService.create({
      accountId,
      eventType: 'conversation.reopened',
      actorType: 'user',
      actorId: userId,
      entityType: 'conversation',
      entityId: id,
      payload: { from: existing.status },
    });

    await eventService.create({
      accountId,
      eventType: 'conversation.status_changed',
      actorType: 'user',
      actorId: userId,
      entityType: 'conversation',
      entityId: id,
      payload: { from: existing.status, to: 'open' },
    });

    safeEmitUpdated(accountId, id, updated);

    return updated;
  }

  // ============================================
  // addLabel
  // ============================================

  async addLabel(
    id: string,
    accountId: string,
    tagId: string,
    userId: string
  ): Promise<Conversation> {
    await this.requireConversation(id, accountId);

    const tag = await prisma.tag.findFirst({
      where: { id: tagId, accountId },
      select: { id: true },
    });
    if (!tag) throw new NotFoundError('Tag');

    try {
      await prisma.conversationLabel.create({
        data: {
          conversationId: id,
          tagId,
        },
      });

      await eventService.create({
        accountId,
        eventType: 'conversation.label_added',
        actorType: 'user',
        actorId: userId,
        entityType: 'conversation',
        entityId: id,
        payload: { tagId },
      });
    } catch (err: any) {
      // Unique violation = já existe; ignora silenciosamente (idempotente)
      if (err?.code !== 'P2002') {
        throw err;
      }
    }

    return this.get(id, accountId, { labels: true });
  }

  // ============================================
  // removeLabel
  // ============================================

  async removeLabel(
    id: string,
    accountId: string,
    tagId: string,
    userId: string
  ): Promise<Conversation> {
    await this.requireConversation(id, accountId);

    const result = await prisma.conversationLabel.deleteMany({
      where: { conversationId: id, tagId },
    });

    if (result.count > 0) {
      await eventService.create({
        accountId,
        eventType: 'conversation.label_removed',
        actorType: 'user',
        actorId: userId,
        entityType: 'conversation',
        entityId: id,
        payload: { tagId },
      });
    }

    return this.get(id, accountId, { labels: true });
  }

  // ============================================
  // addParticipant
  // ============================================

  async addParticipant(
    id: string,
    accountId: string,
    userId: string,
    byUserId: string
  ): Promise<Conversation> {
    await this.requireConversation(id, accountId);

    const user = await prisma.user.findFirst({
      where: { id: userId, accountId },
      select: { id: true },
    });
    if (!user) throw new NotFoundError('Usuário');

    try {
      await prisma.conversationParticipant.create({
        data: {
          conversationId: id,
          userId,
        },
      });

      await eventService.create({
        accountId,
        eventType: 'conversation.participant_added',
        actorType: 'user',
        actorId: byUserId,
        entityType: 'conversation',
        entityId: id,
        payload: { userId },
      });
    } catch (err: any) {
      if (err?.code !== 'P2002') {
        throw err;
      }
    }

    return this.get(id, accountId, { participants: true });
  }

  // ============================================
  // removeParticipant
  // ============================================

  async removeParticipant(
    id: string,
    accountId: string,
    userId: string,
    byUserId: string
  ): Promise<Conversation> {
    await this.requireConversation(id, accountId);

    const result = await prisma.conversationParticipant.deleteMany({
      where: { conversationId: id, userId },
    });

    if (result.count > 0) {
      await eventService.create({
        accountId,
        eventType: 'conversation.participant_removed',
        actorType: 'user',
        actorId: byUserId,
        entityType: 'conversation',
        entityId: id,
        payload: { userId },
      });
    }

    return this.get(id, accountId, { participants: true });
  }

  // ============================================
  // setCustomAttributes
  // ============================================

  async setCustomAttributes(
    id: string,
    accountId: string,
    attrs: Record<string, unknown>,
    userId: string
  ): Promise<Conversation> {
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) {
      throw new ValidationError('customAttributes deve ser um objeto');
    }

    const existing = await this.requireConversation(id, accountId);
    const current = (existing.customAttributes as Record<string, unknown> | null) ?? {};
    const merged = { ...current, ...attrs };

    const updated = await prisma.conversation.update({
      where: { id },
      data: { customAttributes: merged as any },
    });

    await eventService.create({
      accountId,
      eventType: 'conversation.attributes_updated',
      actorType: 'user',
      actorId: userId,
      entityType: 'conversation',
      entityId: id,
      payload: { keys: Object.keys(attrs) },
    });

    return updated;
  }

  // ============================================
  // markAsRead
  // ============================================

  async markAsRead(id: string, accountId: string, userId: string): Promise<Conversation> {
    const existing = await this.requireConversation(id, accountId);

    if (existing.unreadCount === 0) {
      return existing;
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0 },
    });

    await eventService.create({
      accountId,
      eventType: 'conversation.read',
      actorType: 'user',
      actorId: userId,
      entityType: 'conversation',
      entityId: id,
      payload: { previousUnread: existing.unreadCount },
    });

    return updated;
  }

  // ============================================
  // incrementUnread
  // ============================================

  async incrementUnread(id: string, accountId: string): Promise<Conversation> {
    // Garante escopo de tenant
    await this.requireConversation(id, accountId);

    return prisma.conversation.update({
      where: { id },
      data: { unreadCount: { increment: 1 } },
    });
  }

  // ============================================
  // findByExternalId
  // ============================================

  async findByExternalId(
    accountId: string,
    inboxId: string,
    externalId: string
  ): Promise<Conversation | null> {
    if (!externalId) return null;

    return prisma.conversation.findFirst({
      where: { accountId, inboxId, externalId },
    });
  }

  // ============================================
  // findOrCreateForCustomer
  // ============================================

  async findOrCreateForCustomer(
    accountId: string,
    inboxId: string,
    input: FindOrCreateForCustomerInput
  ): Promise<Conversation> {
    if (!input.externalId) {
      throw new ValidationError('externalId é obrigatório');
    }

    // Garante que o inbox pertence à conta
    const inbox = await prisma.inbox.findFirst({
      where: { id: inboxId, accountId },
      select: { id: true },
    });
    if (!inbox) throw new NotFoundError('Inbox');

    // 1) Procura conversa existente por externalId (mais comum no fluxo de webhook)
    const existing = await prisma.conversation.findFirst({
      where: { accountId, inboxId, externalId: input.externalId },
    });

    if (existing) {
      // Se a conversa estava resolvida, reabre (paridade com Chatwoot create-or-update-v2)
      if (existing.status === 'resolved') {
        const reopened = await prisma.conversation.update({
          where: { id: existing.id },
          data: {
            status: 'open',
            resolvedAt: null,
            resolvedBy: null,
          },
        });

        await eventService.create({
          accountId,
          eventType: 'conversation.reopened',
          actorType: 'system',
          entityType: 'conversation',
          entityId: existing.id,
          payload: { reason: 'new_inbound_message', externalId: input.externalId },
        });

        return reopened;
      }
      return existing;
    }

    // 2) Resolve contato — usa contactId explícito, senão tenta achar por telefone, senão cria
    let resolvedContactId: string | null = input.contactId ?? null;

    if (!resolvedContactId && input.contactPhone) {
      const phoneContact = await prisma.contact.findFirst({
        where: { accountId, telefone: input.contactPhone },
        select: { id: true },
      });
      if (phoneContact) {
        resolvedContactId = phoneContact.id;
      } else {
        const created = await prisma.contact.create({
          data: {
            accountId,
            telefone: input.contactPhone,
            nome: input.contactName ?? null,
          },
          select: { id: true },
        });
        resolvedContactId = created.id;
        logger.info('[conversation] contato criado automaticamente', {
          accountId,
          contactId: resolvedContactId,
          phone: input.contactPhone,
        });
      }
    }

    if (resolvedContactId) {
      // Valida escopo
      const contact = await prisma.contact.findFirst({
        where: { id: resolvedContactId, accountId },
        select: { id: true },
      });
      if (!contact) throw new NotFoundError('Contato');
    }

    const conversation = await prisma.conversation.create({
      data: {
        accountId,
        inboxId,
        contactId: resolvedContactId,
        externalId: input.externalId,
        status: 'open',
        priority: 'medium',
      },
    });

    await eventService.create({
      accountId,
      eventType: 'conversation.created',
      actorType: 'system',
      entityType: 'conversation',
      entityId: conversation.id,
      payload: {
        inboxId,
        contactId: resolvedContactId,
        externalId: input.externalId,
        source: 'inbound',
      },
    });

    return conversation;
  }

  // ============================================
  // Helpers privados
  // ============================================

  private async requireConversation(id: string, accountId: string): Promise<Conversation> {
    const conversation = await prisma.conversation.findFirst({
      where: { id, accountId },
    });
    if (!conversation) throw new NotFoundError('Conversa');
    return conversation;
  }
}

export const conversationService = new ConversationService();
