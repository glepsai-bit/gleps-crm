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
import { readFile } from 'node:fs/promises';
import { logger } from '../utils/logger';
import {
  transcodeToOggOpus,
  isOggOpus,
  decodeDataUrlBase64,
} from '../utils/audio-transcode.util';
import { attachmentStorageService } from '../services/attachment-storage.service';

// Tamanho maximo aceito como source de audio (bound defensivo antes do spawn
// do ffmpeg — evita fork bomb com payload adversarial).
const MAX_AUDIO_SOURCE_BYTES = 25 * 1024 * 1024;
// Padrao de fileUrl gerado por POST /api/attachments/upload (PISTA D).
const API_ATTACHMENT_URL = /^\/api\/attachments\/([0-9a-f-]{36})$/i;

/**
 * Materializa o audio outbound em Buffer, tolerando os dois formatos que o
 * frontend produz:
 *   - `data:audio/webm;codecs=opus;base64,AAAA...`  (composer inline, <=5MB)
 *   - `/api/attachments/<uuid>`                      (upload multipart, >5MB)
 *
 * Bug pre-fix: o codigo assumia que qualquer coisa que nao comecasse com
 * `data:` era base64 puro — o que faz `Buffer.from('/api/attachments/…', 'base64')`
 * decodificar 15 bytes de lixo e mandar para o WhatsApp. Agora resolvemos
 * cada caso explicitamente e rejeitamos formatos desconhecidos.
 *
 * O uuid extraido do path e escopado por accountId via storagePath prefix
 * (mesmo padrao usado por attachment.controller para servir o proxy) —
 * impede cross-tenant.
 */
