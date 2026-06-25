import { randomUUID } from 'crypto';
import { prisma } from '../config/database';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../utils/errors';
import { logger } from '../utils/logger';
import { evolutionService } from './evolution.service';
import { conversationService } from './conversation.service';
import {
  messageService,
  type CreateAttachmentInput,
  type CreateMessageInput,
  type MessageContentType,
  type MessageSenderType,
} from './message.service';
import { whatsappConsentService } from './whatsapp-consent.service';
import { whatsappRateLimitService } from './whatsapp-rate-limit.service';

// ============================================
// Types
// ============================================

export type WhatsappSendType = 'text' | 'image' | 'audio' | 'document';
export type WhatsappSendSenderType = 'ai_bot' | 'integration';

/**
 * Input do método send(). Espelha o schema Zod do controller
 * `integration-whatsapp.controller.ts`, mas mantemos o tipo aqui pra que
 * o service possa ser chamado por outros callers internos (jobs, scripts
 * de migração, agentes IA) sem depender do controller HTTP.
 *
 * Regras de endereçamento (validadas pelo controller via Zod):
 *  - conversationId XOR phone (exatamente um dos dois).
 *  - Quando phone é usado, inboxId é opcional (cai no primeiro inbox
 *    WhatsApp ativo da conta).
 *  - text exige content; image/document exigem mediaUrl XOR mediaBase64;
 *    audio exige mediaUrl XOR mediaBase64 e NÃO aceita caption.
 */
export interface WhatsappSendInput {
  conversationId?: string;
  phone?: string;
  inboxId?: string;
  contactName?: string;
  type: WhatsappSendType;
  content?: string;
  mediaUrl?: string;
  mediaBase64?: string;
  mimeType?: string;
  filename?: string;
  sender_type?: WhatsappSendSenderType;
  metadata?: Record<string, unknown>;
  /** Id da API key autora — vai no metadata da mensagem pra auditoria. */
  apiKeyId?: string | null;
}

export interface WhatsappSendResult {
  messageId: string;
  conversationId: string;
  status: 'sent' | 'failed';
  externalId: string | null;
  deliveredAt: string | null;
  contactId: string | null;
  error?: { code: string; message: string };
}

// ============================================
// Service
// ============================================

