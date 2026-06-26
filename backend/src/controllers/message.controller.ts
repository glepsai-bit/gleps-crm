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
import { conversationService } from '../services/conversation.service';
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

// H-CHAT-1 + L-CHAT-1: cap em todos os campos string para impedir payloads
// gigantes (ex.: 1MB de content) que persistem no banco mas são cortados
// pela Evolution em ~4096 chars. URLs/file names também recebem cap
// defensivo pra evitar abuso (preencher disco / quebrar logs / DoS de I/O).
//
// L-CHAT-1: fileUrl aceita data URL base64 de anexo (frontend limita a 5MB).
// 5MB binario => ~6.67MB em base64 + header data:; previne payload absurdo
// de cliente custom (curl, n8n, etc.) mas sem quebrar o fluxo legitimo.
// mimeType e fileName ja tinham cap; mantido. Cap conservador em 7MB.
const attachmentSchema = z.object({
  fileType: z.enum(['image', 'video', 'audio', 'document']),
  fileUrl: z.string().min(1).max(7_000_000, 'Anexo muito grande (max ~5MB base64)'),
  fileSize: z.number().int().nonnegative().optional(),
  fileName: z.string().max(512, 'fileName muito longo (max 512 caracteres)').optional(),
  mimeType: z.string().max(128, 'mimeType muito longo (max 128 caracteres)').optional(),
  thumbnailUrl: z.string().max(7_000_000, 'thumbnailUrl muito grande (max ~5MB base64)').optional(),
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

// H-CHAT-1: WhatsApp/Evolution corta em ~4096 chars. Sem .max() aqui
// um POST de 1MB de content persistia no banco mas saía truncado no
// WhatsApp — silenciosamente. Rejeitar no parse evita o lixo no DB.
const MAX_MESSAGE_CONTENT_LEN = 4096;

const createMessageBodySchema = z
  .object({
    content: z
      .string()
      .max(MAX_MESSAGE_CONTENT_LEN, 'Mensagem muito longa (max 4096 caracteres)')
      .optional(),
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

// H-CHAT-1: mesmo cap da rota JWT — bots/n8n também não podem injetar
// content gigante (provider corta no envio, mas o registro fica gordo).
const integrationCreateBodySchema = z
  .object({
    content: z
      .string()
      .max(MAX_MESSAGE_CONTENT_LEN, 'Mensagem muito longa (max 4096 caracteres)')
      .optional(),
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

      // LIFECYCLE-BUG-4: no fluxo nativo T-022 (REMOVED legacy controller), o circuit
      // breaker do IA não tinha quem o acionasse — só o controller externo
      // legado marcava `human_active=true`. Resultado: a IA via
      // /integrations/chat seguia respondendo livremente mesmo depois do
      // humano assumir, porque `checkAiCircuitBreaker` lê esse mesmo flag.
      //
      // Marca aqui sempre que um agente humano (senderType='agent') manda
      // uma resposta pública (não nota interna). Idempotente: o próprio
      // service faz early-return se já estiver true; falha não derruba a
      // request (a mensagem já foi persistida e o dispatch ainda precisa rodar).
      if (!isPrivate) {
        try {
          await conversationService.markHumanActive(
            conversationId,
            accountId,
            req.user.id
          );
        } catch (err) {
          logger.warn('[message] falha ao acionar circuit breaker do IA', {
            conversationId,
            accountId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      let finalMessage = message;

      if (shouldDispatch) {
        const conversation = await prisma.conversation.findFirst({
          where: { id: conversationId, accountId },
          include: {
            contact: { select: { telefone: true } },
            inbox: {
              select: { channelType: true, evolutionInstance: true },
            },
          },
        });

        const phone = conversation?.contact?.telefone ?? '';

        if (conversation?.inbox?.channelType === 'whatsapp' && phone) {
          try {
            // Per-Inbox: respeitar a instância do Inbox da conversa para não
            // cair no fallback Account.evolutionInstance (que pode estar null
            // ou apontar para outro número).
            const result = await evolutionService.sendText(accountId, {
              number: phone,
              text: parsed.content as string,
              instance: conversation.inbox.evolutionInstance ?? null,
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
   * POST /api/messages/:id/retry
   *
   * CHAT-MSG-FAILED-007: tenta reenviar uma mensagem que ficou status='failed'
   * (ex.: Evolution voltou 400 na primeira tentativa). Reseta o status para
   * 'sending' via messageService.resetFailed e re-dispara pelo provider
   * exatamente como o create() faz. Mensagem privada/sem content não é re-enviada.
   */
  async retry(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError();
      const accountId = req.user.accountId;
      if (!accountId) throw new ValidationError('accountId obrigatório');

      const id = req.params.id as string;

      const message = await prisma.message.findFirst({
        where: { id, conversation: { accountId } },
        include: {
          conversation: {
            include: {
              contact: { select: { telefone: true } },
              inbox: {
                select: { channelType: true, evolutionInstance: true },
              },
            },
          },
        },
      });
      if (!message) throw new NotFoundError('Mensagem');

      if (message.isPrivate) {
        throw new ValidationError('Nota interna não pode ser reenviada');
      }
      if (!message.content || message.content.trim() === '') {
        throw new ValidationError('Mensagem sem conteúdo não pode ser reenviada');
      }

      // Resetar para 'sending'; falha aqui (status != failed) propaga 422.
      let updated = await messageService.resetFailed(id, accountId);

      const phone = message.conversation.contact?.telefone ?? '';
      const channel = message.conversation.inbox?.channelType;

      if (channel === 'whatsapp' && phone) {
        try {
          const result = await evolutionService.sendText(accountId, {
            number: phone,
            text: message.content,
            instance: message.conversation.inbox?.evolutionInstance ?? null,
          });
          if (result.messageId) {
            updated = await prisma.message.update({
              where: { id },
              data: { externalId: result.messageId, status: 'sent' },
            });
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn('[message] retry falhou no Evolution', {
            messageId: id,
            accountId,
            error: errMsg,
          });
          updated = await messageService.markFailed(id, accountId, errMsg);
        }
      }

      res.json({ data: updated });
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
          inbox: {
            select: { channelType: true, evolutionInstance: true },
          },
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
            // Per-Inbox: idem rota JWT — passar instance do Inbox para
            // garantir que o dispatch vai pela conexão certa.
            const result = await evolutionService.sendText(accountId, {
              number: phone,
              text: parsed.content as string,
              instance: conversation.inbox.evolutionInstance ?? null,
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
