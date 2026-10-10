import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { whatsappSendService } from '../services/whatsapp-send.service';
import { renderTemplate, whatsappTemplateService } from '../services/whatsapp-template.service';
import {
  criarCampanha,
  detalharCampanha,
  listarCampanhas,
  telefoneDoContato,
  FONTES_DA_CAMPANHA,
  type FonteDaCampanha,
} from '../services/disparo/compat-campanhas';
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

// ============================================
// /campaigns/* — contrato antigo (whatsapp-campaign) sobre o motor novo.
// Os nomes dos campos são os de antes; o que o motor não configura mais
// (delaySeconds) é aceito e ignorado.
// ============================================

const recordOfStringsSchema = z.record(z.string());
const recordOfAnySchema = z.record(z.any());

// Telefone com 10–15 dígitos (BR com DDI). O motor normaliza de novo na borda,
// mas aqui pegamos cedo com 400 e mensagem clara.
const phoneDigits = z.string().regex(/^\d{10,15}$/, 'Telefone deve ter 10-15 digitos numericos');
const phoneRecipientSchema = z.union([
  phoneDigits,
  z.object({
    phone: phoneDigits,
    name: z.string().optional(),
    variables: recordOfStringsSchema.optional(),
  }),
]);

const scheduledAtSchema = z.union([z.string().datetime({ offset: true }), z.string().datetime(), z.date()]);

const sendBatchSchema = z
  .object({
    contactIds: z.array(z.string().min(1)).max(1000).optional(),
    // Limite operacional de 1000 destinatários por disparo; campanhas maiores
    // são fragmentadas em mais de um.
    phones: z.array(phoneRecipientSchema).min(1).max(1000).optional(),
    templateId: z.string().min(1).optional(),
    content: z.string().optional(),
    /** Alias de `content` (o contrato da etapa C1 chama de `message`). */
    message: z.string().optional(),
    defaultVariables: recordOfStringsSchema.optional(),
    scheduledAt: scheduledAtSchema.optional(),
    /** Aceito e IGNORADO — o ritmo do motor é fixo (20–60 s, janela 08h–20h). */
    delaySeconds: z.number().int().nonnegative().optional(),
    triggerName: z.string().max(120).optional(),
    campaignType: z.string().max(80).optional(),
    inboxId: z.string().uuid().optional(),
    metadata: recordOfAnySchema.optional(),
    source: z.string().optional(),
  })
  .refine((d) => (d.contactIds && d.contactIds.length > 0) || (d.phones && d.phones.length > 0), {
    message: 'Informe contactIds ou phones',
    path: ['contactIds'],
  })
  .refine((d) => !!(d.templateId || d.content || d.message), {
    message: 'Informe templateId ou content',
    path: ['templateId'],
  })
  // scheduledAt no passado falha na borda (400) — integrações com relógio
  // errado ou retry atrasado não disparam sem querer.
  .refine(
    (d) => {
      if (!d.scheduledAt) return true;
      const dt = d.scheduledAt instanceof Date ? d.scheduledAt : new Date(d.scheduledAt);
      if (Number.isNaN(dt.getTime())) return true; // parseDate trata
      return dt.getTime() > Date.now();
    },
    { message: 'scheduledAt deve ser futuro', path: ['scheduledAt'] }
  );

const sendSingleSchema = z
  .object({
    contactId: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    contactName: z.string().optional(),
    templateId: z.string().min(1).optional(),
    content: z.string().optional(),
    variables: recordOfStringsSchema.optional(),
    triggerName: z.string().optional(),
    inboxId: z.string().uuid().optional(),
    metadata: recordOfAnySchema.optional(),
    source: z.string().optional(),
  })
  .refine((d) => !!(d.contactId || d.phone), { message: 'Informe contactId ou phone', path: ['contactId'] })
  .refine((d) => !!(d.templateId || d.content), { message: 'Informe templateId ou content', path: ['templateId'] });

const stringOrArray = z.union([z.string(), z.array(z.string())]);

