import { Request, Response, NextFunction } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { prisma } from '../config/database';
import { attachmentStorageService } from '../services/attachment-storage.service';
import { conversationService } from '../services/conversation.service';
import { csatService } from '../services/csat.service';
import { messageService, type MessageSenderType } from '../services/message.service';
import { evolutionService } from '../services/evolution.service';
import { NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

/* ============================================================================
 * INTEGRATION CHAT API (T-CHAT-API)
 *
 * Endpoints externos (API key) para integrações n8n / agentes IA terem
 * autonomia completa de atendimento — sem sessão JWT do CRM.
 *
 * Todos os endpoints são montados em `/api/integrations/chat/*` (ver
 * routes/index.ts). O middleware `requireApiKey` popula `req.accountId`
 * e `req.apiKey`. O scoping por accountId é OBRIGATÓRIO em toda mutation.
 *
 * Padrão de resposta:
 *   - leitura  → { data: <obj> }
 *   - escrita  → { data: <obj atualizado> }
 *   - ações sem retorno relevante (delete) → { ok: true }
 *
 * Scopes:
 *   - chat:read   → GET conversation
 *   - chat:write  → todas as mutations
 *   Alias: continuamos aceitando `messages:write` em send-message para que
 *   API keys legadas (criadas antes de chat:write existir) não quebrem.
 *
 * Toda lógica de mutação delega para conversationService / messageService —
 * controllers são FINOS (validar → resolver actor → chamar service → log).
 * ========================================================================= */

// ───────────────────────────────────────────────────────────────────────────
// Validation schemas
// ───────────────────────────────────────────────────────────────────────────

const uuidSchema = z.string().uuid({ message: 'id deve ser um UUID válido' });

const ALLOWED_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const ALLOWED_RESOLVED_BY = ['ai', 'human', 'timeout'] as const;
const ALLOWED_CONTENT_TYPES = ['text', 'media', 'audio', 'document'] as const;
const ALLOWED_SENDER_TYPES = ['ai_bot', 'integration', 'system'] as const;

const MAX_MESSAGE_CONTENT_LEN = 4096;

const sendMessageSchema = z
  .object({
    content: z.string().max(MAX_MESSAGE_CONTENT_LEN, 'Mensagem muito longa (max 4096 caracteres)'),
    contentType: z.enum(ALLOWED_CONTENT_TYPES).optional(),
    isPrivate: z.boolean().optional(),
    senderType: z.enum(ALLOWED_SENDER_TYPES).optional(),
    metadata: z.record(z.unknown()).optional(),
    replyToId: z.string().uuid().optional(),
  })
  .refine((d) => d.content.trim().length > 0, {
    message: 'content não pode ser vazio',
    path: ['content'],
  });

const sendNoteSchema = z.object({
  content: z
    .string()
    .min(1, 'content é obrigatório')
    .max(MAX_MESSAGE_CONTENT_LEN, 'Mensagem muito longa (max 4096 caracteres)'),
});

const assignSchema = z
  .object({
    userId: z.string().uuid().optional(),
    userEmail: z.string().email().optional(),
  })
  .refine((d) => Boolean(d.userId || d.userEmail), {
    message: 'Informe userId (UUID) ou userEmail',
  });

const assignTeamSchema = z
  .object({
    teamId: z.string().uuid().optional(),
    teamSlug: z.string().min(1).max(120).optional(),
  })
  .refine((d) => Boolean(d.teamId || d.teamSlug), {
    message: 'Informe teamId (UUID) ou teamSlug (nome do time)',
  });

const transferSchema = z
  .object({
    toUserId: z.string().uuid().optional(),
    toTeamId: z.string().uuid().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((d) => Boolean(d.toUserId) !== Boolean(d.toTeamId), {
    message: 'Informe exatamente um entre toUserId OU toTeamId',
  });

// SLA v2 — outcome obrigatorio, sendCsat default true. resolvedBy default 'ai'
// pra api-key (origem comum: n8n).
//
// SLA v2.1: internalRating eh DEPRECATED no contexto de SLA — eh auxiliar
// (auto-avaliacao do agente/IA) e nao integra o dashboard de SLA. Mantemos
// no schema por backcompat de integracoes n8n existentes, mas o controller
// loga um warning. Para capturar avaliacao real DO CLIENTE use
// POST /integrations/chat/conversations/:id/send-csat.
const ALLOWED_OUTCOMES = [
  'resolved',
  'transferred',
  'spam',
  'not_related',
  'abandoned',
  'unable_to_resolve',
] as const;

const resolveSchema = z.object({
  resolvedBy: z.enum(ALLOWED_RESOLVED_BY).optional(),
  outcome: z.enum(ALLOWED_OUTCOMES),
  /**
   * @deprecated SLA v2.1 — internalRating eh auxiliar (auto-avaliacao
   * agente/IA) e nao integra o SLA. Use endpoint send-csat para CSAT real.
   */
  internalRating: z.number().int().min(1).max(5).optional(),
  reason: z.string().trim().max(500).optional(),
  sendCsatToCustomer: z.boolean().default(true),
});

// Body do POST /integrations/chat/conversations/:id/send-csat
const sendCsatSchema = z.object({
  customMessage: z.string().min(1).max(1000).optional(),
  force: z.boolean().optional(),
});

// Aceita ambos shapes — alinhado com o fix de customAttrsSchema em conversation.controller.
const customAttrsSchema = z
  .object({
    attrs: z.record(z.unknown()).optional(),
    customAttributes: z.record(z.unknown()).optional(),
  })
  .refine((d) => d.attrs !== undefined || d.customAttributes !== undefined, {
    message: 'Informe attrs ou customAttributes',
  })
  .transform((d) => ({
    attrs: (d.attrs ?? d.customAttributes) as Record<string, unknown>,
  }));

const prioritySchema = z.object({
  priority: z.enum(ALLOWED_PRIORITIES),
});

const labelSchema = z
  .object({
    tagId: z.string().uuid().optional(),
    label: z.string().min(1).max(60).optional(),
  })
  .refine((d) => Boolean(d.tagId || d.label), {
    message: 'Informe tagId (UUID) ou label (string)',
  });

const snoozeSchema = z
  .object({
    snoozedUntil: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
    hours: z.number().positive().max(24 * 30).optional(),
  })
  .refine((d) => Boolean(d.snoozedUntil || d.hours), {
    message: 'Informe snoozedUntil (ISO) ou hours (number)',
  });

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * UUID-formatado para servir de actorId quando a operação é feita por uma
 * API key (não por um User). Os services downstream gravam esse id em
 * Event.actorId / LeadTag.appliedById / TagHistory.actorId — campos do tipo
 * @db.Uuid sem FK rígida. Antes, passar strings como `api:<apikeyid>` quebrava
 * a validação Prisma (UUID inválido) e fazia o transaction.commit explodir.
 *
 * Preferimos `req.apiKey.id` (que JÁ é um UUID e identifica a integração) —
 * só caímos pro sentinel `0000…` quando o middleware não populou apiKey
 * (caminho impossível em runtime mas faz o tipo fechar).
 */
const AI_SENTINEL_UUID = '00000000-0000-0000-0000-000000000000';

function apiActorId(req: Request): string {
  return req.apiKey?.id ?? AI_SENTINEL_UUID;
}

function requireAccountId(req: Request): string {
  const accountId = req.accountId;
  if (!accountId) {
    throw new UnauthorizedError('API key inválida ou revogada');
  }
  return accountId;
}

function parseUuidParam(value: string | string[] | undefined, label = 'id'): string {
  const v = typeof value === 'string' ? value : '';
  const parsed = uuidSchema.safeParse(v);
  if (!parsed.success) {
    throw new ValidationError(`${label} inválido`, { issues: parsed.error.issues });
  }
  return parsed.data;
}

async function requireConversationInAccount(
  conversationId: string,
  accountId: string
) {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, accountId },
    select: {
      id: true,
      accountId: true,
      status: true,
      contactId: true,
      inboxId: true,
      customAttributes: true,
    },
  });
  if (!conv) throw new NotFoundError('Conversa');
  return conv;
}

