import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { slaService } from '../services/sla.service';
import { AuthenticatedRequest } from '../types';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ErrorCodes,
} from '../utils/errors';

// ============================================
// Validation schemas
// ============================================

// T1-SLA-COERENCIA: garantir resolutionMin >= firstResponseMin.
// Sem esse check, o cron de SLA pode disparar resolution breach antes do
// first_response breach (tempos invertidos), o que e logicamente incoerente.
const createPolicySchema = z
  .object({
    name: z
      .string()
      .min(1, 'name e obrigatorio')
      .max(120, 'name deve ter no maximo 120 caracteres'),
    firstResponseMin: z
      .number({ invalid_type_error: 'firstResponseMin deve ser numerico' })
      .int('firstResponseMin deve ser inteiro')
      .positive('firstResponseMin deve ser positivo'),
    resolutionMin: z
      .number({ invalid_type_error: 'resolutionMin deve ser numerico' })
      .int('resolutionMin deve ser inteiro')
      .positive('resolutionMin deve ser positivo'),
    businessHoursOnly: z.boolean().optional(),
    pauseWhenWaitingCustomer: z.boolean().optional(),
    businessHoursStart: z.string().regex(/^([0-2]\d):([0-5]\d)$/).optional(),
    businessHoursEnd: z.string().regex(/^([0-2]\d):([0-5]\d)$/).optional(),
    businessDays: z.array(z.number().int().min(0).max(6)).optional(),
    timezone: z.string().max(60).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.resolutionMin != null &&
      data.firstResponseMin != null &&
      data.resolutionMin < data.firstResponseMin
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'resolutionMin deve ser >= firstResponseMin',
        path: ['resolutionMin'],
      });
    }
  });

const updatePolicySchema = z
  .object({
    name: z
      .string()
      .min(1, 'name e obrigatorio')
      .max(120, 'name deve ter no maximo 120 caracteres')
      .optional(),
    firstResponseMin: z
      .number()
      .int('firstResponseMin deve ser inteiro')
      .positive('firstResponseMin deve ser positivo')
      .optional(),
    resolutionMin: z
      .number()
      .int('resolutionMin deve ser inteiro')
      .positive('resolutionMin deve ser positivo')
      .optional(),
    businessHoursOnly: z.boolean().optional(),
    active: z.boolean().optional(),
    // SLA v2 — pausa + horario comercial (mesmos shapes do create)
    pauseWhenWaitingCustomer: z.boolean().optional(),
    businessHoursStart: z
      .string()
      .regex(/^([0-2]\d):([0-5]\d)$/)
      .nullable()
      .optional(),
    businessHoursEnd: z
      .string()
      .regex(/^([0-2]\d):([0-5]\d)$/)
      .nullable()
      .optional(),
    businessDays: z.array(z.number().int().min(0).max(6)).optional(),
    timezone: z.string().max(60).optional(),
  })
  .refine(data => Object.keys(data).length > 0, {
    message: 'Nada para atualizar',
  })
  .superRefine((data, ctx) => {
    // T1-SLA-COERENCIA: idem para updates parciais quando AMBOS vierem juntos.
    // Se so um for atualizado, validacao adicional contra o valor persistido
    // deveria acontecer no service layer (fora do escopo deste fix).
    if (
      data.resolutionMin != null &&
      data.firstResponseMin != null &&
      data.resolutionMin < data.firstResponseMin
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'resolutionMin deve ser >= firstResponseMin',
        path: ['resolutionMin'],
      });
    }
  });

const applyPolicySchema = z.object({
  policyId: z.string().min(1, 'policyId e obrigatorio'),
});

// ============================================
// Helpers
// ============================================

/**
 * Resolve o accountId efetivo da requisicao.
 * - admin: sempre a propria conta (req.user.accountId)
 * - super_admin: aceita override via ?accountId= (necessario, pois nao tem accountId proprio)
 *
 * Segue o mesmo padrao de webhook-outbound.controller.
 */
function resolveAccountId(req: AuthenticatedRequest): string {
  const user = req.user;
  if (!user) {
    throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
  }

  if (user.role === 'super_admin') {
    const override =
      (req.query.accountId as string) || (req.body?.accountId as string);
    if (!override) {
      throw new ValidationError('accountId e obrigatorio para super_admin');
    }
    return override;
  }

  if (!user.accountId) {
    throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
  }

  return user.accountId;
}

const dashboardSchema = z.object({
  fromDate: z.string().min(1, 'fromDate e obrigatorio'),
  toDate: z.string().min(1, 'toDate e obrigatorio'),
});

export class SLAController {
  // ============================================
  // CRUD de policies
  // ============================================