class WhatsappSendService {
  /**
   * Envia uma mensagem WhatsApp via Evolution API.
   *
   * Fluxo (Design SE-H5 + circuit breaker IA + consent + rate-limit):
   *  1. Resolve inbox (validando escopo da conta).
   *  2. Resolve/cria conversation + contact via conversationService.
   *  3. Valida canal whatsapp.
   *  4. Aplica circuit breaker IA (sender_type=ai_bot bloqueia se humano ativo).
   *  5. Checa opt-out e consent (implicit_optin por default).
   *  6. Aplica rate-limit por telefone normalizado.
   *  7. Pré-reserva externalId pending:<uuid> pra fechar race com webhook fromMe.
   *  8. Persiste a mensagem ANTES do dispatch (idempotência).
   *  9. Dispatch via Evolution (sendText/sendMedia/sendAudio).
   * 10. Sucesso → atualiza externalId+status=sent; falha → markFailed +
   *     retorna status=failed com error code mas SEMPRE devolve messageId.
   *
   * Sempre retorna messageId mesmo em falha de dispatch porque a mensagem
   * já foi persistida — o caller pode chamar /api/messages/:id/retry depois.
   */
  async send(accountId: string, input: WhatsappSendInput): Promise<WhatsappSendResult> {
    if (!accountId) {
      throw new ValidationError('accountId obrigatório');
    }
    if (!input.conversationId && !input.phone) {
      throw new ValidationError('Informe conversationId ou phone');
    }
    if (input.conversationId && input.phone) {
      throw new ValidationError('Informe conversationId OU phone (exclusivos)');
    }

    const senderType: MessageSenderType = input.sender_type ?? 'integration';
    const contentType = this.typeToContentType(input.type);

    // ----------------------------------------
    // 1) Resolver inbox
    // 2) Resolver conversation + contact
    // ----------------------------------------
    const { conversation, inboxEvolutionInstance } = await this.resolveConversation(
      accountId,
      input
    );

    if (!conversation.contactId) {
      // Sem contato resolvido não temos como entregar a mensagem.
      // Defensivo — findOrCreateForCustomer cria/backfilla contato, mas
      // se chegamos aqui (ex.: conversa legacy órfã) abortamos antes do
      // dispatch pra não estourar no Evolution sem telefone.
      throw new ValidationError(
        'Conversa não possui contato associado — informe phone para criar/recuperar contato'
      );
    }

    // ----------------------------------------
    // 3) Validar canal
    // ----------------------------------------
    const channelType = (conversation as any).inbox?.channelType as string | undefined;
    if (channelType !== 'whatsapp') {
      throw new AppError(
        'Canal da conversa não suporta envio via WhatsApp',
        422,
        'CHANNEL_NOT_SUPPORTED',
        { channelType: channelType ?? null }
      );
    }

    // ----------------------------------------
    // 4) Circuit breaker IA
    // ----------------------------------------
    if (senderType === 'ai_bot') {
      const attrs =
        ((conversation as any).customAttributes as Record<string, unknown> | null) ?? {};
      if (attrs.human_active === true) {
        throw new ConflictError(
          'Circuit breaker IA aberto — humano assumiu o atendimento',
          { code: 'AI_CIRCUIT_BREAKER_OPEN' }
        );
      }
    }

    // ----------------------------------------
    // Telefone alvo (vem do contato resolvido — sempre o canônico)
    // ----------------------------------------
    const targetPhoneRaw =
      ((conversation as any).contact?.telefone as string | undefined) ??
      input.phone ??
      '';
    const normalizedPhone = whatsappConsentService.normalizePhone(targetPhoneRaw);
    if (!normalizedPhone) {
      throw new ValidationError('Contato sem telefone válido para envio WhatsApp');
    }

    // ----------------------------------------
    // 5) Consent (opt-out + política implicit_optin default)
    // ----------------------------------------
    const optedOut = await whatsappConsentService.isOptedOut(accountId, normalizedPhone);
    if (optedOut) {
      throw new AppError(
        'Contato optou por não receber mensagens',
        422,
        'CONTACT_OPTED_OUT',
        { phone: normalizedPhone }
      );
    }
    const hasConsent = await whatsappConsentService.hasConsent(accountId, normalizedPhone);
    if (!hasConsent) {
      throw new AppError(
        'Contato sem consent registrado — opt-in necessário',
        422,
        'CONSENT_REQUIRED',
        { phone: normalizedPhone }
      );
    }

    // ----------------------------------------
    // 6) Rate-limit (TOCTOU-safe in-process)
    // ----------------------------------------
    const acquired = whatsappRateLimitService.tryAcquire(accountId, normalizedPhone);
    if (!acquired.allowed) {
      throw new AppError(
        'Rate-limit excedido para este número',
        429,
        'RATE_LIMIT_EXCEEDED',
        { reason: acquired.reason, waitMs: acquired.waitMs }
      );
    }

    // ----------------------------------------
    // 7) Pré-reserva externalId pending:<uuid> (SE-H5)
    // ----------------------------------------
    const pendingExternalId = `pending:${randomUUID()}`;

    // ----------------------------------------
    // 8) Persistir mensagem ANTES do dispatch
    // ----------------------------------------
    const attachments = this.buildAttachments(input);
    const messageInput: CreateMessageInput = {
      conversationId: conversation.id,
      senderType,
      content: input.content ?? null,
      contentType,
      externalId: pendingExternalId,
      metadata: {
        source: 'api_integration',
        apiKeyId: input.apiKeyId ?? null,
        ...(input.metadata ?? {}),
        pendingExternalId,
      },
      attachments,
    };

    const message = await messageService.create(accountId, messageInput);

    // ----------------------------------------
    // 9) Dispatch via Evolution
    // ----------------------------------------
    try {
      const result = await this.dispatchByType(accountId, {
        type: input.type,
        number: normalizedPhone,
        content: input.content,
        mediaUrl: input.mediaUrl,
        mediaBase64: input.mediaBase64,
        filename: input.filename,
        instance: inboxEvolutionInstance,
      });

      const updated = await prisma.message.update({
        where: { id: message.id },
        data: {
          externalId: result.messageId ?? pendingExternalId,
          status: 'sent',
        },
      });

      logger.info('[whatsapp-send] dispatch ok', {
        accountId,
        conversationId: conversation.id,
        messageId: message.id,
        type: input.type,
        sender_type: senderType,
        externalId: result.messageId,
      });

      return {
        messageId: updated.id,
        conversationId: conversation.id,
        status: 'sent',
        externalId: updated.externalId,
        deliveredAt: new Date().toISOString(),
        contactId: conversation.contactId,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn('[whatsapp-send] dispatch falhou', {
        accountId,
        conversationId: conversation.id,
        messageId: message.id,
        type: input.type,
        error: errMsg,
      });

      // Mark message as failed — best-effort
      try {
        await messageService.markFailed(message.id, accountId, errMsg);
      } catch (markErr) {
        logger.warn('[whatsapp-send] markFailed falhou', {
          messageId: message.id,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        });
      }

      return {
        messageId: message.id,
        conversationId: conversation.id,
        status: 'failed',
        externalId: null,
        deliveredAt: null,
        contactId: conversation.contactId,
        error: { code: 'EVOLUTION_DISPATCH_FAILED', message: errMsg },
      };
    }
  }

  // ============================================
  // Internal helpers
  // ============================================

  /**
   * Resolve a conversa-alvo. Dois caminhos:
   *  - conversationId fornecido → findFirst com include contact+inbox+customAttrs.
   *  - phone fornecido          → resolve inbox WhatsApp + findOrCreateForCustomer.
   *
   * Retorna a conversation com include necessário e o `evolutionInstance` do
   * inbox (pra passar pro evolutionService e respeitar per-inbox).
   */
  private async resolveConversation(
    accountId: string,
    input: WhatsappSendInput
  ): Promise<{
    conversation: Awaited<ReturnType<typeof prisma.conversation.findFirst>> & {
      contactId: string | null;
      id: string;
    };
    inboxEvolutionInstance: string | null;
  }> {
    // Caminho A: conversationId
    if (input.conversationId) {
      const conversation = await prisma.conversation.findFirst({
        where: { id: input.conversationId, accountId },
        include: {
          contact: { select: { id: true, nome: true, telefone: true } },
          inbox: { select: { id: true, channelType: true, evolutionInstance: true } },
        },
      });
      if (!conversation) {
        throw new NotFoundError('Conversa');
      }
      return {
        conversation: conversation as any,
        inboxEvolutionInstance:
          (conversation as any).inbox?.evolutionInstance ?? null,
      };
    }

    // Caminho B: phone — resolve inbox primeiro
    const inbox = await this.resolveInbox(accountId, input.inboxId);
    const phone = input.phone as string; // garantido pelo XOR no início do send()
    const normalized = whatsappConsentService.normalizePhone(phone);
    if (!normalized) {
      throw new ValidationError('phone inválido');
    }

    // externalId no padrão Evolution WhatsApp (<digits>@s.whatsapp.net) —
    // o webhook MESSAGES_UPSERT usa o mesmo formato, então a conversa
    // criada aqui será reaproveitada quando a Evolution responder ACK.
    const externalId = `${normalized}@s.whatsapp.net`;

    const created = await conversationService.findOrCreateForCustomer(accountId, inbox.id, {
      externalId,
      contactPhone: normalized,
      contactName: input.contactName ?? null,
    });

    // findOrCreateForCustomer não retorna o include completo — buscamos
    // de novo com o include necessário pro fluxo (contact.telefone +
    // inbox.channelType/evolutionInstance + customAttributes).
    const conversation = await prisma.conversation.findFirst({
      where: { id: created.id, accountId },
      include: {
        contact: { select: { id: true, nome: true, telefone: true } },
        inbox: { select: { id: true, channelType: true, evolutionInstance: true } },
      },
    });
    if (!conversation) {
      // Não deveria acontecer (acabamos de criar), mas guard defensivo
      throw new NotFoundError('Conversa');
    }
    return {
      conversation: conversation as any,
      inboxEvolutionInstance: inbox.evolutionInstance ?? null,
    };
  }

  /**
   * Resolve o inbox-alvo. Se inboxId vier, valida escopo da conta. Senão
   * pega o PRIMEIRO inbox WhatsApp ATIVO da conta (ordenado por createdAt).
   * 422 se não houver nenhum inbox WhatsApp configurado.
   */
  private async resolveInbox(
    accountId: string,
    inboxId?: string
  ): Promise<{ id: string; channelType: string; evolutionInstance: string | null }> {
    if (inboxId) {
      const inbox = await prisma.inbox.findFirst({
        where: { id: inboxId, accountId },
        select: { id: true, channelType: true, evolutionInstance: true, active: true },
      });
      if (!inbox) throw new NotFoundError('Inbox');
      if (inbox.channelType !== 'whatsapp') {
        throw new AppError(
          'Inbox informado não é WhatsApp',
          422,
          'CHANNEL_NOT_SUPPORTED',
          { channelType: inbox.channelType }
        );
      }
      return inbox;
    }

    const inbox = await prisma.inbox.findFirst({
      where: { accountId, channelType: 'whatsapp', active: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, channelType: true, evolutionInstance: true },
    });
    if (!inbox) {
      throw new AppError(
        'Nenhum inbox WhatsApp ativo configurado nesta conta',
        422,
        'NO_WHATSAPP_INBOX'
      );
    }
    return inbox;
  }

  /**
   * Mapeia o type do payload externo para o contentType interno do Message.
   * - text → 'text'
   * - image → 'media'
   * - audio → 'audio'
   * - document → 'document'
   */
  private typeToContentType(type: WhatsappSendType): MessageContentType {
    switch (type) {
      case 'text':
        return 'text';
      case 'image':
        return 'media';
      case 'audio':
        return 'audio';
      case 'document':
        return 'document';
    }
  }

  /**
   * Constrói o array de attachments persistido em Message, derivado do
   * payload de mídia (URL ou base64). Para `type=text` retorna undefined.
   *
   * NOTA: pra `mediaBase64` usamos o próprio data-URL como fileUrl/sourceUrl
   * pra preservar o payload e permitir materialização posterior pelo
   * attachment-storage worker (mesma estratégia do webhook Evolution).
   */
  private buildAttachments(input: WhatsappSendInput): CreateAttachmentInput[] | undefined {
    if (input.type === 'text') return undefined;

    const fileType: CreateAttachmentInput['fileType'] =
      input.type === 'image' ? 'image' : input.type === 'audio' ? 'audio' : 'document';

    const fileUrl = input.mediaUrl ?? input.mediaBase64 ?? '';
    if (!fileUrl) {
      // Defensivo — o controller Zod já garante XOR mediaUrl/mediaBase64,
      // mas se chegou aqui sem nada, ValidationError pra não persistir
      // attachment quebrado.
      throw new ValidationError('Mídia obrigatória para type != text');
    }

    return [
      {
        fileType,
        fileUrl,
        sourceUrl: fileUrl,
        mimeType: input.mimeType ?? undefined,
        fileName: input.filename ?? undefined,
      },
    ];
  }

  /**
   * Despacha pra Evolution API conforme o tipo. Cada caminho usa o método
   * dedicado do evolutionService — sendText/sendMedia/sendAudio. Sempre
   * passa `instance` per-inbox (pode ser null pra cair no fallback Account).
   */
  private async dispatchByType(
    accountId: string,
    args: {
      type: WhatsappSendType;
      number: string;
      content?: string;
      mediaUrl?: string;
      mediaBase64?: string;
      filename?: string;
      instance: string | null;
    }
  ): Promise<{ messageId: string }> {
    const { type, number, instance } = args;

    if (type === 'text') {
      if (!args.content || args.content.trim() === '') {
        throw new ValidationError('content obrigatório para type=text');
      }
      const res = await evolutionService.sendText(accountId, {
        number,
        text: args.content,
        instance,
      });
      return { messageId: res.messageId };
    }

    if (type === 'audio') {
      const audioUrl = args.mediaUrl ?? args.mediaBase64 ?? '';
      if (!audioUrl) throw new ValidationError('audio requer mediaUrl ou mediaBase64');
      const res = await evolutionService.sendAudio(accountId, {
        number,
        audioUrl,
        instance,
      });
      return { messageId: res.messageId };
    }

    // image | document → sendMedia
    const mediaUrl = args.mediaUrl ?? args.mediaBase64 ?? '';
    if (!mediaUrl) throw new ValidationError('mídia requer mediaUrl ou mediaBase64');
    const res = await evolutionService.sendMedia(accountId, {
      number,
      mediaUrl,
      mediaType: type === 'image' ? 'image' : 'document',
      caption: type === 'image' ? args.content : undefined,
      fileName: args.filename,
      instance,
    });
    return { messageId: res.messageId };
  }
}

export const whatsappSendService = new WhatsappSendService();
