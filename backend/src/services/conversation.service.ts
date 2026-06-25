import type { Conversation, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { eventService } from './event.service';
import { logger } from '../utils/logger';
import { emitConversationUpdated, emitConversationAssigned } from '../socket';
import { teamService } from './team.service';
import { conversationCycleService } from './conversation-cycle.service';

/**
 * Wrapper defensivo: o Socket.IO pode não estar inicializado em testes
 * unitários que importam o service direto. Logamos em debug e seguimos.
 *
 * BUG-MSG-GHOST (3a reincidencia): TODAS as mutations da Conversation usam
 * FULL_CONVERSATION_INCLUDE, que carrega `messages: { take: 1, orderBy desc }`.
 * Esse objeto é repassado a este emit; no frontend, `ConversationThread.
 * onConversationUpdated` faz spread `{ ...old, ...partial }` e qualquer
 * `partial.messages` (mesmo length=1) SOBRESCREVE a lista completa cacheada
 * (8+ mensagens viram 1, ate o proximo polling/F5 restaurar).
 *
 * Fix: REMOVER `messages` (e demais relacoes pesadas que nao mudam por
 * conversation:updated) antes de emitir. O thread recebe mensagens novas via
 * `message:created` (handler dedicado, com merge+dedup); este broadcast
 * carrega APENAS campos escalares (status/priority/assignee/team/customAttrs).
 */
function stripHeavyRelationsForBroadcast(conv: Conversation): Conversation {
  // Cast intencional: conv vem com `messages?: Message[]` no shape do Prisma
  // include, mas a interface base do Conversation nao expoe (so o include
  // tipa via generics). Removemos a chave via destructuring + cast pra
  // garantir que o JSON.stringify do socket nao carregue o array.
  const { messages: _m, ...rest } = conv as Conversation & {
    messages?: unknown;
  };
  return rest as Conversation;
}

function safeEmitUpdated(accountId: string, id: string, conv: Conversation): void {
  try {
    emitConversationUpdated(accountId, id, stripHeavyRelationsForBroadcast(conv));
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

/**
 * Actor RBAC context — usado por list() e mutations para escopar
 * acesso de agentes apenas a conversas que lhes pertencem.
 * Quando omitido (chamadas internas/system/webhooks), nenhum filtro extra é aplicado.
 */
export type ConversationActorRole = 'super_admin' | 'admin' | 'agent';

export interface ConversationActor {
  userId: string;
  role: ConversationActorRole;
}

const ALLOWED_STATUSES: ConversationStatus[] = ['open', 'pending', 'resolved', 'snoozed'];
const ALLOWED_PRIORITIES: ConversationPriority[] = ['urgent', 'high', 'medium', 'low'];

/**
 * Include padrão usado em TODAS as mutations para garantir que o cliente
 * receba sempre o mesmo shape (assignee/team/contact/inbox/labels), evitando
 * `undefined` no front após assign/transfer/resolve/etc.
 */
const FULL_CONVERSATION_INCLUDE = {
  contact: { select: { id: true, nome: true, telefone: true, email: true } },
  inbox: { select: { id: true, name: true, channelType: true } },
  assignee: { select: { id: true, nome: true, email: true } },
  team: { select: { id: true, name: true } },
  labels: { include: { tag: true } },
  // BUG-FIX: incluir a última mensagem permite que a ConversationList do
  // /admin/chat mostre snippet real ("Olá, bom dia") em vez de
  // "Sem mensagens ainda" mesmo com mensagens persistidas. Limitamos a 1 pra
  // não inflar payload da lista (50 conversas × N mensagens cada seria pesado).
  messages: {
    orderBy: { createdAt: 'desc' } as const,
    take: 1,
  },
} satisfies Prisma.ConversationInclude;

// ============================================
// Service
// ============================================

class ConversationService {
  // ============================================
  // list
  // ============================================

  async list(
    accountId: string,
    filters: ListConversationFilters = {},
    actor?: ConversationActor
  ): Promise<{ data: Conversation[]; total: number }> {
    const where: Prisma.ConversationWhereInput = { accountId };

    if (filters.status) {
      if (!ALLOWED_STATUSES.includes(filters.status as ConversationStatus)) {
        throw new ValidationError(`Status inválido: ${filters.status}`);
      }
      where.status = filters.status;
    }
    if (filters.priority) {
      if (!ALLOWED_PRIORITIES.includes(filters.priority as ConversationPriority)) {
        throw new ValidationError(`Prioridade inválida: ${filters.priority}`);
      }
      where.priority = filters.priority;
    }
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

    // RBAC: agente só enxerga conversas onde é assignee, está em um time
    // dono da conversa, ou foi adicionado como participante (CHAT-AUTH-H1).
    // super_admin/admin (ou chamadas internas sem actor) veem tudo da conta.
    if (actor && actor.role === 'agent') {
      const teamIds = await prisma.teamMember
        .findMany({
          where: { userId: actor.userId },
          select: { teamId: true },
        })
        .then((rows) => rows.map((r) => r.teamId));

      const accessOr: Prisma.ConversationWhereInput[] = [
        { assigneeId: actor.userId },
        { participants: { some: { userId: actor.userId } } },
      ];
      if (teamIds.length > 0) {
        accessOr.push({ teamId: { in: teamIds } });
      }

      // Combina com qualquer OR existente (ex.: busca) via AND.
      if (where.OR) {
        const existingOr = where.OR;
        delete where.OR;
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
          { OR: existingOr },
          { OR: accessOr },
        ];
      } else {
        where.OR = accessOr;
      }
    }

    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const [data, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip: offset,
        include: FULL_CONVERSATION_INCLUDE,
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
    include: GetConversationInclude = {},
    actor?: ConversationActor
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

    // RBAC: agente só pode ler conversa que lhe pertence (CHAT-AUTH-H1).
    // Faz fetch on-demand de participants/team quando precisa validar.
    if (actor && actor.role === 'agent') {
      await this.assertAgentCanAccess(conversation as Conversation, actor.userId);
    }

    // BUG-MSG-GHOST (fail-safe): shape invariante para o FE — sempre incluir
    // as chaves `messages`, `labels`, `participants` como array (vazio quando
    // nao pedido) ao inves de omitir. Isso elimina toda a classe de bug onde
    // qualquer setQueryData/merge no React Query pode acabar comparando
    // `partial.messages === undefined` (chave inexistente) vs
    // `partial.messages === []` (vazio explicito) — comportamentos diferentes
    // que produziam piscar e thread vazia.
    const out = conversation as Conversation & {
      messages?: unknown;
      labels?: unknown;
      participants?: unknown;
    };
    if (!include.messages) out.messages = [] as unknown as never;
    if (!include.labels) out.labels = [] as unknown as never;
    if (!include.participants) out.participants = [] as unknown as never;

    return out as Conversation;
  }

  // ============================================
  // ensureConversationAccess — guard reutilizável
  // ============================================

  /**
   * CHAT-AUTH-H1: middleware-helper. Garante que o actor pode acessar a conversa.
   * - super_admin/admin: passam direto
   * - agent: precisa ser assignee, estar no time da conversa, ou ser participante
   *
   * Deve ser chamado pelos controllers ANTES de qualquer mutation
   * (assign/transfer/resolve/reopen/labels/participants/custom-attributes/...).
   */
  async ensureConversationAccess(
    id: string,
    accountId: string,
    actor: ConversationActor
  ): Promise<Conversation> {
    const conversation = await prisma.conversation.findFirst({
      where: { id, accountId },
      include: {
        participants: { select: { userId: true } },
        team: { select: { id: true, members: { select: { userId: true } } } },
      },
    });
    if (!conversation) throw new NotFoundError('Conversa');

    if (actor.role !== 'agent') return conversation as Conversation;

    await this.assertAgentCanAccess(conversation, actor.userId);
    return conversation as Conversation;
  }

  /**
   * Lança ForbiddenError se o agente não tem acesso à conversa.
   * Aceita conversa com ou sem includes; faz fetch sob demanda quando faltar.
   */
  private async assertAgentCanAccess(
    conversation: Conversation & {
      assigneeId?: string | null;
      teamId?: string | null;
      participants?: Array<{ userId: string }>;
      team?: { members?: Array<{ userId: string }> } | null;
    },
    userId: string
  ): Promise<void> {
    if (conversation.assigneeId === userId) return;

    const participants =
      conversation.participants ??
      (await prisma.conversationParticipant.findMany({
        where: { conversationId: conversation.id },
        select: { userId: true },
      }));
    if (participants.some((p) => p.userId === userId)) return;

    if (conversation.teamId) {
      const teamMembers =
        conversation.team?.members ??
        (await prisma.teamMember.findMany({
          where: { teamId: conversation.teamId },
          select: { userId: true },
        }));
      if (teamMembers.some((m) => m.userId === userId)) return;
    }

    throw new ForbiddenError('Você não tem acesso a esta conversa');
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

    // Garante unicidade de (accountId, inboxId, externalId) — quando informado.
    // Como o schema ainda não tem @@unique (SE-H1), validamos explicitamente
    // para não criar conversas duplicadas via create() direto. O fluxo de
    // webhook usa findOrCreateForCustomer() que já trata corrida.
    if (input.externalId) {
      const duplicate = await prisma.conversation.findFirst({
        where: {
          accountId,
          inboxId: input.inboxId,
          externalId: input.externalId,
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new ValidationError(
          `Já existe uma conversa neste inbox com externalId "${input.externalId}"`
        );
      }
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

    // CYCLE-WIRE: abre o primeiro ConversationCycle da conversa. Failure
    // aqui não pode abortar a criação — log e segue (best-effort).
    try {
      await conversationCycleService.openCycle(conversation.id, accountId);
    } catch (err) {
      logger.warn('[conversation] openCycle inicial falhou', {
        conversationId: conversation.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

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
    // LIFECYCLE-BUG-2: reabrir conversa (status=open) precisa limpar o
    // circuit breaker do IA (human_active/human_intervened). Sem isso, depois
    // que o humano interveio uma vez, o IA fica bloqueado eternamente mesmo
    // quando a conversa é reaberta — n8n perde capacidade de responder.
    if (status === 'open') {
      const currentAttrs =
        (existing.customAttributes as Record<string, unknown> | null) ?? {};
      data.customAttributes = {
        ...currentAttrs,
        human_active: null,
        human_intervened: null,
      } as any;
    }

    const updated = await prisma.conversation.update({
      where: { id },
      data,
      include: FULL_CONVERSATION_INCLUDE,
    });

    // CYCLE-WIRE em updateStatus:
    // - resolved (e antes não era): fecha ciclo ativo
    // - open (e antes era resolved): abre ciclo novo
    // pending/snoozed não mexem em ciclo (cliente continua aberto).
    try {
      if (status === 'resolved' && existing.status !== 'resolved') {
        await conversationCycleService.closeCycle(id, accountId, {
          resolvedBy: 'human',
          resolvedByUserId: userId,
        });
      } else if (status === 'open' && existing.status === 'resolved') {
        await conversationCycleService.openCycle(id, accountId);
      }
    } catch (err) {
      logger.warn('[conversation] cycle wire em updateStatus falhou', {
        conversationId: id,
        from: existing.status,
        to: status,
        error: err instanceof Error ? err.message : String(err),
      });
    }

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
      include: FULL_CONVERSATION_INCLUDE,
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
      include: FULL_CONVERSATION_INCLUDE,
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
      include: FULL_CONVERSATION_INCLUDE,
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

    // Valida target ANTES da transação para evitar abrir tx só pra rollback.
    if (input.to === 'agent' && input.targetId) {
      const user = await prisma.user.findFirst({
        where: { id: input.targetId, accountId },
        select: { id: true },
      });
      if (!user) throw new NotFoundError('Agente');
    } else if (input.to === 'team' && input.targetId) {
      const team = await prisma.team.findFirst({
        where: { id: input.targetId, accountId },
        select: { id: true },
      });
      if (!team) throw new NotFoundError('Time');
    }

    // Atomicidade: update da conversa + criação da nota acontecem na mesma
    // transação. Se a nota falhar, a transferência é desfeita — garantindo
    // que a trilha de auditoria seja consistente com o estado da conversa.
    const updated = await prisma.$transaction(async (tx) => {
      const conv =
        input.to === 'agent'
          ? await tx.conversation.update({
              where: { id },
              data: { assigneeId: input.targetId },
              include: FULL_CONVERSATION_INCLUDE,
            })
          : await tx.conversation.update({
              where: { id },
              data: { teamId: input.targetId },
              include: FULL_CONVERSATION_INCLUDE,
            });

      if (input.note && input.note.trim().length > 0) {
        await tx.conversationNote.create({
          data: {
            conversationId: id,
            userId: input.fromUserId,
            content: input.note.trim(),
          },
        });
      }

      return conv;
    });

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
      include: FULL_CONVERSATION_INCLUDE,
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

    const resolvedAt = new Date();
    const updated = await prisma.conversation.update({
      where: { id },
      data: {
        status: 'resolved',
        resolvedAt,
        resolvedBy: input.resolvedBy,
        snoozedUntil: null,
      },
      include: FULL_CONVERSATION_INCLUDE,
    });

    // CYCLE-WIRE: fecha o ciclo ativo com snapshot do estado atual e
    // resolvedBy/resolvedByUserId. Best-effort (não aborta resolve).
    try {
      await conversationCycleService.closeCycle(
        id,
        accountId,
        {
          resolvedBy: input.resolvedBy,
          resolvedByUserId: input.resolvedBy === 'ai' ? null : input.userId,
        },
        { resolvedAt }
      );
    } catch (err) {
      logger.warn('[conversation] closeCycle em resolve falhou', {
        conversationId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

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

    // LIFECYCLE-BUG-2: limpar circuit breaker do IA ao reabrir manualmente.
    // Sem isso, IA segue bloqueada mesmo após reopen explícito do humano.
    const currentAttrs =
      (existing.customAttributes as Record<string, unknown> | null) ?? {};
    const updated = await prisma.conversation.update({
      where: { id },
      data: {
        status: 'open',
        resolvedAt: null,
        resolvedBy: null,
        snoozedUntil: null,
        customAttributes: {
          ...currentAttrs,
          human_active: null,
          human_intervened: null,
        } as any,
      },
      include: FULL_CONVERSATION_INCLUDE,
    });

    // CYCLE-WIRE: reopen cria um NOVO ConversationCycle. O ciclo anterior
    // (já resolved) fica preservado pra histórico/métricas — é o ponto
    // central de Bug B. Best-effort: se falhar, log e segue.
    try {
      await conversationCycleService.openCycle(id, accountId);
    } catch (err) {
      logger.warn('[conversation] openCycle em reopen falhou', {
        conversationId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

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
    userId: string,
    actor?: ConversationActor
  ): Promise<Conversation> {
    // Precisamos do contactId pra espelhar a tag no LeadTag (CHAT-TAG-SYNC-1).
    const conversation = await this.requireConversation(id, accountId);

    const tag = await prisma.tag.findFirst({
      where: { id: tagId, accountId },
      select: { id: true, type: true, name: true, slug: true },
    });
    if (!tag) throw new NotFoundError('Tag');

    // Pré-carrega o nome do contato fora da transação (usado em TagHistory).
    let contactNome: string | null = null;
    if (conversation.contactId && tag.type === 'stage') {
      const ct = await prisma.contact.findFirst({
        where: { id: conversation.contactId, accountId },
        select: { nome: true },
      });
      contactNome = ct?.nome ?? null;
    }

    // CHAT-TAG-SYNC-ATOMIC: as duas escritas (ConversationLabel + LeadTag) precisam
    // ser atômicas. Antes ficavam fora de transação — se o espelhamento LeadTag
    // falhasse por algo diferente de P2002, a label da conversa já estava persistida
    // e o Kanban/contato ficavam dessincronizados. Pior pra stage tags: o applyTag
    // delete-then-create podia deixar o contato SEM nenhuma stage (deletes commit,
    // create falha). Agora ou tudo vai, ou tudo é revertido.
    let labelWasCreated = false;
    let mirroredLeadTagId: string | null = null;
    const removedStageTagIds: string[] = [];
    let removedStageTagsMeta: Array<{ tagId: string; tagName: string }> = [];

    try {
      await prisma.$transaction(async (tx) => {
        // 1) Cria a label da conversa (idempotente via P2002).
        try {
          await tx.conversationLabel.create({
            data: {
              conversationId: id,
              tagId,
            },
          });
          labelWasCreated = true;
        } catch (err: any) {
          if (err?.code !== 'P2002') throw err;
          // Já existia — segue para o mirror mesmo assim (pode estar dessincronizado).
        }

        // 2) Espelha no LeadTag — idem aos invariantes de contactService.applyTag,
        // mas inline e usando o mesmo `tx` pra garantir atomicidade.
        if (conversation.contactId) {
          if (tag.type === 'stage') {
            // Invariante "uma stage por contato": remove stage tags anteriores
            // dentro da MESMA transação. Se a criação abaixo falhar, esses deletes
            // são revertidos — não deixamos o contato órfão de stage.
            const existingStageTags = await tx.leadTag.findMany({
              where: {
                contactId: conversation.contactId,
                tag: { type: 'stage' },
                NOT: { tagId },
              },
              include: { tag: { select: { name: true } } },
            });

            for (const existing of existingStageTags) {
              await tx.leadTag.delete({ where: { id: existing.id } });
              removedStageTagIds.push(existing.tagId);
              removedStageTagsMeta.push({
                tagId: existing.tagId,
                tagName: existing.tag.name,
              });

              await tx.tagHistory.create({
                data: {
                  contactId: conversation.contactId,
                  tagId: existing.tagId,
                  action: 'removed',
                  actorType: 'user',
                  actorId: userId,
                  source: 'system',
                  tagName: existing.tag.name,
                  contactNome,
                },
              });
            }
          }

          // Cria o LeadTag (idempotente via P2002).
          try {
            const created = await tx.leadTag.create({
              data: {
                contactId: conversation.contactId,
                tagId,
                appliedByType: 'user',
                appliedById: userId,
                source: 'system',
              },
            });
            mirroredLeadTagId = created.id;

            if (tag.type === 'stage') {
              await tx.tagHistory.create({
                data: {
                  contactId: conversation.contactId,
                  tagId,
                  action: 'added',
                  actorType: 'user',
                  actorId: userId,
                  source: 'system',
                  tagName: tag.name,
                  contactNome,
                },
              });
            }
          } catch (err: any) {
            if (err?.code !== 'P2002') throw err;
            // Já aplicada — no-op idempotente.
          }
        }
      });
    } catch (err) {
      // Falha atômica: nada foi persistido. Loga e propaga para o caller saber.
      logger.warn('[conversation] addLabel atômico falhou — rollback aplicado', {
        conversationId: id,
        contactId: conversation.contactId,
        tagId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // Eventos de auditoria (fire-and-forget) — fora da transação por design do eventService.
    if (labelWasCreated) {
      await eventService.create({
        accountId,
        eventType: 'conversation.label_added',
        actorType: 'user',
        actorId: userId,
        entityType: 'conversation',
        entityId: id,
        payload: { tagId },
      });
    }

    if (conversation.contactId && tag.type === 'stage' && mirroredLeadTagId) {
      for (const removed of removedStageTagsMeta) {
        await eventService.create({
          accountId,
          eventType: 'lead.stage.changed',
          actorType: 'user',
          actorId: userId,
          entityType: 'contact',
          entityId: conversation.contactId,
          payload: {
            tagId: removed.tagId,
            tagName: removed.tagName,
            action: 'removed',
            source: 'system',
          },
        });
      }
      await eventService.create({
        accountId,
        eventType: 'lead.stage.changed',
        actorType: 'user',
        actorId: userId,
        entityType: 'contact',
        entityId: conversation.contactId,
        payload: { tagId, tagName: tag.name, source: 'system' },
      });
    }

    // CHAT-LABEL-IDEMPOTENT-3: repassa actor para o get() preservar RBAC do agente.
    // CHAT-LABEL-NO-SOCKET-EMIT-5: emite conversation:updated pra que outros tabs/agents
    // recebam a mudança em tempo real (assign/priority/snooze/resolve já fazem isso).
    const updated = await this.get(id, accountId, { labels: true }, actor);
    safeEmitUpdated(accountId, id, updated);
    return updated;
  }

  // ============================================
  // removeLabel
  // ============================================

  async removeLabel(
    id: string,
    accountId: string,
    tagId: string,
    userId: string,
    actor?: ConversationActor
  ): Promise<Conversation> {
    const conversation = await this.requireConversation(id, accountId);

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

      // CHAT-TAG-SYNC-1 (simetria): se for tag operacional, remove do LeadTag.
      // Stage tags NÃO são removidas automaticamente — remover unilateralmente
      // jogaria o contato pra fora de todas as colunas do Kanban, o que quebra
      // a UX (mover entre colunas precisa setar a nova stage; só remover é
      // ambíguo). Movimentação no Kanban segue sendo o canal de mudança de stage.
      if (conversation.contactId) {
        try {
          const tag = await prisma.tag.findFirst({
            where: { id: tagId, accountId },
            select: { type: true },
          });
          if (tag && tag.type === 'operational') {
            await prisma.leadTag.deleteMany({
              where: { contactId: conversation.contactId, tagId },
            });
          }
        } catch (err) {
          logger.warn('[conversation] falha ao espelhar removeLabel no LeadTag', {
            conversationId: id,
            contactId: conversation.contactId,
            tagId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // CHAT-LABEL-IDEMPOTENT-3 + CHAT-LABEL-NO-SOCKET-EMIT-5
    const updated = await this.get(id, accountId, { labels: true }, actor);
    safeEmitUpdated(accountId, id, updated);
    return updated;
  }

  // ============================================
  // addParticipant
  // ============================================

  async addParticipant(
    id: string,
    accountId: string,
    userId: string,
    byUserId: string,
    actor?: ConversationActor
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

    // CHAT-LABEL-IDEMPOTENT-3: repassa actor para preservar RBAC do agente.
    return this.get(id, accountId, { participants: true }, actor);
  }

  // ============================================
  // removeParticipant
  // ============================================

  async removeParticipant(
    id: string,
    accountId: string,
    userId: string,
    byUserId: string,
    actor?: ConversationActor
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

    // CHAT-LABEL-IDEMPOTENT-3: repassa actor para preservar RBAC do agente.
    return this.get(id, accountId, { participants: true }, actor);
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
      include: FULL_CONVERSATION_INCLUDE,
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
  // markHumanActive
  // ============================================

  /**
   * LIFECYCLE-BUG-4: aciona o circuit breaker do IA quando um agente humano
   * responde no fluxo nativo T-022 (POST /api/conversations/:id/messages).
   *
   * Equivalente ao bloco "HumanIntervention" do controller externo legado (REMOVED),
   * porém para conversas servidas pelo fluxo nativo — onde nada mais estava setando
   * `customAttributes.human_active=true`. Sem este flag, /integrations/chat
   * (consumido pelo n8n) não respeita o `checkAiCircuitBreaker` e a IA continua
   * respondendo livremente em paralelo ao humano.
   *
   * Idempotente: se já estiver true, retorna a conversa sem rebater update
   * nem emitir socket. Emite `conversation:updated` quando muda de estado para
   * que outras abas do operador reflitam o breaker em tempo real.
   */
  async markHumanActive(
    id: string,
    accountId: string,
    userId: string
  ): Promise<Conversation> {
    const existing = await this.requireConversation(id, accountId);
    const current =
      (existing.customAttributes as Record<string, unknown> | null) ?? {};

    if (current.human_active === true) {
      return existing;
    }

    const merged = {
      ...current,
      human_active: true,
      human_intervened: true,
      human_intervened_at: new Date().toISOString(),
    };

    const updated = await prisma.conversation.update({
      where: { id },
      data: { customAttributes: merged as any },
      include: FULL_CONVERSATION_INCLUDE,
    });

    await eventService.create({
      accountId,
      eventType: 'conversation.attributes_updated',
      actorType: 'user',
      actorId: userId,
      entityType: 'conversation',
      entityId: id,
      payload: {
        keys: ['human_active', 'human_intervened', 'human_intervened_at'],
        reason: 'agent_replied_native',
      },
    });

    safeEmitUpdated(accountId, id, updated);

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

    // Garante que o inbox pertence à conta. Precisamos do defaultTeamId pra
    // disparar round-robin automático ao criar conversa nova (CHAT-ACTIONS-A-1).
    const inbox = await prisma.inbox.findFirst({
      where: { id: inboxId, accountId },
      select: { id: true, defaultTeamId: true },
    });
    if (!inbox) throw new NotFoundError('Inbox');

    // 1) Procura conversa existente por externalId (mais comum no fluxo de webhook)
    const existing = await prisma.conversation.findFirst({
      where: { accountId, inboxId, externalId: input.externalId },
    });

    if (existing) {
      // BUG-5 (conversas órfãs): conversas criadas antes do hardening de
      // resolveOrCreateContact, ou em janelas raras onde o create do
      // contact falhou silenciosamente, podem ficar com contactId=null.
      // Quando o webhook trouxer telefone/nome novamente, backfillamos
      // best-effort SEM bloquear o fluxo de mensagem caso falhe. Isto
      // evita conversas anônimas que aparecem como "Sem nome" na UI
      // mesmo já tendo Contact correspondente na conta.
      if (!existing.contactId && (input.contactId || input.contactPhone)) {
        try {
          const backfilledContactId = await this.resolveOrCreateContact(
            accountId,
            input
          );
          if (backfilledContactId) {
            // Update atômico com guard de contactId atual nulo — se outra
            // execução concorrente já preencheu, updateMany devolve count:0
            // e respeitamos o que estiver lá (não sobrescreve).
            const result = await prisma.conversation.updateMany({
              where: { id: existing.id, accountId, contactId: null },
              data: { contactId: backfilledContactId },
            });
            if (result.count > 0) {
              existing.contactId = backfilledContactId;
              logger.info(
                '[conversation] backfill de contactId em conversa orfa',
                {
                  accountId,
                  conversationId: existing.id,
                  contactId: backfilledContactId,
                }
              );
            }
          }
        } catch (err) {
          logger.warn('[conversation] backfill de contactId falhou', {
            accountId,
            conversationId: existing.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return this.maybeReopen(existing, accountId, input.externalId);
    }

    // 2) Resolve contato — usa contactId explícito, senão tenta achar por telefone, senão cria
    const resolvedContactId = await this.resolveOrCreateContact(accountId, input);

    if (resolvedContactId) {
      // Valida escopo
      const contact = await prisma.contact.findFirst({
        where: { id: resolvedContactId, accountId },
        select: { id: true },
      });
      if (!contact) throw new NotFoundError('Contato');
    }

    // CHAT-ACTIONS-A-1 / FINDCREATE-ASSIGN-ATOMIC: round-robin é resolvido ANTES
    // da transação (read-only, sem efeito colateral), e o update de assignee é
    // executado DENTRO da mesma $transaction que cria a conversa. Antes, o update
    // ficava fora — um webhook paralelo entrando em maybeReopen ao mesmo tempo
    // podia clobberar customAttributes/status do outro fluxo. Agora ou tudo vai,
    // ou nada vai. Best-effort se mantém: falha do pickAssignee NÃO aborta o create.
    let preselectedAssignee: { id: string } | null = null;
    if (inbox.defaultTeamId) {
      try {
        const picked = await teamService.pickAssignee(inbox.defaultTeamId, accountId);
        if (picked) {
          preselectedAssignee = { id: picked.id };
        } else {
          logger.debug('[conversation] auto round-robin sem membros ativos — skip', {
            accountId,
            inboxId,
            teamId: inbox.defaultTeamId,
          });
        }
      } catch (assignErr) {
        // pickAssignee best-effort: erro aqui não pode abortar criação da conversa.
        logger.warn('[conversation] auto round-robin falhou — conversa seguirá sem assignee', {
          accountId,
          inboxId,
          teamId: inbox.defaultTeamId,
          error: assignErr instanceof Error ? assignErr.message : String(assignErr),
        });
      }
    }

    // H3 (CHAT findOrCreate race): tenta criar e, se houver corrida de webhooks
    // (3 mensagens em 1s podem chegar ao 'create' simultaneamente),
    // o catch P2002 ou um re-find dentro de transação retornam a conversa vencedora.
    // Como o schema ainda não tem @@unique([accountId, inboxId, externalId]) (SE-H1),
    // fazemos defense-in-depth: re-check sob lock pessimista via $transaction.
    try {
      // Retorna a conversa + flag explícita indicando se ela acabou de ser criada
      // nesta transação. Antes usávamos uma heurística baseada em createdAt vs
      // Date.now(), o que era frágil em VMs com clock skew ou GC pause longo.
      const { conversation, wasCreated, wasAssigned } = await prisma.$transaction(async (tx) => {
        const racingExisting = await tx.conversation.findFirst({
          where: { accountId, inboxId, externalId: input.externalId },
        });
        if (racingExisting) {
          return { conversation: racingExisting, wasCreated: false, wasAssigned: false };
        }

        const created = await tx.conversation.create({
          data: {
            accountId,
            inboxId,
            contactId: resolvedContactId,
            externalId: input.externalId,
            status: 'open',
            priority: 'medium',
            // Atribuição atômica: setamos no próprio create quando há assignee
            // pré-selecionado, evitando UPDATE separado que poderia colidir com
            // um maybeReopen paralelo de outro webhook.
            ...(preselectedAssignee && inbox.defaultTeamId
              ? {
                  assigneeId: preselectedAssignee.id,
                  teamId: inbox.defaultTeamId,
                }
              : {}),
          },
        });
        return {
          conversation: created,
          wasCreated: true,
          wasAssigned: Boolean(preselectedAssignee && inbox.defaultTeamId),
        };
      });

      // Se já existia (não criou agora), trata reabertura igual ao path normal
      if (!wasCreated) {
        return this.maybeReopen(conversation, accountId, input.externalId);
      }

      // CYCLE-WIRE: conversa nova criada via webhook inbound → abre 1º ciclo.
      try {
        await conversationCycleService.openCycle(conversation.id, accountId);
      } catch (err) {
        logger.warn('[conversation] openCycle no findOrCreate falhou', {
          conversationId: conversation.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

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

      if (wasAssigned && preselectedAssignee && inbox.defaultTeamId) {
        await eventService.create({
          accountId,
          eventType: 'conversation.assigned',
          actorType: 'system',
          entityType: 'conversation',
          entityId: conversation.id,
          payload: {
            from: null,
            to: preselectedAssignee.id,
            teamId: inbox.defaultTeamId,
            strategy: 'round_robin',
          },
        });

        safeEmitAssigned(accountId, conversation.id, {
          type: 'agent',
          assigneeId: preselectedAssignee.id,
          teamId: inbox.defaultTeamId,
          strategy: 'round_robin',
        });

        logger.info('[conversation] auto round-robin assign', {
          accountId,
          conversationId: conversation.id,
          teamId: inbox.defaultTeamId,
          assigneeId: preselectedAssignee.id,
        });
      }

      return conversation;
    } catch (err: any) {
      // Caso o schema venha a ter @@unique no futuro, P2002 cai aqui.
      if (err?.code === 'P2002') {
        const winner = await prisma.conversation.findFirst({
          where: { accountId, inboxId, externalId: input.externalId },
        });
        if (winner) return this.maybeReopen(winner, accountId, input.externalId);
      }
      throw err;
    }
  }

  /**
   * H3 helper: reabre conversa resolvida quando chega nova mensagem inbound,
   * mantendo paridade com a estratégia create-or-update-v2 do provider externo (REMOVED).
   */
  private async maybeReopen(
    conv: Conversation,
    accountId: string,
    externalId: string
  ): Promise<Conversation> {
    if (conv.status !== 'resolved') return conv;

    // LIFECYCLE-BUG-2: cliente voltou a falar (nova mensagem inbound em
    // conversa resolvida) — precisa limpar o circuit breaker do IA, senão
    // ele fica bloqueado pra sempre e o n8n não responde mais nessa thread.
    const currentAttrs =
      (conv.customAttributes as Record<string, unknown> | null) ?? {};
    const reopened = await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        status: 'open',
        resolvedAt: null,
        resolvedBy: null,
        customAttributes: {
          ...currentAttrs,
          human_active: null,
          human_intervened: null,
        } as any,
      },
    });

    // CYCLE-WIRE: cliente voltou a falar = novo ciclo. Preserva ciclo anterior
    // (já resolved no banco) pra histórico/métricas — coração de Bug B.
    try {
      await conversationCycleService.openCycle(conv.id, accountId);
    } catch (err) {
      logger.warn('[conversation] openCycle em maybeReopen falhou', {
        conversationId: conv.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await eventService.create({
      accountId,
      eventType: 'conversation.reopened',
      actorType: 'system',
      entityType: 'conversation',
      entityId: conv.id,
      payload: { reason: 'new_inbound_message', externalId },
    });

    return reopened;
  }

  /**
   * H4 helper: resolve contactId com proteção contra race-condition de webhooks.
   * Sem @@unique([accountId, telefone]) no schema (SE-H1), múltiplos webhooks
   * paralelos podem criar contatos duplicados. Fazemos:
   * 1) Lookup por telefone fora da transação (caminho rápido)
   * 2) Se não achar, dentro de transação: re-check + create
   * 3) Try/catch em P2002 caso o unique seja adicionado no futuro
   */
  private async resolveOrCreateContact(
    accountId: string,
    input: FindOrCreateForCustomerInput
  ): Promise<string | null> {
    if (input.contactId) return input.contactId;
    if (!input.contactPhone) return null;

    const phone = input.contactPhone;

    // 1) Caminho rápido — provavelmente já existe
    const existing = await prisma.contact.findFirst({
      where: { accountId, telefone: phone },
      select: { id: true },
    });
    if (existing) return existing.id;

    // 2) Re-check sob transação curta + create
    try {
      return await prisma.$transaction(async (tx) => {
        const racingExisting = await tx.contact.findFirst({
          where: { accountId, telefone: phone },
          select: { id: true },
        });
        if (racingExisting) return racingExisting.id;

        const created = await tx.contact.create({
          data: {
            accountId,
            telefone: phone,
            nome: input.contactName ?? null,
          },
          select: { id: true },
        });
        logger.info('[conversation] contato criado automaticamente', {
          accountId,
          contactId: created.id,
          phone,
        });
        return created.id;
      });
    } catch (err: any) {
      // 3) Se vier @@unique no schema (SE-H1), P2002 cai aqui — re-fetch vencedor
      if (err?.code === 'P2002') {
        const winner = await prisma.contact.findFirst({
          where: { accountId, telefone: phone },
          select: { id: true },
        });
        if (winner) return winner.id;
      }
      throw err;
    }
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
