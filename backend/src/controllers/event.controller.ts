import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { eventService } from '../services/event.service';
import { AuthenticatedRequest } from '../types';
import { getPaginationParams, getDateRangeFilter } from '../utils/helpers';

const listEventsSchema = z.object({
  type: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export class EventController {
  /**
   * GET /events
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = listEventsSchema.parse(req.query);
      const pagination = getPaginationParams(req);

      const filters = {
        accountId: req.user!.role === 'super_admin' ? undefined : req.user!.accountId!,
        eventType: query.type,
        entityType: query.entityType,
        entityId: query.entityId,
        actorId: query.actorId,
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
      };

      const result = await eventService.list(filters, pagination);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /events/:id
   */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await eventService.getById(id);

      if (!result) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Evento não encontrado' },
        });
        return;
      }

      // Check access
      if (req.user!.role !== 'super_admin' && result.accountId !== req.user!.accountId) {
        res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Acesso negado' },
        });
        return;
      }

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /events/user-activity
   */
  async getUserActivity(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await eventService.getUserActivity(req.user!.accountId!);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /events/online-status
   */
  async getOnlineStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await eventService.getUserActivity(req.user!.accountId!);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /events/stats
   */
  async getStats(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);
      const result = await eventService.getStats(req.user!.accountId!, dateRange);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const eventController = new EventController();
