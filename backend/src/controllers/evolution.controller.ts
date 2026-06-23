import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { prisma } from '../config/database';
import { evolutionService } from '../services/evolution.service';
import { whatsappConsentService } from '../services/whatsapp-consent.service';
import { inboxChannelService } from '../services/inbox.service';
import { conversationService } from '../services/conversation.service';
import {
  messageService,
  MessageContentType,
  CreateAttachmentInput,
} from '../services/message.service';
import { logger } from '../utils/logger';
import { AuthenticatedRequest } from '../types';
import { ForbiddenError, ErrorCodes } from '../utils/errors';

export class EvolutionController {
  /**
   * Ensure the authenticated user can access the given accountId.
   * Super admin can access any account; admin can only access their own.
   */
  private assertCanAccessAccount(req: AuthenticatedRequest, accountId: string): void {
    if (!req.user) {
      throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
    }

    if (req.user.role === 'super_admin') {
      return;
    }

    if (req.user.role === 'admin' && req.user.accountId === accountId) {
      return;
    }

    throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
  }

  /**
   * GET /api/evolution/accounts/:accountId/qrcode
   */
  async getQrCode(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.params.accountId as string;
      this.assertCanAccessAccount(req, accountId);

      const result = await evolutionService.getQrCode(accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/evolution/accounts/:accountId/status
   */
  async getStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.params.accountId as string;
      this.assertCanAccessAccount(req, accountId);

      const result = await evolutionService.getStatus(accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/evolution/accounts/:accountId/disconnect
   */
  async disconnect(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.params.accountId as string;
      this.assertCanAccessAccount(req, accountId);

      const result = await evolutionService.disconnect(accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Compara duas strings de assinatura em tempo constante.
   * Devolve false (sem lançar) se tamanhos divergem ou hex inválido.
   */
  private safeSignatureEqual(expectedHex: string, providedHex: string): boolean {
    try {
      const expected = Buffer.from(expectedHex, 'hex');
      const provided = Buffer.from(providedHex, 'hex');
      if (expected.length === 0 || expected.length !== provided.length) {
        return false;
      }
      return crypto.timingSafeEqual(expected, provided);
    } catch {
      return false;
    }
  }

  /**
   * POST /api/evolution/webhook/:accountId
   *
   * Recebe eventos da Evolution API (messages.upsert, connection.update, etc).
   * Endpoint PÚBLICO — não passa pelo middleware authenticate.
   *
   * BUG-018 (HARDENED): valida HMAC SHA-256 do raw body via header `x-evolution-signature`.
   * O secret `account.evolutionWebhookSecret` é OBRIGATÓRIO — se não estiver configurado,
   * o webhook responde 401 e NÃO processa o payload. Isso fecha a janela onde uma conta
   * sem secret aceitava qualquer requisição não autenticada (vetor de injeção de mensagens
   * e disparo de opt-out via JID forjado). Para habilitar o webhook, o admin deve
   * configurar `evolutionWebhookSecret` na conta antes de apontar a Evolution API para cá.
   *
   * BUG-006: após HMAC válido, processa keyword opt-out em mensagens inbound.
   */
  async receiveWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.params.accountId as string;
      const event = req.body?.event || req.body?.type || 'unknown';

      // ============================================
      // BUG-018: validação HMAC
      // ============================================
      const account = await prisma.account.findUnique({
        where: { id: accountId },
        select: { id: true, evolutionWebhookSecret: true },
      });

      if (!account) {
        logger.warn('[evolution-webhook] accountId desconhecido', { accountId });
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } });
        return;
      }

      // BUG-018 (hardening): secret é OBRIGATÓRIO. Sem secret, recusa antes de
      // qualquer processamento do payload — evita injeção de mensagens / opt-out forjado.
      if (!account.evolutionWebhookSecret) {
        logger.warn(
          '[evolution-webhook] evolutionWebhookSecret ausente — recusando webhook (HMAC obrigatório)',
          { accountId, event }
        );
        res.status(401).json({
          error: {
            code: 'HMAC_SECRET_NOT_CONFIGURED',
            message:
              'Webhook requires HMAC secret — configure evolutionWebhookSecret on account',
          },
        });
        return;
      }

      const headerSig = req.headers['x-evolution-signature'];
      const providedSig = Array.isArray(headerSig) ? headerSig[0] : headerSig;

      if (!providedSig || typeof providedSig !== 'string') {
        logger.warn('[evolution-webhook] header x-evolution-signature ausente', {
          accountId,
          event,
        });
        res.status(401).json({
          error: { code: 'INVALID_SIGNATURE', message: 'Missing signature header' },
        });
        return;
      }

      const rawBody: Buffer | undefined = (req as any).rawBody;
      if (!rawBody) {
        logger.error('[evolution-webhook] rawBody indisponível para validar HMAC', undefined, {
          accountId,
        });
        res.status(401).json({
          error: { code: 'INVALID_SIGNATURE', message: 'Raw body not available' },
        });
        return;
      }

      const expectedSig = crypto
        .createHmac('sha256', account.evolutionWebhookSecret)
        .update(rawBody)
        .digest('hex');

      // Permite tanto `<hex>` quanto `sha256=<hex>` (compat com diferentes clientes)
      const normalizedProvided = providedSig.startsWith('sha256=')
        ? providedSig.slice('sha256='.length)
        : providedSig;

      if (!this.safeSignatureEqual(expectedSig, normalizedProvided)) {
        logger.warn('[evolution-webhook] assinatura HMAC inválida', { accountId, event });
        res.status(401).json({
          error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' },
        });
        return;
      }

      logger.info('Evolution webhook received', {
        accountId,
        event,
        instance: req.body?.instance,
        bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : [],
      });

      // ============================================
      // BUG-006: keyword opt-out em mensagens inbound do cliente
      // ============================================
      if (event === 'messages.upsert') {
        try {
          const body: any = req.body || {};
          const fromMe = Boolean(body?.data?.key?.fromMe);

          if (!fromMe) {
            const messageText: string =
              body?.data?.message?.conversation ||
              body?.data?.message?.extendedTextMessage?.text ||
              '';
            const remoteJid: string | undefined = body?.data?.key?.remoteJid;
            const phone = remoteJid ? String(remoteJid).split('@')[0] : '';

            if (messageText && phone) {
              await whatsappConsentService.handleInboundOptOut(accountId, phone, messageText);
            }
          }
        } catch (err: any) {
          // Não derruba o webhook por falha no opt-out — apenas loga.
          logger.warn('[evolution-webhook] falha ao processar opt-out inbound', {
            accountId,
            event,
            error: err?.message ?? String(err),
          });
        }
      }

      // ============================================
      // T-022 Sprint 4 — dispatcher de eventos Evolution → motor de conversas
      // ============================================
      try {
        await this.dispatchEvolutionEvent(accountId, event, req.body);
      } catch (err: any) {
        // Falha de dispatcher NÃO derruba o webhook — Evolution faz retry caso 5xx,
        // o que pode causar reprocesso e duplicar dados se a idempotência tropeçar.
        // Logamos e devolvemos 200 pra que o provider não fique martelando.
        logger.error(
          '[evolution-webhook] falha ao processar evento Evolution',
          err instanceof Error ? err : undefined,
          {
            accountId,
            event,
            error: err?.message ?? String(err),
          }
        );
      }

      res.status(200).json({ received: true });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // Dispatcher Evolution → motor de conversas (T-022 Sprint 4)
  // ============================================

  /**
   * Roteia eventos Evolution conhecidos para handlers especializados.
   * Eventos não mapeados são apenas logados em debug e ignorados.
   */
  private async dispatchEvolutionEvent(
    accountId: string,
    event: string,
    body: any
  ): Promise<void> {
    switch (event) {
      case 'messages.upsert':
        await this.processNewMessage(accountId, body);
        return;
      case 'connection.update':
        await this.processConnectionState(accountId, body);
        return;
      case 'contacts.update':
        await this.processContactUpdate(accountId, body);
        return;
      default:
        logger.debug('[evolution-webhook] evento ignorado', { accountId, event });
        return;
    }
  }

  /**
   * Extrai conteúdo + tipo a partir do objeto `message` do Evolution.
   * Cobre os formatos mais comuns: text, extendedText, image, video, document, audio.
   * Para mídias, monta também o array de attachments com a melhor URL/base64 disponível.
   */
  private extractMessagePayload(rawMessage: any): {
    content: string | null;
    contentType: MessageContentType;
    attachments: CreateAttachmentInput[];
  } {
    const m = rawMessage || {};

    // texto puro
    if (typeof m.conversation === 'string' && m.conversation.length > 0) {
      return { content: m.conversation, contentType: 'text', attachments: [] };
    }
    if (typeof m.extendedTextMessage?.text === 'string') {
      return {
        content: m.extendedTextMessage.text,
        contentType: 'text',
        attachments: [],
      };
    }

    // mídia (image, video, document, audio)
    const buildAttachment = (
      fileType: CreateAttachmentInput['fileType'],
      node: any
    ): CreateAttachmentInput | null => {
      if (!node || typeof node !== 'object') return null;
      const url: string | undefined =
        node.url || node.mediaUrl || node.directPath || node.downloadUrl;
      if (!url) return null;
      return {
        fileType,
        fileUrl: url,
        fileName: node.fileName ?? null,
        mimeType: node.mimetype ?? node.mimeType ?? null,
        fileSize:
          typeof node.fileLength === 'number'
            ? node.fileLength
            : typeof node.fileSize === 'number'
              ? node.fileSize
              : null,
        thumbnailUrl: node.jpegThumbnail || node.thumbnailUrl || null,
        duration: typeof node.seconds === 'number' ? node.seconds : null,
      } as CreateAttachmentInput;
    };

    if (m.imageMessage) {
      const att = buildAttachment('image', m.imageMessage);
      return {
        content: m.imageMessage.caption ?? null,
        contentType: 'media',
        attachments: att ? [att] : [],
      };
    }
    if (m.videoMessage) {
      const att = buildAttachment('video', m.videoMessage);
      return {
        content: m.videoMessage.caption ?? null,
        contentType: 'media',
        attachments: att ? [att] : [],
      };
    }
    if (m.documentMessage) {
      const att = buildAttachment('document', m.documentMessage);
      return {
        content: m.documentMessage.caption ?? m.documentMessage.fileName ?? null,
        contentType: 'document',
        attachments: att ? [att] : [],
      };
    }
    if (m.audioMessage) {
      const att = buildAttachment('audio', m.audioMessage);
      return { content: null, contentType: 'audio', attachments: att ? [att] : [] };
    }

    return { content: null, contentType: 'text', attachments: [] };
  }

  /**
   * Processa um evento `messages.upsert` da Evolution e cria a Message correspondente,
   * abrindo/reabrindo a Conversation conforme necessário.
   * Idempotente: se já existe Message com o mesmo externalId na conversa, faz skip.
   */
  private async processNewMessage(accountId: string, body: any): Promise<void> {
    const data: any = body?.data ?? body ?? {};
    const instance: string | undefined = body?.instance || body?.instanceName;
    const remoteJid: string | undefined = data?.key?.remoteJid;
    const messageId: string | undefined = data?.key?.id;
    const fromMe = Boolean(data?.key?.fromMe);
    const pushName: string | undefined = data?.pushName;

    if (!instance) {
      logger.warn('[evolution-webhook] messages.upsert sem instance — ignorando', {
        accountId,
        remoteJid,
      });
      return;
    }
    if (!remoteJid) {
      logger.warn('[evolution-webhook] messages.upsert sem remoteJid — ignorando', {
        accountId,
        instance,
      });
      return;
    }
    if (!messageId) {
      logger.warn('[evolution-webhook] messages.upsert sem key.id — ignorando', {
        accountId,
        instance,
        remoteJid,
      });
      return;
    }

    // Roteamento: descobre o inbox WhatsApp configurado pra essa instância na conta.
    const inbox = await inboxChannelService.listByEvolutionInstance(accountId, instance);
    if (!inbox) {
      logger.warn('[evolution-webhook] mensagem recebida em instance não configurada', {
        accountId,
        instance,
        remoteJid,
      });
      return;
    }

    // Ignora mensagens em grupos/broadcasts por enquanto — só DMs (@s.whatsapp.net).
    if (!remoteJid.endsWith('@s.whatsapp.net')) {
      logger.debug('[evolution-webhook] remoteJid não-DM — ignorando', {
        accountId,
        remoteJid,
      });
      return;
    }

    const phone = remoteJid.split('@')[0];

    // Cria/reabre conversa (cria contato implicitamente se não existir, via phone).
    const conversation = await conversationService.findOrCreateForCustomer(
      accountId,
      inbox.id,
      {
        externalId: remoteJid,
        contactPhone: phone,
        contactName: !fromMe && pushName ? pushName : null,
      }
    );

    // Idempotência: se já temos Message com este externalId nesta conversa, skip.
    const existing = await prisma.message.findFirst({
      where: { conversationId: conversation.id, externalId: messageId },
      select: { id: true },
    });
    if (existing) {
      logger.debug('[evolution-webhook] message externalId já existe — skip', {
        accountId,
        conversationId: conversation.id,
        messageId,
      });
      return;
    }

    const { content, contentType, attachments } = this.extractMessagePayload(data?.message);

    // Sem content e sem attachments → nada útil pra persistir (ex: reactions, status updates).
    if ((!content || content.trim() === '') && attachments.length === 0) {
      logger.debug('[evolution-webhook] message sem conteúdo nem mídia — skip', {
        accountId,
        conversationId: conversation.id,
        messageId,
      });
      return;
    }

    await messageService.create(accountId, {
      conversationId: conversation.id,
      senderType: fromMe ? 'agent' : 'customer',
      content: content ?? null,
      contentType,
      externalId: messageId,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        source: 'evolution',
        pushName: pushName ?? null,
        remoteJid,
        instance,
      },
    });

    // TODO[T-022/sprint5]: emitir Socket.IO ('conversation:new_message') quando
    // o gateway WS estiver disponível. Por ora, frontends polling ou consumers
    // n8n recebem via webhookOutbound 'message.created' (disparado por messageService.create).

    logger.info('[evolution-webhook] message persistida', {
      accountId,
      conversationId: conversation.id,
      messageId,
      senderType: fromMe ? 'agent' : 'customer',
      contentType,
    });
  }

  /**
   * Processa `connection.update` — apenas log estruturado por ora.
   * Futuro: atualizar `Inbox.active` ou expor status numa view de admin.
   */
  private async processConnectionState(accountId: string, body: any): Promise<void> {
    const instance: string | undefined = body?.instance || body?.instanceName;
    const state: string | undefined =
      body?.data?.state || body?.data?.connection || body?.state;

    logger.info('[evolution-webhook] connection.update', {
      accountId,
      instance,
      state,
    });

    // TODO[T-022/sprint5]: marcar Inbox.active=false quando state==='close'/'logout'.
    // Por enquanto só logamos — flag manual no admin continua sendo a fonte de verdade.
  }

  /**
   * Processa `contacts.update` — atualiza nome do contato se o pushName/notify mudou.
   * Matching por telefone dentro da conta (multi-tenant safe).
   */
  private async processContactUpdate(accountId: string, body: any): Promise<void> {
    // Evolution pode mandar array ou objeto único em data
    const rawList: any[] = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
    if (rawList.length === 0) {
      logger.debug('[evolution-webhook] contacts.update sem data', { accountId });
      return;
    }

    for (const item of rawList) {
      const jid: string | undefined = item?.id || item?.remoteJid;
      const name: string | undefined = item?.pushName || item?.notify || item?.name;
      if (!jid || !jid.endsWith('@s.whatsapp.net') || !name) continue;

      const phone = jid.split('@')[0];

      const contact = await prisma.contact.findFirst({
        where: { accountId, telefone: phone },
        select: { id: true, nome: true },
      });
      if (!contact) {
        logger.debug('[evolution-webhook] contacts.update — sem contato local', {
          accountId,
          phone,
        });
        continue;
      }
      if (contact.nome === name) continue;

      await prisma.contact.update({
        where: { id: contact.id },
        data: { nome: name },
      });

      logger.info('[evolution-webhook] contato atualizado via contacts.update', {
        accountId,
        contactId: contact.id,
        phone,
      });
    }
  }
}

export const evolutionController = new EvolutionController();
