import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { webhookOutboundService } from '../services/webhook-outbound.service';
import { AuthenticatedRequest } from '../types';
import { ValidationError, ForbiddenError, ErrorCodes } from '../utils/errors';
import { isSafeOutboundUrl } from '../utils/ssrf-guard';

// ============================================
// Validation schemas
// ============================================

/**
 * URL externa para webhook outbound. Bloqueia loopback, IPs privados
 * (RFC1918), link-local/metadata (169.254.x.x — AWS IMDS), schemes
 * file://, javascript:, etc. e hosts internos (*.internal, *.local).
 * Ver utils/ssrf-guard.ts.
 */
const safeWebhookUrl = z
  .string()
  .url('URL inválida')
  .superRefine((value, ctx) => {
    const check = isSafeOutboundUrl(value);
    if (!check.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `URL não permitida: ${check.reason}`,
      });
    }
  });

const createSubscriptionSchema = z.object({
  name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  url: safeWebhookUrl,
  events: z
    .array(z.string().min(1, 'eventType inválido'))
    .min(1, 'Informe ao menos um evento'),
  active: z.boolean().optional(),
});

const updateSubscriptionSchema = z
  .object({
    name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres').optional(),
    url: safeWebhookUrl.optional(),
    events: z
      .array(z.string().min(1, 'eventType inválido'))
      .min(1, 'Informe ao menos um evento')
      .optional(),
    active: z.boolean().optional(),
  })
  .refine(data => Object.keys(data).length > 0, {
    message: 'Nada para atualizar',
  });

// ============================================
// Helpers
// ============================================

/**
 * Resolve o accountId efetivo da requisição.
 * - admin: sempre a própria conta (req.user.accountId)
 * - super_admin: aceita override via ?accountId= (necessário, pois não tem accountId próprio)
 */
function resolveAccountId(req: AuthenticatedRequest): string {
  const user = req.user;
  if (!user) {
    throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
  }

  if (user.role === 'super_admin') {
    const override = (req.query.accountId as string) || (req.body?.accountId as string);
    if (!override) {
      throw new ValidationError('accountId é obrigatório para super_admin');
    }
    return override;
  }

  if (!user.accountId) {
    throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
  }

  return user.accountId;
}

export class WebhookOutboundController {
  /**
   * GET /api/webhooks
   * Lista webhooks da conta (nunca retorna o secret HMAC).
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = resolveAccountId(req);
      const result = await webhookOutboundService.listSubscriptions(accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/webhooks/:id
   * Retorna um webhook específico (sem secret).
   */
  async get(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      if (!id) {
        throw new ValidationError('id do webhook é obrigatório');
      }

      const accountId = resolveAccountId(req);

      // O service não tem um getOne dedicado — reaproveitamos list+filter
      // para manter o escopo por accountId garantido em uma única consulta.
      const all = await webhookOutboundService.listSubscriptions(accountId);
      const found = all.find(sub => sub.id === id);
      if (!found) {
        throw new ValidationError('Webhook não encontrado');
      }

      res.json({ data: found });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/webhooks
   * Body: { name, url, events: string[], active? }
   * Retorna o secret HMAC em texto plano APENAS UMA VEZ.
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = resolveAccountId(req);
      const body = createSubscriptionSchema.parse(req.body);

      const result = await webhookOutboundService.createSubscription(accountId, body);

      res.status(201).json({
        data: {
          id: result.id,
          accountId: result.accountId,
          name: result.name,
          url: result.url,
          events: result.events,
          active: result.active,
          lastDeliveryAt: result.lastDeliveryAt,
          createdAt: result.createdAt,
          updatedAt: result.updatedAt,
          // Plaintext secret exposto somente nesta resposta de criação
          secret: result.secret,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/webhooks/:id
   * Body parcial: { name?, url?, events?, active? }
   */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      if (!id) {
        throw new ValidationError('id do webhook é obrigatório');
      }

      const accountId = resolveAccountId(req);
      const body = updateSubscriptionSchema.parse(req.body);

      const result = await webhookOutboundService.updateSubscription(id, accountId, body);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/webhooks/:id
   */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      if (!id) {
        throw new ValidationError('id do webhook é obrigatório');
      }

      const accountId = resolveAccountId(req);
      await webhookOutboundService.deleteSubscription(id, accountId);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/webhooks/:id/deliveries?limit=
   * Lista as últimas tentativas de entrega.
   */
  async listDeliveries(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const id = req.params.id as string;
      if (!id) {
        throw new ValidationError('id do webhook é obrigatório');
      }

      const accountId = resolveAccountId(req);

      const limitRaw = req.query.limit as string | undefined;
      const offsetRaw = req.query.offset as string | undefined;

      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
      const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : undefined;

      if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
        throw new ValidationError('limit inválido');
      }
      if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
        throw new ValidationError('offset inválido');
      }

      const result = await webhookOutboundService.listDeliveries(id, accountId, {
        limit,
        offset,
      });

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/webhooks/:id/test
   * Dispara um ping síncrono para validar a URL configurada.
   * Não persiste WebhookDelivery — é puramente diagnóstico.
   */
  async test(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      if (!id) {
        throw new ValidationError('id do webhook é obrigatório');
      }

      const accountId = resolveAccountId(req);
      const result = await webhookOutboundService.testSubscription(id, accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const webhookOutboundController = new WebhookOutboundController();
