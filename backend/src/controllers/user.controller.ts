import { Response, NextFunction } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { userService } from '../services/user.service';
import { authService } from '../services/auth.service';
import { env } from '../config/env';
import { AuthenticatedRequest } from '../types';
import { getPaginationParams } from '../utils/helpers';

// Validation schemas
const createUserSchema = z.object({
  accountId: z.string().uuid().optional(),
  nome: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  email: z.string().email('Email inválido'),
  password: z.string().min(6, 'Senha deve ter pelo menos 6 caracteres'),
  role: z.enum(['super_admin', 'admin', 'agent']),
  permissions: z.array(z.string()).optional(),
  chatwootAgentId: z.number().optional(),
});

const updateUserSchema = z.object({
  nome: z.string().min(2).optional(),
  email: z.string().email().optional(),
  role: z.enum(['super_admin', 'admin', 'agent']).optional(),
  status: z.enum(['active', 'inactive', 'suspended']).optional(),
  permissions: z.array(z.string()).optional(),
  chatwootAgentId: z.number().optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Senha atual é obrigatória'),
  newPassword: z.string().min(6, 'Nova senha deve ter pelo menos 6 caracteres'),
});

const listUsersSchema = z.object({
  accountId: z.string().uuid().optional(),
  role: z.enum(['super_admin', 'admin', 'agent']).optional(),
  status: z.enum(['active', 'inactive', 'suspended']).optional(),
  search: z.string().optional(),
});

export class UserController {
  /**
   * GET /users
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters = listUsersSchema.parse(req.query);
      const pagination = getPaginationParams(req);

      // If not super_admin, force account filter
      if (req.user!.role !== 'super_admin') {
        filters.accountId = req.user!.accountId!;
      }

      const result = await userService.list(filters, pagination);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /users/:id
   */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await userService.getById(id);

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
   * POST /users
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createUserSchema.parse(req.body);

      // If not super_admin, force account
      if (req.user!.role !== 'super_admin') {
        body.accountId = req.user!.accountId!;
        // Non-super admins can't create super_admins
        if (body.role === 'super_admin') {
          res.status(403).json({
            error: { code: 'FORBIDDEN', message: 'Não é possível criar Super Admin' },
          });
          return;
        }
      }

      const result = await userService.create(body, req.user!.id);

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /users/:id
   */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = updateUserSchema.parse(req.body);

      // Check access
      const existing = await userService.getById(id);
      if (req.user!.role !== 'super_admin' && existing.accountId !== req.user!.accountId) {
        res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Acesso negado' },
        });
        return;
      }

      // Non-super admins can't update to super_admin
      if (req.user!.role !== 'super_admin' && body.role === 'super_admin') {
        res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Não é possível definir role Super Admin' },
        });
        return;
      }

      const result = await userService.update(id, body, req.user!.id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /users/:id
   */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;

      // Check access
      const existing = await userService.getById(id);
      if (req.user!.role !== 'super_admin' && existing.accountId !== req.user!.accountId) {
        res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Acesso negado' },
        });
        return;
      }

      // Can't delete self
      if (id === req.user!.id) {
        res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Não é possível excluir a si mesmo' },
        });
        return;
      }

      await userService.delete(id, req.user!.id);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /users/:id/password
   */
  async changePassword(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = changePasswordSchema.parse(req.body);

      // Can only change own password (unless super_admin)
      if (req.user!.role !== 'super_admin' && id !== req.user!.id) {
        res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Só é possível alterar a própria senha' },
        });
        return;
      }

      await userService.changePassword(id, body.currentPassword, body.newPassword);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /users/:id/impersonate
   */
  async impersonate(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;

      const result = await userService.impersonate(id, req.user!.id);

      // Generate a real JWT for the target user with their accountId
      const token = jwt.sign(
        {
          sub: result.user.id,
          email: result.user.email,
          role: result.user.role,
          accountId: result.user.accountId,
          permissions: result.user.permissions,
        },
        env.JWT_SECRET,
        { expiresIn: env.JWT_EXPIRES_IN as any }
      );

      res.json({
        data: {
          ...result,
          token,
          isImpersonating: true,
          originalUserId: req.user!.id,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const userController = new UserController();