  /**
   * GET /api/sla-policies
   * Lista todas as politicas de SLA da conta.
   */
  async list(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = resolveAccountId(req);
      const result = await slaService.listPolicies(accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/sla-policies/:id
   * Retorna uma politica especifica da conta.
   */
  async get(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const id = req.params.id as string;
      if (!id) {
        throw new ValidationError('id da politica e obrigatorio');
      }

      const accountId = resolveAccountId(req);

      // O service nao expoe getPolicy publicamente — reaproveitamos list+filter
      // para manter o escopo por accountId garantido em uma unica consulta,
      // seguindo o mesmo padrao de WebhookOutboundController.get.
      const all = await slaService.listPolicies(accountId);
      const found = all.find(policy => policy.id === id);
      if (!found) {
        throw new NotFoundError('Politica de SLA');
      }

      res.json({ data: found });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/sla-policies
   * Body: { name, firstResponseMin, resolutionMin, businessHoursOnly? }
   */
  async create(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = resolveAccountId(req);
      const body = createPolicySchema.parse(req.body);

      const result = await slaService.createPolicy(accountId, body);

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/sla-policies/:id
   * Body parcial: { name?, firstResponseMin?, resolutionMin?, businessHoursOnly?, active? }
   */
  async update(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const id = req.params.id as string;
      if (!id) {
        throw new ValidationError('id da politica e obrigatorio');
      }

      const accountId = resolveAccountId(req);
      const body = updatePolicySchema.parse(req.body);

      const result = await slaService.updatePolicy(id, accountId, body);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/sla-policies/:id
   * Remove uma politica. Conversations referenciadas tem slaPolicyId
   * resetado para null (onDelete: SetNull no schema).
   */
  async delete(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const id = req.params.id as string;
      if (!id) {
        throw new ValidationError('id da politica e obrigatorio');
      }

      const accountId = resolveAccountId(req);
      await slaService.deletePolicy(id, accountId);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // Aplicacao em conversation
  // ============================================

  /**
   * POST /api/conversations/:id/sla
   * Body: { policyId }
   * Aplica uma politica de SLA a uma conversation.
   */
  async applyToConversation(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const conversationId = req.params.id as string;
      if (!conversationId) {
        throw new ValidationError('id da conversation e obrigatorio');
      }

      const accountId = resolveAccountId(req);
      const { policyId } = applyPolicySchema.parse(req.body);

      await slaService.applyPolicyToConversation(
        conversationId,
        accountId,
        policyId
      );

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // Breaches recentes por policy
  // ============================================

  /**
   * GET /api/sla-policies/:id/breaches
   * Retorna os N=50 breaches mais recentes da politica.
   * Escopada por accountId via verificacao previa da policy.
   */
  /**
   * GET /api/sla/dashboard?fromDate=...&toDate=...
   * Dashboard SLA v2 — metricas agregadas para o periodo.
   */
  async getDashboard(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = resolveAccountId(req);
      const { fromDate, toDate } = dashboardSchema.parse(req.query);

      const from = new Date(fromDate);
      const to = new Date(toDate);
      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        throw new ValidationError('fromDate/toDate devem ser ISO 8601');
      }

      const result = await slaService.getDashboard(accountId, {
        fromDate: from,
        toDate: to,
      });
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  async listRecentBreaches(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const id = req.params.id as string;
      if (!id) {
        throw new ValidationError('id da politica e obrigatorio');
      }

      const accountId = resolveAccountId(req);

      // Garante que a policy pertence a conta antes de listar os breaches.
      const policy = await prisma.sLAPolicy.findFirst({
        where: { id, accountId },
        select: { id: true },
      });

      if (!policy) {
        throw new NotFoundError('Politica de SLA');
      }

      // Carrega a policy junto para conseguir derivar expectedMin
      // (first_response_min vs resolution_min) por tipo de breach.
      const policyFull = await prisma.sLAPolicy.findFirst({
        where: { id, accountId },
        select: {
          id: true,
          firstResponseMin: true,
          resolutionMin: true,
        },
      });

      const breaches = await prisma.sLABreach.findMany({
        where: { slaPolicyId: id },
        orderBy: { breachedAt: 'desc' },
        take: 50,
      });

      // Transformer: preserva o contrato esperado pelo FE
      // (type / expectedMin / actualMin / createdAt) a partir do
      // schema real (breachType / expectedAt / breachedAt / notifiedAt).
      const data = breaches.map(b => {
        const expectedMin =
          b.breachType === 'first_response'
            ? (policyFull?.firstResponseMin ?? 0)
            : b.breachType === 'resolution'
              ? (policyFull?.resolutionMin ?? 0)
              : 0;

        // actualMin = expectedMin + minutos de atraso ate o breach ser detectado.
        // Se notifiedAt existe, usa o tempo total ate a notificacao.
        const expectedAtMs = b.expectedAt.getTime();
        const breachedAtMs = b.breachedAt.getTime();
        const overdueMs = Math.max(0, breachedAtMs - expectedAtMs);
        const actualMin = expectedMin + Math.round(overdueMs / 60000);

        return {
          id: b.id,
          slaPolicyId: b.slaPolicyId,
          conversationId: b.conversationId,
          type: b.breachType,
          breachType: b.breachType,
          expectedAt: b.expectedAt.toISOString(),
          breachedAt: b.breachedAt.toISOString(),
          notifiedAt: b.notifiedAt ? b.notifiedAt.toISOString() : null,
          expectedMin,
          actualMin,
          createdAt: b.breachedAt.toISOString(),
        };
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  }
}

export const slaController = new SLAController();
