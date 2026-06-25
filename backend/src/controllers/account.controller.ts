import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { accountService } from '../services/account.service';
import { AuthenticatedRequest } from '../types';
import { getPaginationParams } from '../utils/helpers';

// Validation schemas
// Pré-trata strings vazias como undefined antes da validação de URL,
// já que z.string().url() rejeita "" mesmo em campos opcionais.
const optionalUrl = () =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().url().optional()
  );

const createAccountSchema = z.object({
  nome: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  plano: z.string().optional(),
  limiteUsuarios: z.number().min(1).max(1000).optional(),
  monthlyExtractionLimit: z.number().int().min(0).max(1000000).optional(),
  monthlyEmailLimit: z.number().int().min(0).max(10000000).optional(),
  dailyEmailLimit: z.number().int().min(0).max(10000000).optional(),
  timezone: z.string().optional(),
  evolutionBaseUrl: optionalUrl(),
  evolutionApiKey: z.string().optional(),
  evolutionInstance: z.string().optional(),
  // BUG-018: secret HMAC para validar webhooks da Evolution API.
  // Pré-tratamos string vazia como undefined para evitar gravar "" no banco.
  evolutionWebhookSecret: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(16, 'Secret deve ter ao menos 16 caracteres').max(500).optional()
  ),
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  googleRedirectUri: optionalUrl(),
});

const updateAccountSchema = createAccountSchema.partial().extend({
  status: z.enum(['active', 'paused', 'cancelled']).optional(),
  openaiApiKey: z.string().optional().nullable(),
  sendgridApiKey: z.string().optional().nullable(),
  sendgridFromEmail: z.string().email().optional().nullable(),
  sendgridFromName: z.string().optional().nullable(),
});

const listAccountsSchema = z.object({
  status: z.enum(['active', 'paused', 'cancelled']).optional(),
  search: z.string().optional(),
});

export class AccountController {
  /**
   * GET /accounts
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters = listAccountsSchema.parse(req.query);
      const pagination = getPaginationParams(req);

      const result = await accountService.list(filters, pagination);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /accounts/:id
   */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await accountService.getById(id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /accounts
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createAccountSchema.parse(req.body);
      const result = await accountService.create(body, req.user!.id);

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /accounts/:id
   */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = updateAccountSchema.parse(req.body);
      const result = await accountService.update(id, body, req.user!.id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /accounts/:id
   */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      await accountService.delete(id, req.user!.id);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /accounts/:id/pause
   */
  async pause(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const { reason } = req.body;
      const result = await accountService.pause(id, req.user!.id, reason);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /accounts/:id/activate
   */
  async activate(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await accountService.activate(id, req.user!.id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /accounts/:id/stats
   */
  async getStats(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await accountService.getStats(id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const accountController = new AccountController();
