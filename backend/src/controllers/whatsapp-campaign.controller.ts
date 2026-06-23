import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  whatsappCampaignService,
  type CampaignSource,
  type SendSingleParams,
  type SendBatchParams,
  type ListBatchesFilters,
} from '../services/whatsapp-campaign.service';
import { AuthenticatedRequest } from '../types';
import { UnauthorizedError, ValidationError } from '../utils/errors';

// ============================================
// Validation schemas
// ============================================

const recordOfStringsSchema = z.record(z.string());
const recordOfAnySchema = z.record(z.any());

const sendSingleSchema = z
  .object({
    contactId: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    contactName: z.string().optional(),
    templateId: z.string().min(1).optional(),
    content: z.string().optional(),
    variables: recordOfStringsSchema.optional(),
    triggerName: z.string().optional(),
    metadata: recordOfAnySchema.optional(),
    source: z.string().optional(),
  })
  .refine(data => !!(data.contactId || data.phone), {
    message: 'Informe contactId ou phone',
    path: ['contactId'],
  })
  .refine(data => !!(data.templateId || data.content), {
    message: 'Informe templateId ou content',
    path: ['templateId'],
  });

const phoneRecipientSchema = z.object({
  phone: z.string().min(1, 'phone é obrigatório'),
  name: z.string().optional(),
  variables: recordOfStringsSchema.optional(),
});

const sendBatchSchema = z
  .object({
    contactIds: z.array(z.string().min(1)).optional(),
    phones: z.array(phoneRecipientSchema).optional(),
    templateId: z.string().min(1).optional(),
    content: z.string().optional(),
    defaultVariables: recordOfStringsSchema.optional(),
    scheduledAt: z
      .union([z.string().datetime({ offset: true }), z.string().datetime(), z.date()])
      .optional(),
    delaySeconds: z.number().int().nonnegative().optional(),
    triggerName: z.string().optional(),
    metadata: recordOfAnySchema.optional(),
    source: z.string().optional(),
  })
  .refine(
    data =>
      (data.contactIds && data.contactIds.length > 0) ||
      (data.phones && data.phones.length > 0),
    { message: 'Informe contactIds ou phones', path: ['contactIds'] }
  )
  .refine(data => !!(data.templateId || data.content), {
    message: 'Informe templateId ou content',
    path: ['templateId'],
  });

const listBatchesSchema = z.object({
  status: z.string().optional(),
  source: z.string().optional(),
  triggerName: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

// ============================================
// Helpers
// ============================================

/**
 * Retorna accountId do request, suportando tanto autenticação JWT
 * (req.user.accountId) quanto API Key (req.apiKey.accountId).
 */
function getAccountId(req: Request): string {
  const authReq = req as AuthenticatedRequest;
  const fromJwt = authReq.user?.accountId ?? null;
  const fromApiKey = req.apiKey?.accountId ?? null;
  const accountId = fromJwt || fromApiKey;

  if (!accountId) {
    throw new UnauthorizedError('Conta não identificada no request');
  }

  return accountId;
}

/**
 * Resolve a origem (source) do disparo conforme o canal de autenticação.
 * - API Key: usa body.source se válido, senão 'api'
 * - JWT: usa 'manual' por default; aceita 'manual_scheduled' via body.source
 */
function resolveSource(req: Request, bodySource?: string): CampaignSource {
  const validSources: CampaignSource[] = [
    'manual',
    'manual_scheduled',
    'n8n',
    'api',
    'integration',
  ];

  if (req.apiKey) {
    if (bodySource && validSources.includes(bodySource as CampaignSource)) {
      return bodySource as CampaignSource;
    }
    return 'api';
  }

  // JWT path
  if (bodySource === 'manual_scheduled') return 'manual_scheduled';
  return 'manual';
}

function parseDate(value?: string | Date): Date | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError('Data inválida');
  }
  return d;
}

// ============================================
// Controller
// ============================================

export class WhatsappCampaignController {
  /**
   * POST /send-single
   * Envia uma única mensagem WhatsApp (cria batch de tamanho 1).
   */
  async sendSingle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = getAccountId(req);
      const body = sendSingleSchema.parse(req.body ?? {});

      const source = resolveSource(req, body.source);

      const params: SendSingleParams = {
        contactId: body.contactId,
        phone: body.phone,
        contactName: body.contactName,
        templateId: body.templateId,
        content: body.content,
        variables: body.variables,
        triggerName: body.triggerName,
        metadata: body.metadata,
        source,
      };

      const result = await whatsappCampaignService.sendSingle(accountId, params);

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /send-batch
   * Cria um disparo em massa (imediato ou agendado).
   */
  async sendBatch(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = getAccountId(req);
      const body = sendBatchSchema.parse(req.body ?? {});

      const source = resolveSource(req, body.source);
      const scheduledAt = parseDate(body.scheduledAt as string | Date | undefined);

      const params: SendBatchParams = {
        contactIds: body.contactIds,
        phones: body.phones,
        templateId: body.templateId,
        content: body.content,
        defaultVariables: body.defaultVariables,
        scheduledAt,
        delaySeconds: body.delaySeconds,
        triggerName: body.triggerName,
        metadata: body.metadata,
        source,
      };

      const result = await whatsappCampaignService.sendBatch(accountId, params);

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /batches
   * Lista batches da conta com filtros opcionais.
   */
  async listBatches(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = getAccountId(req);
      const query = listBatchesSchema.parse(req.query ?? {});

      const filters: ListBatchesFilters = {
        status: query.status,
        source: query.source as CampaignSource | undefined,
        triggerName: query.triggerName,
        fromDate: parseDate(query.fromDate),
        toDate: parseDate(query.toDate),
      };

      const result = await whatsappCampaignService.listBatches(accountId, filters);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /batches/:id
   * Detalhe de um batch (com logs).
   */
  async getBatch(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = getAccountId(req);
      const id = req.params.id as string | undefined;
      if (!id) {
        throw new ValidationError('id do batch é obrigatório');
      }

      const result = await whatsappCampaignService.getBatch(id, accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /batches/:id
   * Cancela um batch agendado (apenas status='scheduled').
   */
  async cancelScheduled(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = getAccountId(req);
      const id = req.params.id as string | undefined;
      if (!id) {
        throw new ValidationError('id do batch é obrigatório');
      }

      await whatsappCampaignService.cancelScheduled(id, accountId);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }
}

export const whatsappCampaignController = new WhatsappCampaignController();
