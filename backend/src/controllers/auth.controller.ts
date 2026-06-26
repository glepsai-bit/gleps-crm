import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authService } from '../services/auth.service';
import { AuthenticatedRequest } from '../types';

// Validation schemas
// T1-LOGIN-MAX: limite explicito de tamanho para evitar payload abusivo
// (ex.: email de 1MB passando pelo z.string().email() sem .max()).
const loginSchema = z.object({
  email: z.string().email('Email inválido').max(254, 'Email muito longo'),
  password: z
    .string()
    .min(6, 'Senha deve ter pelo menos 6 caracteres')
    .max(128, 'Senha muito longa'),
});

const refreshSchema = z.object({
  refreshToken: z.string().uuid('Token inválido'),
});

const verifyPasswordSchema = z.object({
  password: z
    .string()
    .min(1, 'Senha é obrigatória')
    .max(128, 'Senha muito longa'),
});

export class AuthController {
  /**
   * POST /auth/login
   */
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = loginSchema.parse(req.body);
      const ip = req.ip;
      const userAgent = req.get('user-agent');

      const result = await authService.login(body, ip, userAgent);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /auth/logout
   */
  async logout(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const refreshToken = req.body.refreshToken;
      await authService.logout(req.user!.id, refreshToken);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /auth/refresh
   */
  async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = refreshSchema.parse(req.body);
      const result = await authService.refresh(body.refreshToken);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /auth/me
   */
  async me(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.getMe(req.user!.id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /auth/verify-password
   */
  async verifyPassword(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = verifyPasswordSchema.parse(req.body);
      const valid = await authService.verifyPassword(req.user!.id, body.password);

      res.json({ data: { valid } });
    } catch (error) {
      next(error);
    }
  }
}

export const authController = new AuthController();
