/**
 * TRACKING CONTROLLER — config da conexão Meta + funil de métricas.
 * Admin-only (rotas). O token NUNCA volta inteiro pra UI: só last4.
 */
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../types';
import { trackingService } from '../services/tracking.service';
import { ValidationError } from '../utils/errors';

const configBodySchema = z.object({
  accessToken: z.string().max(1024).optional(),
  pixelId: z.string().max(64).optional(),
  adAccountId: z.string().max(64).optional(),
  active: z.boolean().optional(),
  sendLead: z.boolean().optional(),
  sendSchedule: z.boolean().optional(),
  sendPurchase: z.boolean().optional(),
});

const funnelQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
});

function maskConfig(config: Awaited<ReturnType<typeof trackingService.getConfig>>) {
  if (!config) return null;
  const { accessToken, ...rest } = config;
  return {
    ...rest,
    hasToken: Boolean(accessToken),
    tokenLast4: accessToken ? accessToken.slice(-4) : null,
  };
}

export class TrackingController {
  /** GET /api/tracking/config */
  async getConfig(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const config = await trackingService.getConfig(accountId);
      res.json({ data: maskConfig(config) });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /api/tracking/config */
  async saveConfig(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const parsed = configBodySchema.parse(req.body ?? {});
      const saved = await trackingService.saveConfig(accountId, parsed);
      res.json({ data: maskConfig(saved) });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/tracking/funnel?days=30 | ?from=...&to=... */
  async getFunnel(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const parsed = funnelQuerySchema.parse(req.query);

      const to = parsed.to ? new Date(parsed.to) : new Date();
      const from = parsed.from
        ? new Date(parsed.from)
        : new Date(to.getTime() - (parsed.days ?? 30) * 24 * 60 * 60 * 1000);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
        throw new ValidationError('Período inválido');
      }

      const data = await trackingService.getFunnel(accountId, from, to);
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/tracking/events — últimos eventos enviados (auditoria). */
  async listEvents(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const limit = Number(req.query.limit) || 50;
      const data = await trackingService.listRecentEvents(accountId, limit);
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }
}

export const trackingController = new TrackingController();
