import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { calendarService } from '../services/calendar.service';
import { AuthenticatedRequest } from '../types';
import { getPaginationParams } from '../utils/helpers';

// Validation schemas
const createEventSchema = z.object({
  title: z.string().min(1, 'Título é obrigatório'),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  type: z.enum(['meeting', 'appointment', 'block', 'other']).optional(),
  location: z.string().optional(),
  meetingLink: z.string().url().optional(),
  contactId: z.string().uuid().optional(),
  notes: z.string().optional(),
  attendees: z.array(z.object({
    name: z.string(),
    email: z.string().email(),
  })).optional(),
});

const updateEventSchema = createEventSchema.partial().extend({
  status: z.enum(['scheduled', 'cancelled', 'completed']).optional(),
});

const listEventsSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  type: z.enum(['meeting', 'appointment', 'block', 'other']).optional(),
  status: z.enum(['scheduled', 'cancelled', 'completed']).optional(),
  contactId: z.string().uuid().optional(),
});

function readForwardedHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value?.split(',')[0]?.trim() ?? '';
}

function getRequestOrigin(req: Request): string {
  const originHeader = req.get('origin')?.trim();
  if (originHeader) return originHeader.replace(/\/$/, '');

  const proto = readForwardedHeader(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  const host = readForwardedHeader(req.headers['x-forwarded-host']) || req.get('host') || 'localhost:3000';

  return `${proto}://${host}`.replace(/\/$/, '');
}

export class CalendarController {
  /**
   * GET /calendar/events
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user!.accountId) {
        res.status(400).json({ error: { code: 'NO_ACCOUNT', message: 'Usuário não vinculado a uma conta' } });
        return;
      }
      const query = listEventsSchema.parse(req.query);
      const pagination = getPaginationParams(req);

      const filters = {
        accountId: req.user!.accountId!,
        type: query.type,
        status: query.status,
        contactId: query.contactId,
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
      };

      const result = await calendarService.list(filters, pagination);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /calendar/events/:id
   */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user!.accountId) { res.status(400).json({ error: { code: 'NO_ACCOUNT', message: 'Usuário não vinculado a uma conta' } }); return; }
      const id = req.params.id as string;
      const result = await calendarService.getById(id, req.user!.accountId!);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /calendar/events
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user!.accountId) { res.status(400).json({ error: { code: 'NO_ACCOUNT', message: 'Usuário não vinculado a uma conta' } }); return; }
      const body = createEventSchema.parse(req.body);
      const result = await calendarService.create({
        ...body,
        accountId: req.user!.accountId!,
        startTime: new Date(body.startTime),
        endTime: new Date(body.endTime),
        createdById: req.user!.id,
      });

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /calendar/events/:id
   */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = updateEventSchema.parse(req.body);
      const result = await calendarService.update(id, {
        ...body,
        startTime: body.startTime ? new Date(body.startTime) : undefined,
        endTime: body.endTime ? new Date(body.endTime) : undefined,
      }, req.user!.accountId!);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /calendar/events/:id
   */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      await calendarService.delete(id, req.user!.accountId!);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /calendar/google/connect
   */
  async connectGoogle(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const requestOrigin = getRequestOrigin(req);
      const authUrl = await calendarService.getGoogleAuthUrl(req.user!.accountId!, req.user!.id, requestOrigin);

      res.json({ data: { authUrl } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /calendar/google/callback
   */
  async googleCallback(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    const fallbackFrontendUrl = getRequestOrigin(req);
    try {
      const { code, state, error: oauthError } = req.query;

      if (oauthError) {
        res.redirect(`${fallbackFrontendUrl}/admin/agenda?google_error=${encodeURIComponent(oauthError as string)}`);
        return;
      }

      if (!code || !state) {
        res.redirect(`${fallbackFrontendUrl}/admin/agenda?google_error=missing_params`);
        return;
      }

      const result = await calendarService.handleGoogleCallback(code as string, state as string);
      const frontendUrl = (result.origin || fallbackFrontendUrl).replace(/\/$/, '');

      res.redirect(`${frontendUrl}/admin/agenda?google_connected=true`);
    } catch (error: any) {
      console.error('Google OAuth callback error:', error);
      res.redirect(`${fallbackFrontendUrl}/admin/agenda?google_error=${encodeURIComponent(error.message || 'unknown')}`);
    }
  }

  /**
   * POST /calendar/google/disconnect
   */
  async disconnectGoogle(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      await calendarService.disconnectGoogle(req.user!.accountId!, req.user!.id);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /calendar/google/sync
   */
  async syncGoogle(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await calendarService.syncWithGoogle(req.user!.accountId!, req.user!.id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /calendar/google/status
   */
  async getGoogleStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await calendarService.getGoogleStatus(req.user!.accountId!, req.user!.id);

      res.set('Cache-Control', 'no-store');
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const calendarController = new CalendarController();