const listBatchesSchema = z.object({
  status: stringOrArray.optional(),
  source: stringOrArray.optional(),
  triggerName: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  q: z.string().optional(),
  campaignType: stringOrArray.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const batchIdParamSchema = z.string().uuid('ID deve ser UUID valido');

function parseDate(value?: string | Date): Date | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError('Data inválida');
  return d;
}

/** Origem gravada no disparo: body.source se for um valor conhecido, senão 'api'. */
function resolveSource(bodySource?: string): FonteDaCampanha {
  return bodySource && FONTES_DA_CAMPANHA.includes(bodySource as FonteDaCampanha) ? (bodySource as FonteDaCampanha) : 'api';
}

function accountIdDaChave(req: Request): string {
  const accountId = req.accountId ?? req.apiKey?.accountId;
  if (!accountId) throw new UnauthorizedError('API key inválida ou revogada');
  return accountId;
}

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
      const accountId = accountIdDaChave(req);

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

  /**
   * POST /api/integrations/whatsapp/campaigns/send-batch
   * Cria um disparo (imediato ou agendado) no motor único.
   * Resposta (201): { data: { batchId, totalContacts, scheduled } } — como antes.
   */
  async sendBatch(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = accountIdDaChave(req);
      const body = sendBatchSchema.parse(req.body ?? {});

      const result = await criarCampanha(accountId, {
        contactIds: body.contactIds,
        phones: body.phones,
        templateId: body.templateId,
        content: body.content ?? body.message,
        defaultVariables: body.defaultVariables,
        scheduledAt: parseDate(body.scheduledAt),
        delaySeconds: body.delaySeconds,
        triggerName: body.triggerName,
        campaignType: body.campaignType,
        inboxId: body.inboxId,
        metadata: { ...(body.metadata ?? {}), apiKeyId: req.apiKey?.id ?? null },
        source: resolveSource(body.source),
      });

      logger.info('[integration-whatsapp] send-batch ok', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        batchId: result.batchId,
        totalContacts: result.totalContacts,
        scheduled: result.scheduled,
        delaySecondsIgnorado: body.delaySeconds ?? null,
      });

      res.status(201).json({ data: result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Payload inválido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * POST /api/integrations/whatsapp/campaigns/send-single
   * Uma mensagem de texto agora (contactId ou phone), pelo mesmo caminho do
   * /send: consentimento, limite por telefone e conversa no Chat.
   * Resposta (201): { data: { batchId: null, messageId, conversationId, contactId, status, error? } }.
   */
  async sendSingle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = accountIdDaChave(req);
      const body = sendSingleSchema.parse(req.body ?? {});

      let phone = (body.phone ?? '').replace(/\D+/g, '');
      let contactName = body.contactName ?? null;
      if (body.contactId) {
        const c = await telefoneDoContato(accountId, body.contactId);
        phone = c.telefone.replace(/\D+/g, '');
        contactName = contactName ?? c.nome;
      }
      if (!phone) throw new ValidationError('Informe contactId ou phone');

      const base = body.templateId ? (await whatsappTemplateService.get(body.templateId, accountId)).content : (body.content ?? '');
      const content = renderTemplate(base, { nome: contactName ?? '', ...(body.variables ?? {}) });
      if (!content.trim()) throw new ValidationError('Mensagem vazia');

      const result = await whatsappSendService.send(accountId, {
        phone,
        inboxId: body.inboxId,
        contactName: contactName ?? undefined,
        type: 'text',
        content,
        sender_type: 'integration',
        metadata: { ...(body.metadata ?? {}), triggerName: body.triggerName ?? null, source: resolveSource(body.source) },
        apiKeyId: req.apiKey?.id ?? null,
      });

      res.status(201).json({
        data: {
          batchId: null,
          messageId: result.messageId,
          conversationId: result.conversationId,
          contactId: result.contactId,
          status: result.status,
          ...(result.error ? { error: result.error.message } : {}),
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Payload inválido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /** GET /api/integrations/whatsapp/campaigns/batches — { data: Batch[] } */
  async listBatches(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = accountIdDaChave(req);
      const query = listBatchesSchema.parse(req.query ?? {});
      const result = await listarCampanhas(accountId, {
        status: query.status,
        source: query.source,
        triggerName: query.triggerName,
        fromDate: parseDate(query.fromDate),
        toDate: parseDate(query.toDate),
        q: query.q,
        campaignType: query.campaignType,
        limit: query.limit,
        offset: query.offset,
      });
      res.json({ data: result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Payload inválido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /** GET /api/integrations/whatsapp/campaigns/batches/:id — { data: Batch & { logs } } */
  async getBatch(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = accountIdDaChave(req);
      const id = batchIdParamSchema.parse(req.params.id);
      const result = await detalharCampanha(accountId, id);
      res.json({ data: result });
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
