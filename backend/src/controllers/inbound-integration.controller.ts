import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { inboundIntegrationService } from '../services/inbound-integration.service';
import { AuthenticatedRequest } from '../types';
import {
  ValidationError,
  ForbiddenError,
  ErrorCodes,
} from '../utils/errors';

// ============================================
// Validation schemas
// ============================================

const createInboundSchema = z.object({
  slug: z.string().min(2, 'slug é obrigatório'),
  handler: z.string().min(1, 'handler é obrigatório'),
  config: z.record(z.any()).optional(),
  // BUG-002 (CRITICAL): secret é OBRIGATÓRIO no create — sem ele, qualquer
  // pessoa que descubra a URL pública pode disparar o webhook. Mínimo 16
  // caracteres para evitar segredos triviais. O schema Prisma permanece
  // nullable (compat com dados antigos) mas processWebhook bloqueia integrações
  // sem secret em runtime.
  secret: z
    .string({ required_error: 'secret é obrigatório' })
    .min(16, 'secret deve ter no mínimo 16 caracteres'),
});

/**
 * Resolve o accountId a partir do usuário autenticado.
 * - admin/agent: usa o próprio accountId
 * - super_admin: precisa informar accountId via query string ou body
 */
function resolveAccountId(req: AuthenticatedRequest): string {
  const user = req.user;
  if (!user) {
    throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
  }

  if (user.role === 'super_admin') {
    const fromQuery = (req.query.accountId as string | undefined) ?? undefined;
    const fromBody =
      req.body && typeof req.body === 'object'
        ? (req.body.accountId as string | undefined)
        : undefined;
    const accountId = fromQuery ?? fromBody;
    if (!accountId) {
      throw new ValidationError(
        'accountId é obrigatório para super_admin (query ou body)'
      );
    }
    return accountId;
  }

  if (!user.accountId) {
    throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
  }

  return user.accountId;
}

// ============================================
// Controller
// ============================================

export class InboundIntegrationController {
  /**
   * GET /api/integrations/inbound
   * Lista as integrações de webhook inbound da conta autenticada.
   */
  async list(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = resolveAccountId(req);
      const data = await inboundIntegrationService.list(accountId);
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/integrations/inbound
   * Body: { slug, handler, config?, secret? }
   */
  async create(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = resolveAccountId(req);
      const body = createInboundSchema.parse(req.body);

      const integration = await inboundIntegrationService.create(accountId, {
        slug: body.slug,
        handler: body.handler,
        config: body.config,
        secret: body.secret,
      });

      res.status(201).json({ data: integration });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/integrations/inbound/:slug
   */
  async delete(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = resolveAccountId(req);
      const slug = (req.params.slug ?? '').toString();
      if (!slug) {
        throw new ValidationError('slug é obrigatório');
      }

      await inboundIntegrationService.delete(slug, accountId);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/integrations/inbound/:accountId/:slug
   * PÚBLICO — não exige JWT. Auth feita por HMAC (opcional) dentro do service.
   */
  async receive(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = (req.params.accountId ?? '').toString();
      const slug = (req.params.slug ?? '').toString();

      if (!accountId) {
        throw new ValidationError('accountId é obrigatório');
      }
      if (!slug) {
        throw new ValidationError('slug é obrigatório');
      }

      // BUG-007: passa rawBody (Buffer) capturado em express.json({ verify })
      // — necessário pra HMAC bater byte-a-byte com o que o cliente assinou.
      const rawBody = (req as any).rawBody as Buffer | undefined;

      const result = await inboundIntegrationService.processWebhook(
        accountId,
        slug,
        req.body,
        req.headers as Record<string, any>,
        rawBody
      );

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const inboundIntegrationController = new InboundIntegrationController();
