import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../config/database';
import { AuthenticatedRequest } from '../types';
import {
  messageService,
  type CreateAttachmentInput,
  type CreateMessageInput,
  type MessageContentType,
  type MessageSenderType,
} from '../services/message.service';
import { evolutionService } from '../services/evolution.service';
import { apiKeyHasScope } from '../middlewares/apiKey.middleware';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../utils/errors';
import { logger } from '../utils/logger';

// ============================================
// Validation schemas
// ============================================

const attachmentSchema = z.object({
  fileType: z.enum(['image', 'video', 'audio', 'document']),
  fileUrl: z.string().min(1),
  fileSize: z.number().int().nonnegative().optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  duration: z.number().int().nonnegative().optional(),
});

// BE-CTRL-H2: contentTypes permitidos para agentes humanos (JWT).
// system_note e template são exclusivos do backend (jobs, campanhas,
// eventos do sistema) — agentes não podem forjar via POST.
const agentContentTypeEnum = z.enum([
  'text',
  'media',
  'audio',
  'document',
]);

const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  after: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
});

const createMessageBodySchema = z
  .object({
    content: z.string().optional(),
    contentType: agentContentTypeEnum.optional(),
    isPrivate: z.boolean().optional(),
    replyToId: z.string().uuid().optional(),
    attachments: z.array(attachmentSchema).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine(
    payload =>
      (typeof payload.content === 'string' && payload.content.trim() !== '') ||
      (Array.isArray(payload.attachments) && payload.attachments.length > 0),
    { message: 'Mensagem precisa de content ou attachments' }
  );

const searchQuerySchema = z.object({
  q: z.string().min(2, 'q precisa ter pelo menos 2 caracteres'),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const integrationSenderTypeEnum = z.enum(['ai_bot', 'integration']);

// BE-CTRL-H2: integrações (ai_bot/n8n) também não podem forjar system_note
// nem template — esses tipos disparam regras de skip-dispatch e são
// reservados a fluxos internos (backend jobs, whatsapp-campaign).
const integrationContentTypeEnum = z.enum([
  'text',
  'media',
  'audio',
  'document',
]);

const integrationCreateBodySchema = z
  .object({
    content: z.string().optional(),
    contentType: integrationContentTypeEnum.optional(),
    sender_type: integrationSenderTypeEnum,
    metadata: z.record(z.unknown()).optional(),
    attachments: z.array(attachmentSchema).optional(),
    replyToId: z.string().uuid().optional(),
    isPrivate: z.boolean().optional(),
  })
  .refine(
    payload =>
      (typeof payload.content === 'string' && payload.content.trim() !== '') ||
      (Array.isArray(payload.attachments) && payload.attachments.length > 0),
    { message: 'Mensagem precisa de content ou attachments' }
  );

// ============================================
// Helpers
// ============================================

interface CircuitBreakerCheckResult {
  blocked: boolean;
  reason?: string;
}

function checkAiCircuitBreaker(
  customAttributes: unknown
): CircuitBreakerCheckResult {
  if (
    customAttributes &&
    typeof customAttributes === 'object' &&
    !Array.isArray(customAttributes)
  ) {
    const attrs = customAttributes as Record<string, unknown>;
    if (attrs.human_active === true) {
      return {
        blocked: true,
        reason: 'AI suspensa: atendimento humano ativo (human_active=true)',
      };
    }
  }
  return { blocked: false };
}

export class MessageController {
  // ============================================
  // JWT (agent/admin/super_admin)
  // ============================================

  /**
   * GET /api/conversations/:conversationId/messages
   * Query: limit, before, after (ISO 8601)
   */
  async list(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError();
      const accountId = req.user.accountId;
      if (!accountId) throw new ValidationError('accountId obrigatório');

      const conversationId = req.params.conversationId as string;
      const parsed = listMessagesQuerySchema.parse(req.query);

      const data = await messageService.list(conversationId, accountId, {
        limit: parsed.limit,
        before: parsed.before,
        after: parsed.after,
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/conversations/:conversationId/messages
   * Body: { content, contentType?, isPrivate?, replyToId?, attachments? }
   *
   * Cria a Message e — se não for nota interna — dispara via Evolution.
   * O resultado do provider grava externalId; falha no provider marca a
   * mensagem como `failed` mas NÃO derruba a request (a mensagem já está
   * persistida).
   */
  async create(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError();
      const accountId = req.user.accountId;
      if (!accountId) throw new ValidationError('accountId obrigatório');

      const conversationId = req.params.conversationId as string;
      const parsed = createMessageBodySchema.parse(req.body ?? {});

      const senderType: MessageSenderType = 'agent';
      const contentType: MessageContentType = parsed.contentType ?? 'text';
      const isPrivate = parsed.isPrivate ?? false;

      // SE-H5: prepara externalId interno (pending:<uuid>) ANTES de criar
      // a mensagem. Assim, se o webhook fromMe=true da Evolution chegar
      // antes do update com o messageId real, o dedup por externalId
      // (combinado com a unique constraint) já encontra a linha — em vez
      // de criar uma duplicata por (externalId IS NULL).
      // shouldDispatch=true ⇒ reserva slot; false ⇒ mantém null.
      // BE-CTRL-H2: contentType já está restrito a text|media|audio|document
      // pelo agentContentTypeEnum, então system_note/template não chegam aqui.
      const shouldDispatch =
        !isPrivate &&
        typeof parsed.content === 'string' &&
        parsed.content.trim() !== '';

      const pendingExternalId = shouldDispatch
        ? `pending:${randomUUID()}`
        : null;

      const input: CreateMessageInput = {
        conversationId,
        senderType,
        senderId: req.user.id,
        content: parsed.content ?? null,
        contentType,
        isPrivate,
        replyToId: parsed.replyToId ?? null,
        attachments: parsed.attachments as CreateAttachmentInput[] | undefined,
        metadata: pendingExternalId
          ? { ...(parsed.metadata ?? {}), pendingExternalId }
          : parsed.metadata,
        externalId: pendingExternalId,
      };

      const message = await messageService.create(accountId, input);

      let finalMessage = message;

      if (shouldDispatch) {
        const conversation = await prisma.conversation.findFirst({
          where: { id: conversationId, accountId },
          include: {
            contact: { select: { telefone: true } },
            inbox: { select: { channelType: true } },
          },
        });

        const phone = conversation?.contact?.telefone ?? '';

        if (conversation?.inbox?.channelType === 'whatsapp' && phone) {
          try {
            const result = await evolutionService.sendText(accountId, {
              number: phone,
              text: parsed.content as string,
            });

            if (result.messageId) {
              // Troca o pending:<uuid> pelo messageId real da Evolution.
              // Se o webhook fromMe já tiver chegado e criado/atualizado a
              // linha pelo externalId real, este update vai falhar
              // silenciosamente — mas a mensagem original com pending
              // continua íntegra e pode ser reconciliada via metadata.
              finalMessage = await prisma.message.update({
                where: { id: message.id },
                data: { externalId: result.messageId, status: 'sent' },
              });
            }
          } catch (err) {
            const errMsg =
              err instanceof Error ? err.message : String(err);
            logger.warn('[message] falha ao enviar via Evolution', {
              messageId: message.id,
              accountId,
              error: errMsg,
            });
            try {
              finalMessage = await messageService.markFailed(
                message.id,
                accountId,
                errMsg
              );
            } catch (markErr) {
              logger.warn('[message] falha ao marcar mensagem como failed', {
                messageId: message.id,
                error:
                  markErr instanceof Error
                    ? markErr.message
                    : String(markErr),
              });
            }
          }
        } else {
          logger.info(
            '[message] dispatch ignorado — canal não suportado ou telefone ausente',
            {
              conversationId,
              accountId,
              hasPhone: Boolean(phone),
              channel: conversation?.inbox?.channelType ?? null,
            }
          );
        }
      }

      res.status(201).json({ data: finalMessage });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/messages/:id/read
   * Marca a mensagem como lida pelo usuário autenticado.
   */
  async markRead(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError();
      const accountId = req.user.accountId;
      if (!accountId) throw new ValidationError('accountId obrigatório');

      const id = req.params.id as string;
      const data = await messageService.markRead(id, accountId, req.user.id);

      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/messages/search?q=...&limit=...
   * Busca ILIKE em messages.content escopado por accountId.
   */
  async search(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError();
      const accountId = req.user.accountId;
      if (!accountId) throw new ValidationError('accountId obrigatório');

      const parsed = searchQuerySchema.parse(req.query);
      const data = await messageService.search(accountId, parsed.q, {
        limit: parsed.limit,
        requesterRole: req.user.role,
        requesterUserId: req.user.id,
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // API Key (integrações: n8n / agentes IA)
  // ============================================

  /**
   * POST /api/integrations/chat/conversations/:id/messages
   * Body: { content, sender_type: 'ai_bot' | 'integration', metadata?, attachments? }
   *
   * Reaproveita messageService.create — única diferença vs JWT:
   *  - auth via API key (requireApiKey popula req.accountId)
   *  - senderType vem do body (somente 'ai_bot' ou 'integration')
   *  - circuit breaker: se conversation.customAttributes.human_active === true,
   *    rejeita com 409 (humano assumiu, IA não pode falar).
   */
  async createFromIntegration(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.accountId;
      if (!accountId) {
        res.status(401).json({ error: 'API key inválida ou revogada' });
        return;
      }

      const conversationId = req.params.id as string;
      const parsed = integrationCreateBodySchema.parse(req.body ?? {});

      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, accountId },
        select: {
          id: true,
          customAttributes: true,
          contact: { select: { telefone: true } },
          inbox: { select: { channelType: true } },
        },
      });

      if (!conversation) {
        throw new NotFoundError('Conversa');
      }

      // Circuit breaker: humano assumiu → IA não fala
      const breaker = checkAiCircuitBreaker(conversation.customAttributes);
      if (breaker.blocked) {
        throw new ConflictError(breaker.reason ?? 'AI suspensa', {
          code: 'AI_CIRCUIT_BREAKER_OPEN',
        });
      }

      const senderType: MessageSenderType = parsed.sender_type;
      const contentType: MessageContentType = parsed.contentType ?? 'text';
      const isPrivate = parsed.isPrivate ?? false;

      // CHAT-AUTH-H3: notas internas (isPrivate=true) só com scope dedicado.
      // Bots públicos com 'messages:write' não devem conseguir falsificar
      // histórico interno aparecendo como nota de operador.
      if (isPrivate && !apiKeyHasScope(req.apiKey?.scopes, ['messages:notes'])) {
        throw new ForbiddenError(
          'API key sem permissão para criar notas internas (isPrivate=true). Scope necessário: messages:notes'
        );
      }

      // SE-H5: mesma estratégia da rota JWT — reserva externalId pending
      // antes do create para fechar a janela de race com webhook fromMe.
      // BE-CTRL-H2: contentType restrito pelo integrationContentTypeEnum.
      const shouldDispatch =
        !isPrivate &&
        typeof parsed.content === 'string' &&
        parsed.content.trim() !== '';

      const pendingExternalId = shouldDispatch
        ? `pending:${randomUUID()}`
        : null;

      const input: CreateMessageInput = {
        conversationId,
        senderType,
        senderId: null,
        content: parsed.content ?? null,
        contentType,
        isPrivate,
        replyToId: parsed.replyToId ?? null,
        attachments: parsed.attachments as CreateAttachmentInput[] | undefined,
        metadata: {
          ...(parsed.metadata ?? {}),
          source: 'api_integration',
          apiKeyId: req.apiKey?.id ?? null,
          ...(pendingExternalId ? { pendingExternalId } : {}),
        },
        externalId: pendingExternalId,
      };

      const message = await messageService.create(accountId, input);

      let finalMessage = message;

      if (shouldDispatch) {
        const phone = conversation.contact?.telefone ?? '';
        if (conversation.inbox?.channelType === 'whatsapp' && phone) {
          try {
            const result = await evolutionService.sendText(accountId, {
              number: phone,
              text: parsed.content as string,
            });
            if (result.messageId) {
              finalMessage = await prisma.message.update({
                where: { id: message.id },
                data: { externalId: result.messageId, status: 'sent' },
              });
            }
          } catch (err) {
            const errMsg =
              err instanceof Error ? err.message : String(err);
            logger.warn(
              '[message-integration] falha ao enviar via Evolution',
              {
                messageId: message.id,
                accountId,
                error: errMsg,
              }
            );
            try {
              finalMessage = await messageService.markFailed(
                message.id,
                accountId,
                errMsg
              );
            } catch (markErr) {
              logger.warn(
                '[message-integration] falha ao marcar mensagem como failed',
                {
                  messageId: message.id,
                  error:
                    markErr instanceof Error
                      ? markErr.message
                      : String(markErr),
                }
              );
            }
          }
        }
      }

      res.status(201).json({ data: finalMessage });
    } catch (error) {
      next(error);
    }
  }
}

export const messageController = new MessageController();
