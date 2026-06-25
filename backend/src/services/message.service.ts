import type { Message, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import { eventService } from './event.service';
import { webhookOutboundService } from './webhook-outbound.service';
import { emitMessageCreated } from '../socket';
import { conversationCycleService } from './conversation-cycle.service';
import { attachmentStorageService } from './attachment-storage.service';

// ============================================
// Types
// ============================================

export type MessageSenderType = 'customer' | 'agent' | 'ai_bot' | 'system' | 'integration';
export type MessageContentType =
  | 'text'
  | 'media'
  | 'audio'
  | 'document'
  | 'system_note'
  | 'template';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface ListMessagesOptions {
  limit?: number;
  before?: Date | string;
  after?: Date | string;
}

export interface CreateAttachmentInput {
  fileType: 'image' | 'video' | 'audio' | 'document';
  fileUrl: string;
  fileSize?: number;
  fileName?: string;
  mimeType?: string;
  thumbnailUrl?: string;
  duration?: number;
  /**
   * Bug A: URL original (ex.: Evolution media URL com apikey requerida).
   * Quando omitido, o service usa fileUrl como sourceUrl. O webhook Evolution
   * sempre passa esse campo explicitamente pra deixar o intent claro.
   */
  sourceUrl?: string;
}

export interface CreateMessageInput {
  conversationId: string;
  senderType: MessageSenderType;
  senderId?: string | null;
  content?: string | null;
  contentType?: MessageContentType;
  isPrivate?: boolean;
  replyToId?: string | null;
  attachments?: CreateAttachmentInput[];
  externalId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  limit?: number;
  /**
   * Role do solicitante. Quando 'agent', a busca passa a ser escopada
   * apenas a conversas onde o usuário é assignee, membro do team ou
   * participant — evita exfiltração de PII via ILIKE em toda a conta.
   */
  requesterRole?: string;
  requesterUserId?: string;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;

const VALID_SENDER_TYPES: MessageSenderType[] = [
  'customer',
  'agent',
  'ai_bot',
  'system',
  'integration',
];

const VALID_CONTENT_TYPES: MessageContentType[] = [
  'text',
  'media',
  'audio',
  'document',
  'system_note',
  'template',
];

class MessageService {
  // ============================================
  // Helpers
  // ============================================

  private clampLimit(limit: number | undefined, fallback: number, max: number): number {
    const raw = typeof limit === 'number' && Number.isFinite(limit) ? limit : fallback;
    return Math.min(Math.max(Math.trunc(raw), 1), max);
  }

  private toDate(value: Date | string | undefined): Date | undefined {
    if (!value) return undefined;
    if (value instanceof Date) return value;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError('Data inválida para filtro before/after');
    }
    return parsed;
  }

  private async ensureConversation(
    conversationId: string,
    accountId: string
  ) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
    });
    if (!conversation) {
      throw new NotFoundError('Conversa');
    }
    return conversation;
  }

  // ============================================
  // Queries
  // ============================================

  /**
   * List messages for a conversation (newest first).
   * `before` / `after` filter by createdAt (cursor-style).
   */
  async list(
    conversationId: string,
    accountId: string,
    options: ListMessagesOptions = {}
  ): Promise<Message[]> {
    await this.ensureConversation(conversationId, accountId);

    const limit = this.clampLimit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const before = this.toDate(options.before);
    const after = this.toDate(options.after);

    const where: Prisma.MessageWhereInput = { conversationId };

    if (before || after) {
      where.createdAt = {};
      if (before) {
        (where.createdAt as Prisma.DateTimeFilter).lt = before;
      }
      if (after) {
        (where.createdAt as Prisma.DateTimeFilter).gt = after;
      }
    }

    return prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        attachments: true,
        sender: {
          select: { id: true, nome: true, email: true },
        },
      },
    });
  }

  /**
   * Get a message by id, scoped by accountId via parent conversation.
   */
  async get(id: string, accountId: string): Promise<Message> {
    const message = await prisma.message.findFirst({
      where: {
        id,
        conversation: { accountId },
      },
      include: {
        attachments: true,
        readReceipts: true,
        sender: {
          select: { id: true, nome: true, email: true },
        },
      },
    });

    if (!message) {
      throw new NotFoundError('Mensagem');
    }

    return message;
  }

  // ============================================
  // Mutations
  // ============================================

  /**
   * Create a new message in a conversation.
   * Side effects:
   *  - Atualiza Conversation.updatedAt
   *  - Incrementa unreadCount quando senderType === 'customer'
   *  - Seta firstResponseAt se ainda nulo e senderType ∈ {'agent','ai_bot','integration'}
   *    (LIFECYCLE-BUG-3: contas com alto volume de IA estavam sendo ignoradas
   *    do cálculo de FRT porque a IA respondia antes do humano e o
   *    `firstResponseAt` nunca era preenchido; passamos a contar qualquer
   *    resposta não-cliente e não-privada como "first response").
   *  - Emite event interno + webhook outbound 'message.created'
   */
  async create(accountId: string, input: CreateMessageInput): Promise<Message> {
    if (!input.conversationId) {
      throw new ValidationError('conversationId é obrigatório');
    }
    if (!VALID_SENDER_TYPES.includes(input.senderType)) {
      throw new ValidationError(
        `senderType inválido. Valores aceitos: ${VALID_SENDER_TYPES.join(', ')}`
      );
    }

    const contentType: MessageContentType = input.contentType ?? 'text';
    if (!VALID_CONTENT_TYPES.includes(contentType)) {
      throw new ValidationError(
        `contentType inválido. Valores aceitos: ${VALID_CONTENT_TYPES.join(', ')}`
      );
    }

    const hasContent = typeof input.content === 'string' && input.content.trim() !== '';
    const hasAttachments = Array.isArray(input.attachments) && input.attachments.length > 0;
    if (!hasContent && !hasAttachments) {
      throw new ValidationError('Mensagem precisa de content ou attachments');
    }

    const conversation = await this.ensureConversation(input.conversationId, accountId);

    // Validate replyTo, if provided, belongs to the same conversation
    if (input.replyToId) {
      const parent = await prisma.message.findFirst({
        where: { id: input.replyToId, conversationId: conversation.id },
        select: { id: true },
      });
      if (!parent) {
        throw new ValidationError('replyToId não pertence a esta conversa');
      }
    }

    const now = new Date();
    const shouldIncrementUnread = input.senderType === 'customer';
    // LIFECYCLE-BUG-3: qualquer resposta não-cliente e não-privada conta como
    // "primeira resposta" para fins de FRT — inclui agent humano, ai_bot
    // (resposta automatizada do CRM) e integration (provider externo — REMOVED).
    const isFirstResponseSender =
      input.senderType === 'agent' ||
      input.senderType === 'ai_bot' ||
      input.senderType === 'integration';
    const shouldSetFirstResponse =
      isFirstResponseSender && !conversation.firstResponseAt && input.isPrivate !== true;

    const message = await prisma.$transaction(async tx => {
      const created = await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderType: input.senderType,
          senderId: input.senderId ?? null,
          content: input.content ?? null,
          contentType,
          isPrivate: input.isPrivate ?? false,
          status: 'sent',
          externalId: input.externalId ?? null,
          replyToId: input.replyToId ?? null,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
          ...(hasAttachments && {
            attachments: {
              create: (input.attachments as CreateAttachmentInput[]).map(att => ({
                fileType: att.fileType,
                // Bug A: fileUrl será sobrescrito por '/api/attachments/<id>'
                // após o materialize ter sucesso. Até lá guardamos o original
                // pra que listagens legacy continuem mostrando ALGO.
                fileUrl: att.fileUrl,
                fileSize: att.fileSize ?? null,
                fileName: att.fileName ?? null,
                mimeType: att.mimeType ?? null,
                thumbnailUrl: att.thumbnailUrl ?? null,
                duration: att.duration ?? null,
                // Bug A: sourceUrl preserva URL Evolution (com apikey requerida)
                // pra que o storage service consiga baixar depois.
                sourceUrl: att.sourceUrl ?? att.fileUrl,
                storageStatus: 'pending',
              })),
            },
          }),
        },
        include: {
          attachments: true,
        },
      });

      const convUpdate: Prisma.ConversationUpdateInput = { updatedAt: now };
      if (shouldIncrementUnread) {
        convUpdate.unreadCount = { increment: 1 };
      }
      if (shouldSetFirstResponse) {
        convUpdate.firstResponseAt = now;
      }

      await tx.conversation.update({
        where: { id: conversation.id },
        data: convUpdate,
      });

      return created;
    });

    // CYCLE-WIRE: contadores e first-response no ConversationCycle aberto.
    // - mensagens privadas (notas internas) NÃO contam pra ciclo nem FRT —
    //   são comunicação entre agentes e não fazem parte do "atendimento ao cliente".
    // - increment SEMPRE no sender_type (customer ou agent/integration/ai_bot).
    // Best-effort: falha do cycle não deve abortar a mensagem.
    if (!message.isPrivate) {
      try {
        if (input.senderType === 'customer') {
          await conversationCycleService.incrementMessageCount(
            conversation.id,
            accountId,
            'customer'
          );
        } else if (isFirstResponseSender) {
          // agent | ai_bot | integration = lado da empresa
          if (shouldSetFirstResponse) {
            await conversationCycleService.recordFirstResponse(
              conversation.id,
              accountId,
              input.senderId ?? null
            );
          }
          await conversationCycleService.incrementMessageCount(
            conversation.id,
            accountId,
            'agent'
          );
        }
      } catch (err) {
        logger.warn('[message] cycle wire falhou', {
          messageId: message.id,
          conversationId: conversation.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Bug A: dispara materialização em background (não bloqueia retorno do
    // POST de mensagem). Cada attachment pending é baixado da Evolution e
    // gravado em backend/uploads/<accountId>/. fileUrl passa a apontar pro
    // proxy /api/attachments/<id> assim que o download concluir.
    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      for (const att of message.attachments) {
        if (att.storageStatus === 'downloaded') continue;
        void attachmentStorageService.materialize(att.id).catch((err) => {
          logger.warn('[message] falha materialize de attachment', {
            attachmentId: att.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    // Fire-and-forget side effects (audit + outbound webhook).
    void eventService.create({
      accountId,
      eventType: 'message.created',
      actorType: input.senderType === 'agent' ? 'user' : 'system',
      actorId: input.senderId ?? undefined,
      entityType: 'message',
      entityId: message.id,
      channel: 'whatsapp',
      payload: {
        conversationId: conversation.id,
        senderType: input.senderType,
        contentType,
        isPrivate: message.isPrivate,
        externalId: message.externalId,
      },
    });

    webhookOutboundService
      .emit(accountId, 'message.created', {
        id: message.id,
        conversationId: conversation.id,
        contactId: conversation.contactId,
        inboxId: conversation.inboxId,
        senderType: message.senderType,
        senderId: message.senderId,
        content: message.content,
        contentType: message.contentType,
        isPrivate: message.isPrivate,
        externalId: message.externalId,
        replyToId: message.replyToId,
        attachments: message.attachments,
        metadata: message.metadata,
        createdAt: message.createdAt.toISOString(),
      })
      .catch(err =>
        logger.warn('[message] falha ao emitir webhook message.created', {
          messageId: message.id,
          accountId,
          error: err instanceof Error ? err.message : String(err),
        })
      );

    // T-022 Sprint 4 — broadcast via Socket.IO pros clientes conectados na conversa.
    // try/catch defensivo: se o Socket.IO ainda não inicializou (ex.: testes
    // unitários carregando o service direto), não derruba o fluxo de mensagem.
    try {
      emitMessageCreated(accountId, conversation.id, message);
    } catch (err) {
      logger.debug('[message] socket emit message:created falhou', {
        messageId: message.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return message;
  }

  /**
   * Mark a message as delivered (callback do provider, ex. Evolution).
   * `externalId` é gravado pra reconciliação futura.
   *
   * Escopo obrigatório por accountId via parent conversation — evita
   * que um callback malicioso/cross-tenant marque mensagem de outro
   * tenant como delivered.
   */
  async markDelivered(id: string, accountId: string, externalId: string): Promise<Message> {
    if (!accountId) {
      throw new ValidationError('accountId obrigatório');
    }

    const existing = await prisma.message.findFirst({
      where: {
        id,
        conversation: { accountId },
      },
      select: { id: true, status: true },
    });
    if (!existing) {
      throw new NotFoundError('Mensagem');
    }

    return prisma.message.update({
      where: { id: existing.id },
      data: {
        status: existing.status === 'read' ? 'read' : 'delivered',
        externalId: externalId || undefined,
        deliveredAt: new Date(),
      },
    });
  }

  /**
   * Wrapper de `markDelivered` que aceita apenas o `externalId` (provider id).
   *
   * Útil para callbacks de webhook (ex.: Evolution `messages.update`) onde
   * só temos o id do provider — o lookup interno descobre o `Message.id`
   * via `findFirst({ externalId })`. Multi-tenant pode ser opcionalmente
   * escopado por `accountId` quando fornecido (recomendado para evitar
   * ACK forgery cross-tenant). Se `accountId` for omitido, faz lookup
   * global pelo `externalId` — só usar em fluxos confiáveis.
   *
   * Idempotente / silencioso: se não achar a mensagem, apenas loga em
   * debug e retorna `null` (não levanta — webhooks não devem 5xx só
   * porque a mensagem ainda não foi persistida do lado do CRM).
   */
  async markDeliveredByExternalId(
    externalId: string,
    accountId?: string
  ): Promise<Message | null> {
    if (!externalId) {
      throw new ValidationError('externalId obrigatório');
    }

    const where: Prisma.MessageWhereInput = accountId
      ? { externalId, conversation: { accountId } }
      : { externalId };

    const existing = await prisma.message.findFirst({
      where,
      select: { id: true, status: true, conversation: { select: { accountId: true } } },
    });

    if (!existing) {
      logger.debug('[message.service] markDeliveredByExternalId — mensagem não encontrada', {
        externalId,
        accountId,
      });
      return null;
    }

    return prisma.message.update({
      where: { id: existing.id },
      data: {
        status: existing.status === 'read' ? 'read' : 'delivered',
        deliveredAt: new Date(),
      },
    });
  }

  /**
   * Mark message as read by a user. Cria/atualiza ReadReceipt e
   * zera unreadCount da conversa (assumindo leitura por agente).
   */
  async markRead(id: string, accountId: string, userId: string): Promise<Message> {
    const message = await prisma.message.findFirst({
      where: {
        id,
        conversation: { accountId },
      },
      select: { id: true, conversationId: true, status: true, readAt: true },
    });

    if (!message) {
      throw new NotFoundError('Mensagem');
    }

    const now = new Date();

    const [updated] = await prisma.$transaction([
      prisma.message.update({
        where: { id: message.id },
        data: {
          status: 'read',
          readAt: message.readAt ?? now,
          deliveredAt: undefined,
        },
      }),
      prisma.readReceipt.upsert({
        where: { userId_messageId: { userId, messageId: message.id } },
        create: { userId, messageId: message.id, readAt: now },
        update: { readAt: now },
      }),
      prisma.conversation.update({
        where: { id: message.conversationId },
        data: { unreadCount: 0 },
      }),
    ]);

    return updated;
  }

  /**
   * Mark a message as failed (provider error, rate-limit etc).
   * `error` is stored in metadata.lastError for debugging.
   *
   * Escopo obrigatório por accountId via parent conversation — evita
   * gravar erro arbitrário em metadata de mensagem de outro tenant.
   */
  async markFailed(id: string, accountId: string, error: string): Promise<Message> {
    if (!accountId) {
      throw new ValidationError('accountId obrigatório');
    }

    const existing = await prisma.message.findFirst({
      where: {
        id,
        conversation: { accountId },
      },
      select: { id: true, metadata: true },
    });
    if (!existing) {
      throw new NotFoundError('Mensagem');
    }

    const baseMetadata =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};

    const metadata: Prisma.InputJsonValue = {
      ...baseMetadata,
      lastError: error,
      failedAt: new Date().toISOString(),
    };

    return prisma.message.update({
      where: { id: existing.id },
      data: {
        status: 'failed',
        metadata,
      },
    });
  }

  /**
   * CHAT-MSG-FAILED-007: limpa o estado de erro de uma mensagem, voltando
   * o status para 'sending' para permitir uma nova tentativa de dispatch
   * (a UI/controller chama isto antes de re-enviar pelo provider).
   *
   * Escopo obrigatório por accountId.
   */
  async resetFailed(id: string, accountId: string): Promise<Message> {
    if (!accountId) {
      throw new ValidationError('accountId obrigatório');
    }

    const existing = await prisma.message.findFirst({
      where: { id, conversation: { accountId } },
      select: { id: true, status: true, metadata: true },
    });
    if (!existing) {
      throw new NotFoundError('Mensagem');
    }
    if (existing.status !== 'failed') {
      throw new ValidationError('Apenas mensagens com status=failed podem ser reenviadas');
    }

    const baseMetadata =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};

    // Mantemos lastError/failedAt para auditoria mas marcamos retryAt.
    const metadata: Prisma.InputJsonValue = {
      ...baseMetadata,
      retryAt: new Date().toISOString(),
    };

    return prisma.message.update({
      where: { id: existing.id },
      data: { status: 'sending', metadata },
    });
  }

  // ============================================
  // Utilities
  // ============================================

  /**
   * Count total messages in a conversation.
   */
  async countByConversation(conversationId: string): Promise<number> {
    return prisma.message.count({ where: { conversationId } });
  }

  /**
   * Full-text-ish search by ILIKE on content, scoped by account.
   * Excludes private notes from results.
   *
   * Defesa contra exfiltração de PII em massa (CHAT-AUTH-H2):
   * quando o solicitante é `agent`, aplica o mesmo filtro de
   * pertencimento usado em listagem de conversas — assignee,
   * membro do team responsável OU participant. Admin/super_admin
   * mantêm visão completa da conta.
   */
  async search(
    accountId: string,
    query: string,
    options: SearchOptions = {}
  ): Promise<Message[]> {
    const term = (query || '').trim();
    if (term.length < 2) {
      throw new ValidationError('query precisa ter pelo menos 2 caracteres');
    }

    const limit = this.clampLimit(options.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

    const conversationFilter: Prisma.ConversationWhereInput = { accountId };

    if (options.requesterRole === 'agent') {
      if (!options.requesterUserId) {
        // Agent sem id resolvido — falha fechada (não exibe nada) ao invés de
        // cair no else (visão total da conta).
        throw new ValidationError('requesterUserId obrigatório para busca de agent');
      }
      const userId = options.requesterUserId;
      conversationFilter.OR = [
        { assigneeId: userId },
        { participants: { some: { userId } } },
        { team: { members: { some: { userId } } } },
      ];
    }

    return prisma.message.findMany({
      where: {
        conversation: conversationFilter,
        isPrivate: false,
        content: { contains: term, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        attachments: true,
        sender: {
          select: { id: true, nome: true, email: true },
        },
      },
    });
  }
}

export const messageService = new MessageService();
