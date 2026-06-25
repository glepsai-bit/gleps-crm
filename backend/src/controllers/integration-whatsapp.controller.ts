import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { whatsappSendService } from '../services/whatsapp-send.service';
import { UnauthorizedError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

// ============================================
// Validation schema (T-022 — Integração WhatsApp via API key)
//
// Aceita dois modos de endereçamento:
//   - conversationId: a conversa já existe (CRM resolve telefone + inbox)
//   - phone (+ inboxId opcional): cria/usa contato e dispara via Evolution
//
// Tipos suportados:
//   - text     → exige `content`
//   - image    → exige `mediaUrl` OU `mediaBase64`
//   - document → exige `mediaUrl` OU `mediaBase64` (+ filename idealmente)
//   - audio    → exige `mediaUrl` OU `mediaBase64`
//
// sender_type padrão é 'integration' (n8n, ERPs, webhooks externos).
// 'ai_bot' fica reservado para agentes IA externos.
// ============================================

const sendSchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    phone: z.string().min(10).max(20).optional(),
    inboxId: z.string().uuid().optional(),
    type: z.enum(['text', 'image', 'audio', 'document']),
    content: z.string().optional(),
    mediaUrl: z.string().url().optional(),
    mediaBase64: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    sender_type: z.enum(['ai_bot', 'integration']).default('integration'),
    metadata: z.record(z.any()).optional(),
  })
  .refine((d) => d.conversationId || d.phone, {
    message: 'conversationId OR phone required',
  })
  .refine(
    (d) => {
      if (d.type === 'text') return !!d.content;
      if (d.type === 'image' || d.type === 'document') {
        return !!(d.mediaUrl || d.mediaBase64);
      }
      if (d.type === 'audio') return !!(d.mediaUrl || d.mediaBase64);
      return false;
    },
    { message: 'content or media required based on type' }
  );

export type IntegrationWhatsappSendInput = z.infer<typeof sendSchema>;

export class IntegrationWhatsappController {
  /**
   * POST /api/integrations/whatsapp/send
   *
   * Endpoint genérico de envio WhatsApp para integrações externas
   * (n8n, agentes IA, ERPs). Aceita texto, imagem, áudio e documento.
   *
   * Auth: API key (requireApiKey já populou req.accountId e req.apiKey).
   * Scope: validado no router (messages:write / "*").
   *
   * Toda lógica de resolução de conversa, contato, inbox e dispatch
   * Evolution está concentrada em whatsappSendService.send — o controller
   * é só validação Zod + binding HTTP.
   */
  async send(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.accountId;
      if (!accountId) {
        throw new UnauthorizedError('API key inválida ou revogada');
      }

      const parsed = sendSchema.parse(req.body ?? {});

      const result = await whatsappSendService.send(accountId, {
        ...parsed,
        apiKeyId: req.apiKey?.id ?? null,
      });

      logger.info('[integration-whatsapp] send ok', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        type: parsed.type,
        hasConversationId: Boolean(parsed.conversationId),
        hasPhone: Boolean(parsed.phone),
        hasInboxId: Boolean(parsed.inboxId),
        sender_type: parsed.sender_type,
      });

      res.status(200).json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Payload inválido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }
}

export const integrationWhatsappController = new IntegrationWhatsappController();
