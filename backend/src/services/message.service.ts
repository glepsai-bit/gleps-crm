import type { Message, MessageReaction, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { escapeLike } from '../utils/helpers';
import { logger } from '../utils/logger';
import { sanitizeMessageAttachments } from '../utils/attachment-api.util';
import { eventService } from './event.service';
import { webhookOutboundService } from './webhook-outbound.service';
import {
  emitMessageCreated,
  emitMessageUpdated,
  emitMessageReactionUpdated,
} from '../socket';
import { conversationCycleService } from './conversation-cycle.service';
import { attachmentStorageService } from './attachment-storage.service';
import { evolutionService } from './evolution.service';
import { pushService } from './push.service';
import { env } from '../config/env';

// ============================================
// Regras de edição/deleção outbound
// ============================================
// WhatsApp permite editar mensagens até 15 min após o envio. Passa disso, a
// Evolution devolve erro. Aplicamos a mesma janela para o delete-for-everyone
// (na prática o WhatsApp permite ~2h para delete, mas manter regra unificada
// simplifica a UI e cobre o pior caso).
export const OUTBOUND_EDIT_WINDOW_MS = 15 * 60 * 1000;
export const OUTBOUND_DELETE_WINDOW_MS = 15 * 60 * 1000;

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
  fileType: 'image' | 'video' | 'audio' | 'document' | 'sticker';
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
  /**
   * BUG-DISPATCH-CHAT-002: dispatch outbound pode falhar no envio (Evolution
   * desconectado). Nesse caso ainda queremos persistir a Message no CRM com
   * status='failed' pra usuario ver o historico + tentar reenvio. Default
   * 'sent' preserva retrocompat com todos callers antigos.
   */
  status?: MessageStatus;
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

// ============================================
// CHAT-REACTIONS FURO 2: aggregate shape + include
// ============================================
// Retornado embutido em cada Message via `list`/`get` (hidratação inicial)
// e emitido pelo evento socket `message:reaction:updated` (sincronização
// entre agentes/tabs). Sempre 1 entry por emoji distinto — `byMe` é
// derivado no frontend a partir do userIds/currentUserId.
export interface MessageReactionAggregate {
  emoji: string;
  count: number;
  userIds: string[];
  externalContactIds: string[];
}

/**
 * Prisma include compartilhado por list()/get() — traz o mínimo necessário
 * pra agregar os pills sem inflar payload. Não incluímos `user`/`externalContact`
 * relations aqui: o frontend só precisa dos ids pra decidir byMe/render.
 */
const REACTIONS_INCLUDE = {
  reactions: {
    select: {
      id: true,
      emoji: true,
      userId: true,
      externalContactId: true,
      createdAt: true,
    },
  },
} satisfies Prisma.MessageInclude;

/**
 * Agrupa uma lista plana de MessageReaction (raw do Prisma) por emoji e
 * retorna o shape consumido pelo frontend. Idempotente: entrada vazia
 * devolve array vazio; ordem preservada por primeira ocorrência do emoji.
 */
export function aggregateMessageReactions(
  reactions: Array<Pick<MessageReaction, 'emoji' | 'userId' | 'externalContactId'>>
): MessageReactionAggregate[] {
  if (!Array.isArray(reactions) || reactions.length === 0) return [];
  const byEmoji = new Map<string, MessageReactionAggregate>();
  for (const r of reactions) {
    const existing =
      byEmoji.get(r.emoji) ?? {
        emoji: r.emoji,
        count: 0,
        userIds: [] as string[],
        externalContactIds: [] as string[],
      };
    existing.count += 1;
    if (r.userId) {
      if (!existing.userIds.includes(r.userId)) existing.userIds.push(r.userId);
    } else if (r.externalContactId) {
      if (!existing.externalContactIds.includes(r.externalContactId)) {
        existing.externalContactIds.push(r.externalContactId);
      }
    }
    byEmoji.set(r.emoji, existing);
  }
  return Array.from(byEmoji.values());
}

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

    // T2-MSG-ORDER: tiebreaker por id quando createdAt colide (mesmo ms).
    // Postgres só armazena timestamptz com precisão de microssegundos, mas a
    // Evolution+webhook+backend roda em ms — mensagens criadas no mesmo tick
    // (typical em respostas IA com múltiplas partes) ficavam fora de ordem.
    // Ordenar id ASC como segundo critério garante determinismo no FE.
    // CHAT-REACTIONS FURO 2: incluímos reactions e devolvemos agregado por
    // emoji embutido em cada Message. Sem isso, F5 zerava as pills até o
    // usuário reagir de novo.
    const rows = await prisma.message.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: {
        attachments: true,
        sender: {
          select: { id: true, nome: true, email: true },
        },
        ...REACTIONS_INCLUDE,
      },
    });

    // AUDIT-PERF-INLINE: nunca devolver base64 inline na listagem.
    const sanitized = rows.map((m) => sanitizeMessageAttachments(m));

    return sanitized.map((m) => ({
      ...m,
      reactions: aggregateMessageReactions(m.reactions ?? []),
    })) as unknown as Message[];
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
        // CHAT-REACTIONS FURO 2: mesma agregação de list() para consistência.
        ...REACTIONS_INCLUDE,
      },
    });

    if (!message) {
      throw new NotFoundError('Mensagem');
    }

    return {
      ...message,
      reactions: aggregateMessageReactions(
        (message as unknown as { reactions?: MessageReaction[] }).reactions ?? []
      ),
    } as unknown as Message;
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

    // PISTA D — Upload multipart dedicado: fileUrl no formato
    // `/api/attachments/<uuid>` indica um Attachment JA existente (foi criado
    // via POST /api/attachments/upload antes desta message). Nesse caso NAO
    // recriamos a row via nested create — apenas linkamos (messageId=novaMsg.id)
    // dentro da mesma transacao. Isso evita duplicar arquivo em disco, preserva
    // storageStatus='downloaded' e nao dispara materialize desnecessario.
    //
    // Guard-rail multi-tenant: validamos que Attachment.storagePath comeca com
    // `<accountId>/` — o upload sempre grava em uploads/<accountId>/<id>.<ext>,
    // entao esse prefixo prova que a row pertence a essa conta e nao a outra.
    // Sem isso um agente da conta X poderia forjar fileUrl apontando pro id de
    // um attachment da conta Y e "linkar" cross-tenant.
    const linkedAttachmentPattern = /^\/api\/attachments\/([0-9a-f-]{36})$/i;
    const attachmentInputs = hasAttachments
      ? (input.attachments as CreateAttachmentInput[])
      : [];
    interface AttachmentPlan {
      kind: 'link' | 'create';
      input: CreateAttachmentInput;
      linkedId?: string;
    }
    const plans: AttachmentPlan[] = [];
    for (const att of attachmentInputs) {
      const m = typeof att.fileUrl === 'string'
        ? att.fileUrl.match(linkedAttachmentPattern)
        : null;
      if (m) {
        plans.push({ kind: 'link', input: att, linkedId: m[1] });
      } else {
        plans.push({ kind: 'create', input: att });
      }
    }
    const linkedIds = plans
      .filter(p => p.kind === 'link')
      .map(p => p.linkedId as string);

    if (linkedIds.length > 0) {
      // Valida antes de abrir a transacao — findMany scoped por prefixo do
      // storagePath. Rejeita se qualquer id for cross-tenant, invalido ou
      // ja linkado (messageId != null seria um double-linking / reuso ilegal).
      const existing = await prisma.attachment.findMany({
        where: {
          id: { in: linkedIds },
          messageId: null,
          storagePath: { startsWith: `${accountId}/` },
        },
        select: { id: true },
      });
      if (existing.length !== linkedIds.length) {
        throw new ValidationError(
          'Um ou mais anexos referenciados nao existem, ja foram enviados ou nao pertencem a esta conta'
        );
      }
    }

    const message = await prisma.$transaction(async tx => {
      const createNestedAttachments = plans
        .filter(p => p.kind === 'create')
        .map(p => ({
          fileType: p.input.fileType,
          // Bug A: fileUrl será sobrescrito por '/api/attachments/<id>'
          // após o materialize ter sucesso. Até lá guardamos o original
          // pra que listagens legacy continuem mostrando ALGO.
          fileUrl: p.input.fileUrl,
          fileSize: p.input.fileSize ?? null,
          fileName: p.input.fileName ?? null,
          mimeType: p.input.mimeType ?? null,
          thumbnailUrl: p.input.thumbnailUrl ?? null,
          duration: p.input.duration ?? null,
          // Bug A: sourceUrl preserva URL Evolution (com apikey requerida)
          // pra que o storage service consiga baixar depois.
          sourceUrl: p.input.sourceUrl ?? p.input.fileUrl,
          storageStatus: 'pending',
        }));

      const created = await tx.message.create({
        data: {
          conversationId: conversation.id,
          senderType: input.senderType,
          senderId: input.senderId ?? null,
          content: input.content ?? null,
          contentType,
          isPrivate: input.isPrivate ?? false,
          status: input.status ?? 'sent',
          externalId: input.externalId ?? null,
          replyToId: input.replyToId ?? null,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
          ...(createNestedAttachments.length > 0 && {
            attachments: {
              create: createNestedAttachments,
            },
          }),
        },
        include: {
          attachments: true,
        },
      });

      // PISTA D: linka attachments ja existentes (upload multipart) na mesma
      // transacao. updateMany devolve count — a validacao pre-transacao ja
      // garantiu que todos existem, entao count deve bater com linkedIds.length;
      // caso contrario abortamos (rollback) por safety.
      if (linkedIds.length > 0) {
        const updateResult = await tx.attachment.updateMany({
          where: {
            id: { in: linkedIds },
            messageId: null,
            storagePath: { startsWith: `${accountId}/` },
          },
          data: { messageId: created.id },
        });
        if (updateResult.count !== linkedIds.length) {
          throw new ValidationError(
            'Falha ao linkar anexos pre-existentes (race condition ou multi-tenant)'
          );
        }
      }

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

      // Recarrega com attachments linkados incluidos (o include acima so
      // trouxe os criados via nested create — os linkados ainda tinham
      // messageId=null naquele momento).
      if (linkedIds.length > 0) {
        const refreshed = await tx.message.findUnique({
          where: { id: created.id },
          include: { attachments: true },
        });
        // AUDIT-PERF-INLINE: emit/webhook/response nunca carregam base64.
        return sanitizeMessageAttachments(refreshed ?? created);
      }
      return sanitizeMessageAttachments(created);
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

    // Web Push — notifica o assignee quando mensagem inbound do CLIENTE
    // chega numa conversa que ele atende, e a msg nao foi enviada pelo
    // proprio assignee (caso improvavel — senderType='customer' implica
    // senderId null — mas mantemos a guarda por defesa em profundidade).
    // Fire-and-forget: falha do push service nao afeta a persistencia da msg.
    if (
      input.senderType === 'customer' &&
      !message.isPrivate &&
      conversation.assigneeId &&
      conversation.assigneeId !== input.senderId
    ) {
      void this.sendInboundPushNotification(conversation, message, accountId).catch(err => {
        logger.warn('[message] push notification falhou', {
          messageId: message.id,
          assigneeId: conversation.assigneeId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return message;
  }

  /**
   * Monta e dispara a push notification pro assignee quando chega mensagem
   * do cliente. Separado do fluxo principal pra manter create() legivel e
   * facilitar testes. Executado em fire-and-forget pelo caller.
   */
  private async sendInboundPushNotification(
    conversation: { id: string; assigneeId: string | null; contactId: string | null },
    message: Message,
    accountId: string
  ): Promise<void> {
    if (!conversation.assigneeId) return;

    // Busca nome do contato pra montar titulo amigavel — best-effort.
    let contactName = 'Nova mensagem';
    if (conversation.contactId) {
      try {
        const contact = await prisma.contact.findFirst({
          where: { id: conversation.contactId, accountId },
          select: { nome: true, telefone: true },
        });
        if (contact) {
          contactName = (contact.nome || contact.telefone || 'Nova mensagem').trim();
        }
      } catch {
        /* silencioso — cai no default */
      }
    }

    // Preview do corpo (texto ou placeholder de midia). Limitado a 140 chars
    // pra caber bonito na notificacao do browser.
    let body: string;
    if (typeof message.content === 'string' && message.content.trim().length > 0) {
      const trimmed = message.content.trim();
      body = trimmed.length > 140 ? `${trimmed.slice(0, 137)}…` : trimmed;
    } else {
      switch (message.contentType) {
        case 'audio':
          body = '[Audio]';
          break;
        case 'document':
          body = '[Documento]';
          break;
        case 'media':
          body = '[Midia]';
          break;
        default:
          body = 'Nova mensagem';
      }
    }

    const frontendBase = (env.FRONTEND_URL || 'http://localhost:8080').replace(/\/$/, '');
    const url = `${frontendBase}/admin/chat?conversationId=${conversation.id}`;

    await pushService.sendToUser(conversation.assigneeId, {
      title: contactName,
      body,
      url,
      // Colapsa multiplas mensagens da mesma conversa numa notificacao so
      // (spec Notification API: mesma tag substitui a anterior).
      tag: `conv:${conversation.id}`,
      data: {
        conversationId: conversation.id,
        messageId: message.id,
      },
    });
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

    const found = await prisma.message.findMany({
      where: {
        conversation: conversationFilter,
        isPrivate: false,
        // T1-ILIKE-WILDCARD: escapa `%` e `_` para evitar wildcards SQL.
        content: { contains: escapeLike(term), mode: 'insensitive' },
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
    // AUDIT-PERF-INLINE
    return found.map((m) => sanitizeMessageAttachments(m));
  }

  // ============================================
  // CHAT-REPLY-EDIT-DEL: edit outbound (15min window)
  // ============================================

  /**
   * Edita o conteúdo de uma mensagem outbound do próprio agente.
   *
   * Regras:
   *  - Autor: senderId === userId (self-only) e senderType === 'agent'.
   *  - Janela: createdAt > now - 15min (mesmo limite do WhatsApp).
   *  - Não editável: mensagem sem externalId (nunca chegou ao WhatsApp),
   *    privada (nota interna), ou já deletada.
   *  - Best-effort no provider: se Evolution falhar, a edição local ainda
   *    persiste — a UI mostra o novo texto e a discrepância só existe
   *    no WhatsApp remoto (o agente pode retry via nova edição).
   */
  async editMessage(
    id: string,
    accountId: string,
    userId: string,
    newContent: string
  ): Promise<Message> {
    if (!newContent || newContent.trim() === '') {
      throw new ValidationError('content é obrigatório');
    }
    if (newContent.length > 4096) {
      throw new ValidationError('Mensagem muito longa (max 4096 caracteres)');
    }

    const existing = await prisma.message.findFirst({
      where: { id, conversation: { accountId } },
      include: {
        conversation: {
          include: {
            contact: { select: { telefone: true } },
            inbox: { select: { channelType: true, evolutionInstance: true } },
          },
        },
      },
    });
    if (!existing) throw new NotFoundError('Mensagem');

    if (existing.deletedAt) {
      throw new ValidationError('Mensagem apagada não pode ser editada');
    }
    if (existing.isPrivate) {
      throw new ValidationError('Nota interna não pode ser editada por aqui');
    }
    if (existing.senderType !== 'agent') {
      throw new ForbiddenError('Apenas mensagens enviadas por agente podem ser editadas');
    }
    if (existing.senderId !== userId) {
      throw new ForbiddenError('Apenas o autor da mensagem pode editá-la');
    }
    const ageMs = Date.now() - existing.createdAt.getTime();
    if (ageMs > OUTBOUND_EDIT_WINDOW_MS) {
      throw new ValidationError(
        'Janela de edição expirada (15 minutos após o envio)'
      );
    }

    // Update local (metadata.edited=true / editedAt=now).
    const baseMetadata =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    const nowIso = new Date().toISOString();
    const nextMetadata: Prisma.InputJsonValue = {
      ...baseMetadata,
      edited: true,
      editedAt: nowIso,
      previousContent:
        typeof baseMetadata.previousContent === 'string'
          ? baseMetadata.previousContent // preserva a versão original mais antiga
          : existing.content ?? null,
    };

    const updated = await prisma.message.update({
      where: { id: existing.id },
      data: {
        content: newContent,
        metadata: nextMetadata,
      },
      include: { attachments: true },
    });

    // CHAT-REPLY-EDIT-DEL: notifica todos os agentes com a thread aberta.
    // Emitimos ANTES da propagação Evolution — a UI reflete o estado local
    // no mesmo tick, e uma eventual falha na Evolution (best-effort abaixo)
    // não bloqueia o realtime.
    emitMessageUpdated(accountId, existing.conversationId, updated);

    // Best-effort: propaga edit pra Evolution se a msg tem externalId real
    // (não pending) e o canal é WhatsApp.
    const phone = existing.conversation.contact?.telefone ?? '';
    const externalId = existing.externalId ?? '';
    const isPending = externalId.startsWith('pending:');
    if (
      externalId &&
      !isPending &&
      phone &&
      existing.conversation.inbox?.channelType === 'whatsapp'
    ) {
      try {
        await evolutionService.updateMessage(accountId, {
          number: phone,
          keyId: externalId,
          fromMe: true,
          text: newContent,
          instance: existing.conversation.inbox.evolutionInstance ?? null,
        });
      } catch (err) {
        logger.warn('[message] falha ao propagar edit para Evolution', {
          messageId: existing.id,
          accountId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return updated;
  }

  // ============================================
  // CHAT-REPLY-EDIT-DEL: soft delete outbound
  // ============================================

  /**
   * Soft-delete de mensagem outbound do próprio agente.
   *  - content = NULL, deletedAt = now (UI mostra "Mensagem apagada").
   *  - Regras de ownership idênticas ao edit.
   *  - Best-effort: chama Evolution deleteMessageForEveryone se a msg tem
   *    externalId; falha aqui não bloqueia o soft delete local.
   */
  async softDeleteMessage(
    id: string,
    accountId: string,
    userId: string
  ): Promise<Message> {
    const existing = await prisma.message.findFirst({
      where: { id, conversation: { accountId } },
      include: {
        conversation: {
          include: {
            contact: { select: { telefone: true } },
            inbox: { select: { channelType: true, evolutionInstance: true } },
          },
        },
      },
    });
    if (!existing) throw new NotFoundError('Mensagem');

    if (existing.deletedAt) {
      // Idempotente — devolve mesma msg.
      return existing;
    }
    if (existing.isPrivate) {
      throw new ValidationError('Nota interna não pode ser deletada por aqui');
    }
    if (existing.senderType !== 'agent') {
      throw new ForbiddenError('Apenas mensagens enviadas por agente podem ser deletadas');
    }
    if (existing.senderId !== userId) {
      throw new ForbiddenError('Apenas o autor da mensagem pode deletá-la');
    }
    const ageMs = Date.now() - existing.createdAt.getTime();
    if (ageMs > OUTBOUND_DELETE_WINDOW_MS) {
      throw new ValidationError(
        'Janela de delete-for-everyone expirada (15 minutos após o envio)'
      );
    }

    const baseMetadata =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    const now = new Date();
    const nextMetadata: Prisma.InputJsonValue = {
      ...baseMetadata,
      deletedBy: userId,
      previousContent:
        typeof baseMetadata.previousContent === 'string'
          ? baseMetadata.previousContent
          : existing.content ?? null,
    };

    const updated = await prisma.message.update({
      where: { id: existing.id },
      data: {
        content: null,
        deletedAt: now,
        metadata: nextMetadata,
      },
      include: { attachments: true },
    });

    // CHAT-REPLY-EDIT-DEL: notifica todos os agentes com a thread aberta
    // para que a mensagem apagada apareça como "Mensagem apagada" sem F5.
    emitMessageUpdated(accountId, existing.conversationId, updated);

    const phone = existing.conversation.contact?.telefone ?? '';
    const externalId = existing.externalId ?? '';
    const isPending = externalId.startsWith('pending:');
    if (
      externalId &&
      !isPending &&
      phone &&
      existing.conversation.inbox?.channelType === 'whatsapp'
    ) {
      try {
        await evolutionService.deleteMessageForEveryone(accountId, {
          keyId: externalId,
          number: phone,
          fromMe: true,
          instance: existing.conversation.inbox.evolutionInstance ?? null,
        });
      } catch (err) {
        logger.warn('[message] falha ao propagar delete para Evolution', {
          messageId: existing.id,
          accountId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return updated;
  }

  // ============================================
  // CHAT-REACTIONS: agent reage a msg com emoji
  // ============================================

  /**
   * CHAT-REACTIONS FURO 2: helper interno que consulta o estado atual de
   * reactions da mensagem e emite `message:reaction:updated` na sala da
   * conversa. Best-effort: qualquer erro é apenas logado — a persistência
   * já ocorreu no caller e não deve ser abortada por falha de broadcast.
   */
  private async emitReactionUpdate(
    accountId: string,
    conversationId: string,
    messageId: string
  ): Promise<void> {
    try {
      const rows = await prisma.messageReaction.findMany({
        where: { messageId },
        select: {
          emoji: true,
          userId: true,
          externalContactId: true,
        },
        orderBy: { createdAt: 'asc' },
      });
      const aggregate = aggregateMessageReactions(rows);
      emitMessageReactionUpdated(accountId, conversationId, messageId, aggregate);
    } catch (err) {
      logger.debug('[message] socket emit message:reaction:updated falhou', {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Cria/atualiza reaction do usuário atual na mensagem, e propaga p/ Evolution.
   * Retorna a reaction persistida.
   *
   * Idempotente por @@unique([messageId, userId, emoji]): se já existe, o
   * upsert atualiza createdAt e devolve — evita 409 do Postgres.
   *
   * Best-effort: falha no provider NÃO desfaz a reaction local (UI mostra,
   * o WhatsApp remoto perde — melhor que fingir 500 pro agente).
   */
  async addReaction(
    messageId: string,
    accountId: string,
    userId: string,
    emoji: string
  ): Promise<MessageReaction> {
    const emojiTrim = (emoji || '').trim();
    if (!emojiTrim) {
      throw new ValidationError('emoji é obrigatório');
    }
    if (emojiTrim.length > 16) {
      throw new ValidationError('emoji muito longo (max 16 caracteres)');
    }

    const message = await prisma.message.findFirst({
      where: { id: messageId, conversation: { accountId } },
      include: {
        conversation: {
          include: {
            contact: { select: { telefone: true } },
            inbox: { select: { channelType: true, evolutionInstance: true } },
          },
        },
      },
    });
    if (!message) throw new NotFoundError('Mensagem');
    if (message.deletedAt) {
      throw new ValidationError('Mensagem apagada não pode receber reactions');
    }

    const reaction = await prisma.messageReaction.upsert({
      where: {
        messageId_userId_emoji: {
          messageId: message.id,
          userId,
          emoji: emojiTrim,
        },
      },
      create: {
        messageId: message.id,
        userId,
        emoji: emojiTrim,
      },
      update: {
        createdAt: new Date(),
      },
    });

    // Best-effort Evolution propagation.
    const phone = message.conversation.contact?.telefone ?? '';
    const externalId = message.externalId ?? '';
    const isPending = externalId.startsWith('pending:');
    if (
      externalId &&
      !isPending &&
      phone &&
      message.conversation.inbox?.channelType === 'whatsapp'
    ) {
      try {
        // AUDIT-REACTION-JID: usa o remoteJid REAL gravado pelo webhook no
        // metadata da mensagem (nº brasileiro com/sem 9 diverge do JID
        // derivado do telefone e o WhatsApp não acha a msg alvo).
        const meta =
          message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
            ? (message.metadata as Record<string, unknown>)
            : {};
        await evolutionService.sendReaction(accountId, {
          number: phone,
          remoteJid: typeof meta.remoteJid === 'string' ? meta.remoteJid : null,
          reaction: emojiTrim,
          reactionToMsgId: externalId,
          // A msg reagida foi enviada por nós se senderType!=='customer'.
          fromMe: message.senderType !== 'customer',
          instance: message.conversation.inbox.evolutionInstance ?? null,
        });
      } catch (err) {
        logger.warn('[message] falha ao propagar reaction para Evolution', {
          messageId: message.id,
          accountId,
          emoji: emojiTrim,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // CHAT-REACTIONS FURO 2: broadcast pra todos os agentes com a thread aberta.
    await this.emitReactionUpdate(accountId, message.conversationId, message.id);

    return reaction;
  }

  /**
   * Remove reaction do usuário atual na mensagem. Idempotente: se não existe,
   * retorna null sem erro. Evolution propaga vazio via sendReaction('', ...)
   * (WhatsApp interpreta como remoção da reaction).
   */
  async removeReaction(
    messageId: string,
    accountId: string,
    userId: string,
    emoji: string
  ): Promise<{ removed: boolean }> {
    const emojiTrim = (emoji || '').trim();
    if (!emojiTrim) {
      throw new ValidationError('emoji é obrigatório');
    }

    const message = await prisma.message.findFirst({
      where: { id: messageId, conversation: { accountId } },
      include: {
        conversation: {
          include: {
            contact: { select: { telefone: true } },
            inbox: { select: { channelType: true, evolutionInstance: true } },
          },
        },
      },
    });
    if (!message) throw new NotFoundError('Mensagem');

    const deleted = await prisma.messageReaction.deleteMany({
      where: {
        messageId: message.id,
        userId,
        emoji: emojiTrim,
      },
    });

    // Propaga "sem reaction" pro WhatsApp — envia string vazia (padrão Baileys).
    const phone = message.conversation.contact?.telefone ?? '';
    const externalId = message.externalId ?? '';
    const isPending = externalId.startsWith('pending:');
    if (
      deleted.count > 0 &&
      externalId &&
      !isPending &&
      phone &&
      message.conversation.inbox?.channelType === 'whatsapp'
    ) {
      try {
        // AUDIT-REACTION-JID: mesmo tratamento do addReaction.
        const meta =
          message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
            ? (message.metadata as Record<string, unknown>)
            : {};
        await evolutionService.sendReaction(accountId, {
          number: phone,
          remoteJid: typeof meta.remoteJid === 'string' ? meta.remoteJid : null,
          reaction: '',
          reactionToMsgId: externalId,
          fromMe: message.senderType !== 'customer',
          instance: message.conversation.inbox.evolutionInstance ?? null,
        });
      } catch (err) {
        logger.warn('[message] falha ao remover reaction no Evolution', {
          messageId: message.id,
          accountId,
          emoji: emojiTrim,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // CHAT-REACTIONS FURO 2: emite mesmo quando deleted.count === 0 é possivel
    // que outra tab do mesmo user já tenha removido; sincronizamos igual pra
    // manter o cache dos clientes consistente sem custo extra relevante.
    if (deleted.count > 0) {
      await this.emitReactionUpdate(accountId, message.conversationId, message.id);
    }

    return { removed: deleted.count > 0 };
  }

  /**
   * Lista reactions de uma mensagem (agrupadas pelo caller se necessário).
   * Escopado por accountId via conversation.
   */
  async listReactions(
    messageId: string,
    accountId: string
  ): Promise<MessageReaction[]> {
    const message = await prisma.message.findFirst({
      where: { id: messageId, conversation: { accountId } },
      select: { id: true },
    });
    if (!message) throw new NotFoundError('Mensagem');

    return prisma.messageReaction.findMany({
      where: { messageId: message.id },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, nome: true, email: true } },
      },
    });
  }

  /**
   * CHAT-REACTIONS webhook: registra reaction vinda do CLIENTE via
   * MESSAGES_UPSERT com envelope reactionMessage. userId=NULL,
   * externalContactId=remoteJid.
   *
   * Idempotente: usa índice único parcial em (messageId, externalContactId, emoji)
   * — se já existe, faz nada. Se emoji vazio (WhatsApp manda emoji='' para "unreact"),
   * remove a reaction existente daquele contato nessa msg.
   */
  async recordCustomerReaction(input: {
    accountId: string;
    targetExternalId: string;
    externalContactId: string;
    emoji: string;
  }): Promise<void> {
    const emojiTrim = (input.emoji || '').trim();
    // Localiza a Message pelo externalId + accountId. Selecionamos
    // conversationId pra poder emitir socket na sala da conversa após
    // persistir (CHAT-REACTIONS FURO 2).
    const message = await prisma.message.findFirst({
      where: {
        externalId: input.targetExternalId,
        conversation: { accountId: input.accountId },
      },
      select: { id: true, conversationId: true },
    });
    if (!message) {
      logger.debug('[message.service] customer reaction sem msg alvo — skip', {
        externalId: input.targetExternalId,
        accountId: input.accountId,
      });
      return;
    }

    if (!emojiTrim) {
      // unreact: apaga o que houver desse contato na msg.
      const removed = await prisma.messageReaction.deleteMany({
        where: {
          messageId: message.id,
          userId: null,
          externalContactId: input.externalContactId,
        },
      });
      if (removed.count > 0) {
        await this.emitReactionUpdate(
          input.accountId,
          message.conversationId,
          message.id
        );
      }
      return;
    }

    // upsert com base no índice único parcial (messageId, externalContactId, emoji).
    // findFirst → create/skip pra não depender de índice único no Prisma client.
    const existing = await prisma.messageReaction.findFirst({
      where: {
        messageId: message.id,
        userId: null,
        externalContactId: input.externalContactId,
        emoji: emojiTrim,
      },
      select: { id: true },
    });
    if (existing) return;

    // Antes de criar novo emoji, apaga reactions anteriores do MESMO contato
    // nessa msg — WhatsApp só permite 1 reaction por remetente por msg.
    await prisma.messageReaction.deleteMany({
      where: {
        messageId: message.id,
        userId: null,
        externalContactId: input.externalContactId,
      },
    });

    await prisma.messageReaction.create({
      data: {
        messageId: message.id,
        userId: null,
        externalContactId: input.externalContactId,
        emoji: emojiTrim,
      },
    });

    // CHAT-REACTIONS FURO 2: broadcast pro frontend (agentes com a thread
    // aberta veem o novo emoji do cliente aparecer sem F5).
    await this.emitReactionUpdate(
      input.accountId,
      message.conversationId,
      message.id
    );
  }
}

export const messageService = new MessageService();