/**
 * Helper: marca a conversa como "tocada pela IA" — facilita filtros de
 * métricas (quantas conversas tiveram intervenção IA, qual a taxa de
 * resolução automática etc).
 *
 * Idempotente: nunca falha o request principal — log e segue.
 */
async function markAiHandled(
  conversationId: string,
  accountId: string,
  options: { setResolvedByAttr?: boolean } = {}
): Promise<void> {
  try {
    const attrs: Record<string, unknown> = {
      ai_handled: true,
      ai_handled_at: new Date().toISOString(),
    };
    if (options.setResolvedByAttr) {
      attrs.resolved_by_attr = 'ai';
    }
    // setCustomAttributes faz merge profundo (não sobrescreve outras chaves).
    // O userId aqui só vai pro eventService.create (actorId), que é envolvido
    // em try/catch no próprio service — se o id não for FK válida o evento
    // simplesmente não é gravado, mas a mutation segue. Passamos um UUID
    // sentinel zerado para satisfazer o tipo @db.Uuid.
    await conversationService.setCustomAttributes(
      conversationId,
      accountId,
      attrs,
      AI_SENTINEL_UUID
    );
  } catch (err) {
    logger.warn('[integration-chat] markAiHandled falhou', {
      conversationId,
      accountId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Controller
// ───────────────────────────────────────────────────────────────────────────

class IntegrationChatController {
  // ============================================
  // GET /conversations/:id
  // ============================================
  async getConversation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);

      // get() com include messages+labels — payload completo pra IA decidir.
      // limit de 10 últimas mensagens é aplicado abaixo (slicing); o service
      // não tem cap por argumento então usamos slice no resultado.
      const conv = await conversationService.get(
        id,
        accountId,
        { messages: true, labels: true, participants: true }
      );

      // Slice das 10 últimas mensagens (vem em ordem ASC do service).
      const messages = Array.isArray((conv as any).messages)
        ? ((conv as any).messages as any[]).slice(-10)
        : [];

      logger.info('[integration-chat] get conversation', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
      });

      res.status(200).json({
        data: {
          ...(conv as any),
          messages,
          customAttributes:
            (conv as any).customAttributes &&
            typeof (conv as any).customAttributes === 'object'
              ? (conv as any).customAttributes
              : {},
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // POST /conversations/:id/messages
  // ============================================
  async sendMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);
      const parsed = sendMessageSchema.parse(req.body ?? {});

      const conv = await requireConversationInAccount(id, accountId);

      const senderType: MessageSenderType = (parsed.senderType ??
        'ai_bot') as MessageSenderType;
      const isPrivate = parsed.isPrivate ?? false;
      const contentType = parsed.contentType ?? 'text';

      const message = await messageService.create(accountId, {
        conversationId: id,
        senderType,
        senderId: null,
        content: parsed.content,
        contentType,
        isPrivate,
        replyToId: parsed.replyToId ?? null,
        metadata: {
          ...(parsed.metadata ?? {}),
          source: 'api_integration',
          apiKeyId: req.apiKey?.id ?? null,
        },
      });

      // Dispatch via Evolution só se for mensagem pública de texto e a
      // conversa estiver num inbox WhatsApp.
      let finalMessage = message;
      if (!isPrivate && contentType === 'text' && parsed.content.trim()) {
        const full = await prisma.conversation.findFirst({
          where: { id, accountId },
          select: {
            contact: { select: { telefone: true } },
            inbox: { select: { channelType: true, evolutionInstance: true } },
          },
        });
        const phone = full?.contact?.telefone ?? '';
        if (full?.inbox?.channelType === 'whatsapp' && phone) {
          try {
            const result = await evolutionService.sendText(accountId, {
              number: phone,
              text: parsed.content,
              instance: full.inbox.evolutionInstance ?? null,
            });
            if (result.messageId) {
              finalMessage = await prisma.message.update({
                where: { id: message.id },
                data: { externalId: result.messageId, status: 'sent' },
              });
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.warn('[integration-chat] envio Evolution falhou', {
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
            } catch {
              /* ignore — mensagem já persistida */
            }
          }
        }
      }

      // Marca a conversa como tocada pela IA quando o sender é ai_bot
      // (n8n agente IA) — facilita filtros de métricas (Bug A).
      if (senderType === 'ai_bot' && !isPrivate) {
        // Só seta resolved_by_attr quando ainda nao houve resolucao.
        await markAiHandled(id, accountId, {
          setResolvedByAttr: conv.status !== 'resolved',
        });
      }

      logger.info('[integration-chat] message sent', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
        messageId: finalMessage.id,
        senderType,
        isPrivate,
      });

      res.status(201).json({ data: finalMessage });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // POST /conversations/:id/notes
  // ============================================
  async sendNote(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);
      const parsed = sendNoteSchema.parse(req.body ?? {});

      await requireConversationInAccount(id, accountId);

      const message = await messageService.create(accountId, {
        conversationId: id,
        senderType: 'system',
        senderId: null,
        content: parsed.content,
        contentType: 'system_note',
        isPrivate: true,
        metadata: {
          source: 'api_integration_note',
          apiKeyId: req.apiKey?.id ?? null,
        },
      });

      logger.info('[integration-chat] note created', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
        messageId: message.id,
      });

      res.status(201).json({ data: message });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // POST /conversations/:id/assign
  // ============================================
  async assign(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);
      const parsed = assignSchema.parse(req.body ?? {});

      await requireConversationInAccount(id, accountId);

      // Resolve user por email se userId não veio
      let userId = parsed.userId ?? null;
      if (!userId && parsed.userEmail) {
        const user = await prisma.user.findFirst({
          where: {
            accountId,
            email: parsed.userEmail.toLowerCase(),
          },
          select: { id: true },
        });
        if (!user) throw new NotFoundError('Usuário');
        userId = user.id;
      }

      if (!userId) {
        // Não deveria chegar aqui pelo refine, mas guard defensivo.
        throw new ValidationError('userId ou userEmail é obrigatório');
      }

      const updated = await conversationService.assign(
        id,
        accountId,
        userId,
        // byUserId — usamos 'api:<apiKeyId>' como sentinel actor.
        // O service só usa pra registro de evento, não há FK.
        apiActorId(req)
      );

      logger.info('[integration-chat] assign', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
        assigneeId: userId,
      });

      res.status(200).json({ data: updated });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // POST /conversations/:id/assign-team
  // ============================================
  async assignTeam(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);
      const parsed = assignTeamSchema.parse(req.body ?? {});

      await requireConversationInAccount(id, accountId);

      let teamId = parsed.teamId ?? null;
      if (!teamId && parsed.teamSlug) {
        // Team não tem slug no schema; tratamos teamSlug como busca
        // case-insensitive pelo nome.
        const team = await prisma.team.findFirst({
          where: {
            accountId,
            name: { equals: parsed.teamSlug, mode: 'insensitive' },
          },
          select: { id: true },
        });
        if (!team) throw new NotFoundError('Time');
        teamId = team.id;
      }

      if (!teamId) {
        throw new ValidationError('teamId ou teamSlug é obrigatório');
      }

      const updated = await conversationService.assignToTeam(
        id,
        accountId,
        teamId,
        apiActorId(req)
      );

      logger.info('[integration-chat] assign team', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
        teamId,
      });

      res.status(200).json({ data: updated });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // POST /conversations/:id/transfer
  //
  // Wrapper sobre assign/assignToTeam + nota interna automática com o motivo.
  // Não chama conversationService.transfer porque esse método cria
  // ConversationNote (FK rígida para User), e nossa API key não tem um User
  // associado. Usamos messageService.create(senderType='system', isPrivate=true)
  // que aceita senderId=null para registrar o motivo da transferência.
  // ============================================
  async transfer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);
      const parsed = transferSchema.parse(req.body ?? {});

      await requireConversationInAccount(id, accountId);

      const to: 'agent' | 'team' = parsed.toUserId ? 'agent' : 'team';
      const targetId = parsed.toUserId ?? parsed.toTeamId ?? null;

      const noteContent = parsed.reason
        ? `Transferência via API: ${parsed.reason}`
        : 'Transferência via API';

      // 1) Nota interna automática (sempre, com ou sem motivo) — auditoria.
      try {
        await messageService.create(accountId, {
          conversationId: id,
          senderType: 'system',
          senderId: null,
          content: noteContent,
          contentType: 'system_note',
          isPrivate: true,
          metadata: {
            source: 'api_integration_transfer',
            apiKeyId: req.apiKey?.id ?? null,
            to,
            targetId,
            reason: parsed.reason ?? null,
          },
        });
      } catch (err) {
        logger.warn('[integration-chat] falha ao gravar nota de transferência', {
          conversationId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 2) Atribuição (agent OU team)
      const byActor = apiActorId(req);
      const updated =
        to === 'agent'
          ? await conversationService.assign(id, accountId, targetId, byActor)
          : await conversationService.assignToTeam(id, accountId, targetId, byActor);

      logger.info('[integration-chat] transfer', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
        to,
        targetId,
        reason: parsed.reason ?? null,
      });

      res.status(200).json({ data: updated });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // POST /conversations/:id/resolve
  // ============================================
  async resolve(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);
      const parsed = resolveSchema.parse(req.body ?? {});

      await requireConversationInAccount(id, accountId);

      const resolvedBy = parsed.resolvedBy ?? 'ai';

      // SLA v2.1 — internalRating DEPRECATED no contexto de SLA. Logamos
      // warning pra deixar trilha em audits. Aceito sem erro por backcompat.
      if (parsed.internalRating !== undefined) {
        logger.warn(
          '[integration-chat.resolve] internalRating recebido — campo auxiliar nao integra SLA. Use POST /integrations/chat/conversations/:id/send-csat para capturar avaliacao do cliente.',
          {
            accountId,
            apiKeyId: req.apiKey?.id ?? null,
            conversationId: id,
            internalRating: parsed.internalRating,
          }
        );
      }

      // Optional: nota interna automatica com o reason
      if (parsed.reason && parsed.reason.trim().length > 0) {
        try {
          await messageService.create(accountId, {
            conversationId: id,
            senderType: 'system',
            senderId: null,
            content: `Conversa resolvida via API (${resolvedBy}): ${parsed.reason}`,
            contentType: 'system_note',
            isPrivate: true,
            metadata: {
              source: 'api_integration_resolve_reason',
              apiKeyId: req.apiKey?.id ?? null,
            },
          });
        } catch (err) {
          logger.warn('[integration-chat] falha ao gravar nota do resolve', {
            conversationId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const updated = await conversationService.resolve(id, accountId, {
        resolvedBy,
        userId: apiActorId(req),
        outcome: parsed.outcome,
        internalRating: parsed.internalRating,
        reason: parsed.reason,
        sendCsatToCustomer: parsed.sendCsatToCustomer,
        // api-key actor nao tem User real — nao seta resolvedByUserId
        resolvedByUserId: null,
      });

      // ai_handled=true quando a IA resolveu
      if (resolvedBy === 'ai') {
        await markAiHandled(id, accountId, { setResolvedByAttr: true });
      }

      logger.info('[integration-chat] resolve', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
        resolvedBy,
      });

      res.status(200).json({ data: updated });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // POST /conversations/:id/reopen
  // ============================================
  async reopen(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);

      await requireConversationInAccount(id, accountId);

      const updated = await conversationService.reopen(
        id,
        accountId,
        apiActorId(req)
      );

      logger.info('[integration-chat] reopen', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
      });

      res.status(200).json({ data: updated });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // POST /conversations/:id/send-csat (SLA v2.1)
  // ============================================
  /**
   * Dispara CSAT IMEDIATO via API key (sem esperar o cron de 15min). Permite
   * que a IA externa (n8n / agente) peca a avaliacao do cliente exatamente
   * no momento certo — ex: logo apos confirmar uma reserva ou concluir o
   * atendimento.
   *
   * Body:
   *  - customMessage?: string  (texto custom da pergunta)
   *  - force?: boolean         (reenvia mesmo se ja foi pedido)
   *
   * Retorna 409 se csatSentAt ja estiver setado e force !== true.
   */
  async sendCsat(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);
      const parsed = sendCsatSchema.parse(req.body ?? {});

      await requireConversationInAccount(id, accountId);

      const result = await csatService.sendCsatNow(id, accountId, {
        customMessage: parsed.customMessage,
        force: parsed.force,
      });

      logger.info('[integration-chat] sendCsat', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
        cycleId: result.cycleId,
        force: parsed.force === true,
      });

      res.status(200).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // PATCH /conversations/:id/custom-attributes
  // ============================================
  async setCustomAttributes(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);
      const parsed = customAttrsSchema.parse(req.body ?? {});

      await requireConversationInAccount(id, accountId);

      const updated = await conversationService.setCustomAttributes(
        id,
        accountId,
        parsed.attrs,
        apiActorId(req)
      );

      logger.info('[integration-chat] set custom attributes', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
        keys: Object.keys(parsed.attrs),
      });

      res.status(200).json({ data: updated });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // PATCH /conversations/:id/priority
  // ============================================
  async setPriority(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);
      const parsed = prioritySchema.parse(req.body ?? {});

      await requireConversationInAccount(id, accountId);

      const updated = await conversationService.updatePriority(
        id,
        accountId,
        parsed.priority,
        apiActorId(req)
      );

      logger.info('[integration-chat] priority', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
        priority: parsed.priority,
      });

      res.status(200).json({ data: updated });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // POST /conversations/:id/labels
  // ============================================
  async addLabel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);
      const parsed = labelSchema.parse(req.body ?? {});

      await requireConversationInAccount(id, accountId);

      const tagId = parsed.tagId
        ? parsed.tagId
        : await conversationService.resolveOrCreateTagByLabel(
            accountId,
            parsed.label!,
            apiActorId(req)
          );

      const updated = await conversationService.addLabel(
        id,
        accountId,
        tagId,
        apiActorId(req)
      );

      logger.info('[integration-chat] add label', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
        tagId,
      });

      res.status(200).json({ data: updated });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // DELETE /conversations/:id/labels/:labelId
  // ============================================
  async removeLabel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);
      const tagId = parseUuidParam(req.params.labelId, 'labelId');

      await requireConversationInAccount(id, accountId);

      await conversationService.removeLabel(
        id,
        accountId,
        tagId,
        apiActorId(req)
      );

      logger.info('[integration-chat] remove label', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
        tagId,
      });

      res.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // POST /conversations/:id/snooze
  // ============================================
  async snooze(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);
      const id = parseUuidParam(req.params.id);
      const parsed = snoozeSchema.parse(req.body ?? {});

      await requireConversationInAccount(id, accountId);

      let until: Date;
      if (parsed.snoozedUntil) {
        until = new Date(parsed.snoozedUntil);
        if (isNaN(until.getTime())) {
          throw new ValidationError('snoozedUntil inválido (precisa ser ISO 8601)');
        }
      } else if (parsed.hours) {
        until = new Date(Date.now() + parsed.hours * 60 * 60 * 1000);
      } else {
        throw new ValidationError('Informe snoozedUntil ou hours');
      }

      const updated = await conversationService.snooze(
        id,
        accountId,
        until,
        apiActorId(req)
      );

      logger.info('[integration-chat] snooze', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        conversationId: id,
        until: until.toISOString(),
      });

      res.status(200).json({ data: updated });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/chat/attachments/:id
   *
   * Serve a MIDIA de uma mensagem (audio, imagem, documento) para integracoes
   * autenticadas por API key.
   *
   * PORQUE EXISTE: o `fileUrl` que vai no webhook `message.created` aponta pra
   * GET /api/attachments/:id — que e autenticado por **JWT** (sessao de usuario).
   * Uma integracao (n8n/IA) so tem API key, entao nao conseguia baixar o audio
   * do cliente pra transcrever. Sem isso, todo fluxo de IA quebra em mensagem
   * de voz — que no WhatsApp e altissimo volume.
   *
   * Espelha a logica de attachment.controller.serveFile, trocando o escopo por
   * JWT pelo `req.accountId` populado pelo middleware requireApiKey. O
   * pertencimento a conta e checado de duas formas (mesma regra do proxy JWT):
   *   a) attachment ligado a uma message de uma conversation da conta; OU
   *   b) attachment orfao (messageId null) com storagePath prefixado por `<accountId>/`.
   */
  async getAttachment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.accountId;
      if (!accountId) {
        throw new UnauthorizedError();
      }
      const id = req.params.id as string;
      if (!id) throw new ValidationError('id é obrigatório');

      const att = await prisma.attachment.findFirst({
        where: {
          id,
          OR: [
            { message: { conversation: { accountId } } },
            { messageId: null, storagePath: { startsWith: `${accountId}/` } },
          ],
        },
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          fileType: true,
          storagePath: true,
          storageStatus: true,
        },
      });
      if (!att) throw new NotFoundError('Attachment não encontrado');

      let absolutePath: string | null = null;
      let byteLength: number | null = null;
      let mimeType: string | null = att.mimeType ?? null;

      if (att.storagePath && att.storageStatus === 'downloaded') {
        try {
          const candidate = attachmentStorageService.resolveAbsolutePath(att.storagePath);
          const s = await stat(candidate);
          if (s.size > 0) {
            absolutePath = candidate;
            byteLength = s.size;
          }
        } catch {
          /* arquivo sumiu do disco — cai no materialize abaixo */
        }
      }

      // Lazy materialize: baixa da Evolution se ainda nao esta em disco (ou se
      // o rebuild do container apagou o uploads/ efemero).
      if (!absolutePath) {
        const materialized = await attachmentStorageService.materialize(att.id);
        if (!materialized) {
          throw new NotFoundError('Attachment indisponível (falha ao baixar)');
        }
        absolutePath = materialized.absolutePath;
        byteLength = materialized.byteLength;
        mimeType = materialized.mimeType ?? mimeType;
      }

      const contentType = mimeType || 'application/octet-stream';
      const safeName = (att.fileName || `attachment-${id}`).replace(/"/g, '');

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(byteLength));
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
      res.setHeader('X-Accel-Buffering', 'no');

      const stream = createReadStream(absolutePath);
      stream.on('error', (err) => {
        logger.error('[integration-chat] erro lendo anexo do disco', {
          accountId,
          attachmentId: id,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) res.status(500).end();
        else res.end();
      });
      stream.pipe(res);
    } catch (error) {
      next(error);
    }
  }
}

export const integrationChatController = new IntegrationChatController();