async function resolveAudioSourceBuffer(
  fileUrl: string,
  accountId: string
): Promise<Buffer> {
  // Caso 1: data URL base64. RFC 2397: o payload sempre esta depois do
  // primeiro `,`. O split.indexOf trata `data:audio/webm;codecs=opus;base64,…`
  // (Chrome/Edge/Firefox) e `data:audio/ogg;base64,…` (custom clients)
  // sem depender de regex, que ja quebrou uma vez em produ.
  if (fileUrl.startsWith('data:')) {
    let buf: Buffer;
    try {
      buf = decodeDataUrlBase64(fileUrl);
    } catch (err) {
      throw new ValidationError(
        `Data URL de audio invalido: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (buf.length === 0) {
      throw new ValidationError('Data URL de audio decodificou para 0 bytes');
    }
    if (buf.length > MAX_AUDIO_SOURCE_BYTES) {
      throw new ValidationError(
        `Audio inline muito grande (${buf.length} bytes, max ${MAX_AUDIO_SOURCE_BYTES}).`
      );
    }
    return buf;
  }

  // Caso 2: attachment materializado em disco (PISTA D).
  const apiMatch = fileUrl.match(API_ATTACHMENT_URL);
  if (apiMatch) {
    const attachmentId = apiMatch[1];
    // RBAC: mesmo criterio de attachment.controller.serveFile — attachment
    // linkado a message da conta OU orfao com storagePath prefixado pela conta.
    const att = await prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        OR: [
          { message: { conversation: { accountId } } },
          {
            messageId: null,
            storagePath: { startsWith: `${accountId}/` },
          },
        ],
      },
      select: { storagePath: true, fileSize: true, storageStatus: true },
    });
    if (!att) {
      throw new NotFoundError('Attachment de audio nao encontrado');
    }
    if (!att.storagePath || att.storageStatus !== 'downloaded') {
      throw new ValidationError('Attachment de audio ainda nao materializado');
    }
    if (att.fileSize && att.fileSize > MAX_AUDIO_SOURCE_BYTES) {
      throw new ValidationError(
        `Audio muito grande (${att.fileSize} bytes, max ${MAX_AUDIO_SOURCE_BYTES}).`
      );
    }
    const abs = attachmentStorageService.resolveAbsolutePath(att.storagePath);
    return readFile(abs);
  }

  // Caso 3: qualquer outro esquema (http(s)://, relative desconhecido).
  // Melhor falhar cedo do que enviar lixo silenciosamente.
  throw new ValidationError(
    `fileUrl de audio nao suportado: aceita apenas data: ou /api/attachments/<uuid>.`
  );
}

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
// Cap 22MB por campo de URL — cobre 16MB (teto WhatsApp) inflado ~33% pelo
// base64 do payload JSON. Alinhado com express.json({limit:'24mb'}) e
// nginx client_max_body_size=25M. Antes eram 7MB e cortava anexos reais.
const MAX_URL_LEN = 22_000_000;
const attachmentSchema = z.object({
  fileType: z.enum(['image', 'video', 'audio', 'document', 'sticker']),
  fileUrl: z.string().min(1).max(MAX_URL_LEN, 'Anexo muito grande (max 16MB — teto WhatsApp)'),
  fileSize: z.number().int().nonnegative().optional(),
  fileName: z.string().max(512, 'fileName muito longo (max 512 caracteres)').optional(),
  mimeType: z.string().max(128, 'mimeType muito longo (max 128 caracteres)').optional(),
  thumbnailUrl: z.string().max(MAX_URL_LEN, 'thumbnailUrl muito grande (max 16MB)').optional(),
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

// CHAT-REPLY-EDIT-DEL: body do PATCH /messages/:id — só aceita content.
const editMessageBodySchema = z.object({
  content: z
    .string()
    .min(1, 'content é obrigatório')
    .max(MAX_MESSAGE_CONTENT_LEN, 'Mensagem muito longa (max 4096 caracteres)'),
});

// CHAT-REACTIONS: body do POST /messages/:id/reactions.
// Emoji unicode livre — validação estrita fica no service (16 chars max).
const reactionBodySchema = z.object({
  emoji: z.string().min(1, 'emoji é obrigatório').max(16, 'emoji muito longo'),
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
      //
      // CHAT-MIC-RECORDING: audio-only (sem content) também dispara — o
      // agente pode mandar só o PTT. Extendemos o gate pra cobrir esse caso.
      const hasContentDispatch =
        typeof parsed.content === 'string' && parsed.content.trim() !== '';
      const hasAttachmentDispatch =
        Array.isArray(parsed.attachments) && parsed.attachments.length > 0;
      const shouldDispatch =
        !isPrivate && (hasContentDispatch || hasAttachmentDispatch);

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
            const instance = conversation.inbox.evolutionInstance ?? null;

            // CHAT-REPLY: resolve quoted a partir do replyToId (a msg citada
            // precisa ter externalId REAL — pending não vale, WhatsApp não
            // acha a msg original).
            let quotedPayload:
              | { id: string; remoteJid: string; fromMe: boolean; text?: string | null }
              | null = null;
            if (parsed.replyToId) {
              const parent = await prisma.message.findFirst({
                where: {
                  id: parsed.replyToId,
                  conversationId,
                },
                select: {
                  externalId: true,
                  content: true,
                  senderType: true,
                  metadata: true,
                },
              });
              const parentExternalId = parent?.externalId ?? '';
              if (parentExternalId && !parentExternalId.startsWith('pending:')) {
                const parentMetadata =
                  parent?.metadata && typeof parent.metadata === 'object' && !Array.isArray(parent.metadata)
                    ? (parent.metadata as Record<string, unknown>)
                    : {};
                const remoteJidFromMeta =
                  typeof parentMetadata.remoteJid === 'string'
                    ? (parentMetadata.remoteJid as string)
                    : null;
                quotedPayload = {
                  id: parentExternalId,
                  remoteJid:
                    remoteJidFromMeta ??
                    `${phone.replace(/\D+/g, '')}@s.whatsapp.net`,
                  // fromMe=true quando NÓS enviamos a msg citada.
                  fromMe: parent!.senderType !== 'customer',
                  text: parent!.content ?? '',
                };
              }
            }

            // CHAT-MIC-RECORDING + media routing:
            //  - attachments[0].fileType === 'audio'  → sendWhatsAppAudio (PTT)
            //  - fileType image|video|document       → sendMedia
            //  - só texto                            → sendText (com quoted opcional)
            const firstAttachment =
              hasAttachmentDispatch && parsed.attachments
                ? parsed.attachments[0]
                : null;

            let result: { messageId: string; raw: any };
            if (firstAttachment && firstAttachment.fileType === 'audio') {
              // Chrome/Edge gravam WebM/Opus mas o WhatsApp so renderiza bubble
              // PTT nativo com OGG/Opus — transcodamos via ffmpeg antes de enviar.
              // O buffer pode vir de dois lugares:
              //   (a) data URL base64 inline (arquivos <=5MB no composer)
              //   (b) /api/attachments/<uuid> — upload multipart dedicado
              //       ja materializado em disco (arquivos >5MB ou tudo em
              //       clientes custom).
              // Precisamos resolver os DOIS antes de transcodar; do contrario
              // (b) e decodificado como base64 de string curta e vira lixo.
              const sourceBuffer = await resolveAudioSourceBuffer(
                firstAttachment.fileUrl,
                accountId
              );
              const sourceMime = firstAttachment.mimeType ?? null;
              const transcoded = await transcodeToOggOpus(sourceBuffer, sourceMime);
              // Observabilidade: se o util nao rodou ffmpeg com sucesso E o
              // source nao era OGG, o dispatch cai no fallback pre-fix (envia
              // WebM/MP4 -> chega como documento no WhatsApp). Log em error
              // pra alarme, sem quebrar o envio.
              if (!transcoded.transcoded && !isOggOpus(sourceMime)) {
                logger.error(
                  '[message] audio nao-OGG enviado sem transcode — WhatsApp entregara como documento',
                  {
                    accountId,
                    conversationId,
                    sourceMime,
                    sourceBytes: sourceBuffer.length,
                  }
                );
              }
              result = await evolutionService.sendWhatsAppAudio(accountId, {
                number: phone,
                audioBase64: transcoded.buffer.toString('base64'),
                instance,
              });
            } else if (
              firstAttachment &&
              (firstAttachment.fileType === 'image' ||
                firstAttachment.fileType === 'video' ||
                firstAttachment.fileType === 'document')
            ) {
              result = await evolutionService.sendMedia(accountId, {
                number: phone,
                mediaUrl: firstAttachment.fileUrl,
                mediaType: firstAttachment.fileType,
                caption:
                  typeof parsed.content === 'string' && parsed.content.trim()
                    ? parsed.content
                    : undefined,
                fileName: firstAttachment.fileName,
                instance,
              });
            } else if (quotedPayload) {
              result = await evolutionService.sendTextWithQuote(accountId, {
                number: phone,
                text: parsed.content as string,
                quotedKey: {
                  id: quotedPayload.id,
                  remoteJid: quotedPayload.remoteJid,
                  fromMe: quotedPayload.fromMe,
                },
                quotedText: quotedPayload.text ?? '',
                instance,
              });
            } else {
              result = await evolutionService.sendText(accountId, {
                number: phone,
                text: parsed.content as string,
                instance,
              });
            }

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
            // PERF-AUDIT (Round 2): erros de PAYLOAD (ValidationError /
            // NotFoundError) devem virar 4xx pro cliente, nao 201 com
            // status=failed silencioso — bugs de payload passavam despercebidos.
            // Ex.: audio com fileUrl de scheme desconhecido caia aqui e o UI
            // via um "sent" que virava failed em background, sem toast.
            // Como a Message ja foi criada (linha 354), removemos e re-lancamos
            // pra o Express error handler devolver 400/404 pro cliente.
            if (
              err instanceof ValidationError ||
              err instanceof NotFoundError
            ) {
              try {
                await prisma.message.delete({ where: { id: message.id } });
              } catch (delErr) {
                logger.warn('[message] falha ao limpar msg pos-validation-error', {
                  messageId: message.id,
                  error: delErr instanceof Error ? delErr.message : String(delErr),
                });
              }
              throw err;
            }
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
   * PATCH /api/messages/:id
   * Body: { content }
   *
   * Edita o conteúdo de uma mensagem outbound do próprio agente
   * (janela: 15 min após envio). Ver `messageService.editMessage` para regras.
   */
  async update(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError();
      const accountId = req.user.accountId;
      if (!accountId) throw new ValidationError('accountId obrigatório');

      const id = req.params.id as string;
      const parsed = editMessageBodySchema.parse(req.body ?? {});

      const data = await messageService.editMessage(
        id,
        accountId,
        req.user.id,
        parsed.content
      );

      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/messages/:id
   *
   * Soft delete de mensagem outbound do próprio agente
   * (janela: 15 min após envio). Propaga delete-for-everyone pro WhatsApp.
   */
  async remove(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError();
      const accountId = req.user.accountId;
      if (!accountId) throw new ValidationError('accountId obrigatório');

      const id = req.params.id as string;
      const data = await messageService.softDeleteMessage(
        id,
        accountId,
        req.user.id
      );

      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/messages/:id/reactions
   * Body: { emoji }
   *
   * Reage a uma mensagem com um emoji. Idempotente por (msgId, userId, emoji).
   */
  async addReaction(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError();
      const accountId = req.user.accountId;
      if (!accountId) throw new ValidationError('accountId obrigatório');

      const id = req.params.id as string;
      const parsed = reactionBodySchema.parse(req.body ?? {});

      const data = await messageService.addReaction(
        id,
        accountId,
        req.user.id,
        parsed.emoji
      );

      res.status(201).json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/messages/:id/reactions/:emoji
   *
   * Remove a reaction do usuário atual (com aquele emoji) na mensagem.
   */
  async removeReaction(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError();
      const accountId = req.user.accountId;
      if (!accountId) throw new ValidationError('accountId obrigatório');

      const id = req.params.id as string;
      const emojiParam = decodeURIComponent(req.params.emoji as string);

      const data = await messageService.removeReaction(
        id,
        accountId,
        req.user.id,
        emojiParam
      );

      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/messages/:id/reactions
   *
   * Lista reactions de uma mensagem (agente humano + cliente). Frontend agrega
   * por emoji pra render dos pills.
   */
  async listReactions(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError();
      const accountId = req.user.accountId;
      if (!accountId) throw new ValidationError('accountId obrigatório');

      const id = req.params.id as string;
      const data = await messageService.listReactions(id, accountId);

      res.json({ data });
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
