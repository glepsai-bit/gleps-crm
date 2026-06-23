/**
 * CHAT METRICS CONTROLLER — T-022 Sprint 4 (Chat interno)
 *
 * Expõe métricas do chat interno (model Conversation / Message / SLABreach)
 * via HTTP. Toda chamada é multi-tenant: o `accountId` vem do JWT autenticado
 * — admins não podem consultar outra conta, super_admins usam a sua conta
 * corrente (impersonation já popula `req.user.accountId`).
 *
 * Endpoints:
 *   - GET /chat/metrics?fromDate&toDate&inboxId&teamId&agentId
 *   - GET /chat/metrics/agent/:userId?fromDate&toDate
 *
 * Singleton: `chatMetricsController`.
 */

import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { chatMetricsService } from '../services/chat-metrics.service';
import { AuthenticatedRequest } from '../types';
import { ValidationError, ForbiddenError, ErrorCodes } from '../utils/errors';

// ============================================
// Validação de querystring
// ============================================

const periodSchema = z
  .object({
    fromDate: z.string().datetime({ offset: true }).optional(),
    toDate: z.string().datetime({ offset: true }).optional(),
  })
  .refine(
    (v) => {
      if (!v.fromDate || !v.toDate) return true;
      return new Date(v.fromDate).getTime() <= new Date(v.toDate).getTime();
    },
    { message: 'fromDate deve ser anterior ou igual a toDate', path: ['fromDate'] }
  );

const filtersSchema = periodSchema.and(
  z.object({
    inboxId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    agentId: z.string().uuid().optional(),
  })
);

const DEFAULT_WINDOW_DAYS = 30;

/**
 * Resolve fromDate/toDate: aceita ISO da querystring; default = últimos 30 dias
 * até "agora". Garante objetos `Date` válidos.
 */
function resolvePeriod(
  rawFrom: string | undefined,
  rawTo: string | undefined
): { fromDate: Date; toDate: Date } {
  const toDate = rawTo ? new Date(rawTo) : new Date();
  const fromDate = rawFrom
    ? new Date(rawFrom)
    : new Date(toDate.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new ValidationError('Datas inválidas em fromDate/toDate');
  }

  return { fromDate, toDate };
}

export class ChatMetricsController {
  /**
   * GET /chat/metrics
   *
   * Query: fromDate?, toDate?, inboxId?, teamId?, agentId?
   * Retorna métricas agregadas do período para a conta do usuário autenticado.
   */
  async getMetrics(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user?.accountId) {
        throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
      }

      const parsed = filtersSchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError('Parâmetros de filtro inválidos', {
          issues: parsed.error.flatten(),
        });
      }

      const { fromDate, toDate } = resolvePeriod(
        parsed.data.fromDate,
        parsed.data.toDate
      );

      const result = await chatMetricsService.getMetrics(req.user.accountId, {
        fromDate,
        toDate,
        inboxId: parsed.data.inboxId,
        teamId: parsed.data.teamId,
        agentId: parsed.data.agentId,
      });

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /chat/metrics/agent/:userId
   *
   * Query: fromDate?, toDate?
   * Retorna métricas individuais de um agente da conta autenticada.
   */
  async getAgentMetrics(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user?.accountId) {
        throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
      }

      const userIdRaw = req.params.userId;
      const userId = typeof userIdRaw === 'string' ? userIdRaw : '';
      if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) {
        throw new ValidationError('userId inválido');
      }

      const parsed = periodSchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError('Parâmetros de filtro inválidos', {
          issues: parsed.error.flatten(),
        });
      }

      const { fromDate, toDate } = resolvePeriod(
        parsed.data.fromDate,
        parsed.data.toDate
      );

      const result = await chatMetricsService.getAgentMetrics(
        req.user.accountId,
        userId,
        { fromDate, toDate }
      );

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const chatMetricsController = new ChatMetricsController();
