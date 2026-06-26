import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { calendarService } from '../services/calendar.service';
import { AuthenticatedRequest } from '../types';
import { getPaginationParams } from '../utils/helpers';

// Validation schemas
// T2-AGENDA-VALIDACAO: rejeita endTime <= startTime e eventos no passado
// (a) endTime < startTime
// (b) endTime == startTime (duracao zero)
// (c) startTime no passado
// Overlapping detection no mesmo agente fica como follow-up (precisa query).
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
  // Flag opcional: permite registrar evento historico/manual no passado
  allowPast: z.boolean().optional(),
}).superRefine((data, ctx) => {
  const start = new Date(data.startTime);
  const end = new Date(data.endTime);
  if (end <= start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'endTime deve ser maior que startTime',
      path: ['endTime'],
    });
  }
  if (!data.allowPast && start.getTime() < Date.now()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Evento deve ser futuro (use allowPast=true para registros historicos)',
      path: ['startTime'],
    });
  }
});

// Para o update, replicamos as validacoes apenas quando ambos os campos estao
// presentes (Partial pode ter so um). Eventos ja existentes podem estar no
// passado, entao nao validamos startTime contra Date.now() no update.
const updateEventSchema = z.object({
  title: z.string().min(1, 'Título é obrigatório').optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  type: z.enum(['meeting', 'appointment', 'block', 'other']).optional(),
  location: z.string().optional(),
  meetingLink: z.string().url().optional(),
  contactId: z.string().uuid().optional(),
  notes: z.string().optional(),
  attendees: z.array(z.object({
    name: z.string(),
    email: z.string().email(),
  })).optional(),
  allowPast: z.boolean().optional(),
  status: z.enum(['scheduled', 'cancelled', 'completed']).optional(),
}).superRefine((data, ctx) => {
  if (data.startTime && data.endTime) {
    const start = new Date(data.startTime);
    const end = new Date(data.endTime);
    if (end <= start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endTime deve ser maior que startTime',
        path: ['endTime'],
      });
    }
  }
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

/**
 * T1-GOOGLE-REDIRECT (security fix):
 * /calendar/google/callback previously used res.redirect com origin derivado de
 * headers controlados pelo cliente (x-forwarded-host, origin, host), permitindo
 * open redirect via header forjado. Solucao: tudo passa por uma allowlist
 * estatica de hosts. Qualquer host fora da lista cai no FRONTEND_URL seguro.
 *
 * Para adicionar dominios de producao, definir env FRONTEND_URL e/ou
 * FRONTEND_ALLOWED_HOSTS (CSV de host[:port]).
 */
function buildAllowedHostSet(): Set<string> {
  const hosts = new Set<string>();
  const addHostFromUrl = (raw: string | undefined): void => {
    if (!raw) return;
    try {
      const url = new URL(raw);
      hosts.add(url.host.toLowerCase());
    } catch {
      // fallback: tratar como host bruto
      hosts.add(raw.trim().toLowerCase());
    }
  };
  addHostFromUrl(process.env.FRONTEND_URL);
  addHostFromUrl(process.env.FRONTEND_ORIGIN);
  // dev locais
  hosts.add('localhost:8080');
  hosts.add('localhost:8081');
  hosts.add('127.0.0.1:8080');
  hosts.add('127.0.0.1:8081');
  // extra CSV
  const extra = (process.env.FRONTEND_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  for (const h of extra) hosts.add(h);
  return hosts;
}

const ALLOWED_REDIRECT_HOSTS = buildAllowedHostSet();

function getSafeFrontendUrl(): string {
  return (process.env.FRONTEND_URL || process.env.FRONTEND_ORIGIN || 'http://localhost:8080').replace(/\/$/, '');
}

function isAllowedHost(host: string | undefined | null): boolean {
  if (!host) return false;
  return ALLOWED_REDIRECT_HOSTS.has(host.toLowerCase());
}

function getRequestOrigin(req: Request): string {
  const safeFallback = getSafeFrontendUrl();

  const originHeader = req.get('origin')?.trim();
  if (originHeader) {
    try {
      const url = new URL(originHeader);
      if (isAllowedHost(url.host)) return originHeader.replace(/\/$/, '');
    } catch {
      // origin invalido — segue fluxo de fallback
    }
  }

  const proto = readForwardedHeader(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  const host = readForwardedHeader(req.headers['x-forwarded-host']) || req.get('host') || '';

  if (isAllowedHost(host)) {
    return `${proto}://${host}`.replace(/\/$/, '');
  }

  // host nao reconhecido — usar fallback seguro (FRONTEND_URL)
  return safeFallback;
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
      // allowPast eh uma flag de validacao e nao deve ser persistida pelo service.
      const { allowPast: _allowPast, ...payload } = body;
      const result = await calendarService.create({
        ...payload,
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
      const { allowPast: _allowPast, ...payload } = body;
      const result = await calendarService.update(id, {
        ...payload,
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

      // T1-GOOGLE-REDIRECT: result.origin foi salvo no state OAuth a partir de
      // headers controlados pelo cliente — precisa passar pela allowlist tambem.
      let frontendUrl = fallbackFrontendUrl;
      if (result.origin) {
        try {
          const candidate = new URL(result.origin);
          if (isAllowedHost(candidate.host)) {
            frontendUrl = result.origin.replace(/\/$/, '');
          }
        } catch {
          // origin invalido — manter fallback
        }
      }

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