import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { userService } from '../services/user.service';
import { AuthenticatedRequest } from '../types';
import { getPaginationParams } from '../utils/helpers';
import { ForbiddenError, ValidationError, ErrorCodes } from '../utils/errors';

/**
 * T-024 — Controller dedicado ao Admin de conta gerenciar agentes/admins
 * da PROPRIA tenancy. Todas as queries forcam req.user.accountId.
 *
 * Nao reutiliza UserController (que serve super_admin via /api/users) para
 * isolar regras de seguranca multi-tenant em um unico ponto.
 */

// Zod: enum SEM 'super_admin' — admin nao consegue criar/promover super.
const manageableRole = z.enum(['agent', 'admin']);

const createUserSchema = z.object({
  nome: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  email: z.string().email('Email inválido'),
  password: z.string().min(6, 'Senha deve ter pelo menos 6 caracteres'),
  role: manageableRole,
  permissions: z.array(z.string()).optional(),
});

const updateUserSchema = z.object({
  nome: z.string().min(2).optional(),
  email: z.string().email().optional(),
  role: manageableRole.optional(),
  status: z.enum(['active', 'inactive', 'suspended']).optional(),
  permissions: z.array(z.string()).optional(),
  // Reset de senha pelo admin da conta (Editar Agente). Sem o campo, o Zod
  // descartava a senha nova e ela nunca era aplicada.
  password: z.string().min(6, 'Senha deve ter pelo menos 6 caracteres').optional(),
});

const listUsersSchema = z.object({
  role: z.enum(['agent', 'admin']).optional(),
  status: z.enum(['active', 'inactive', 'suspended']).optional(),
  search: z.string().optional(),
});

class AdminUserController {
  /**
   * GET /api/admin/users
   * Lista agentes/admins da propria conta. Nunca retorna super_admin.
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters = listUsersSchema.parse(req.query);
      const pagination = getPaginationParams(req);
      const accountId = req.user!.accountId!;

      const result = await userService.listAdminScoped(accountId, filters, pagination);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/admin/users/limits
   */
  async getLimits(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const data = await userService.getAgentLimits(accountId);
      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/admin/users/:id
   * (middleware requireSameAccountUser ja validou o accountId)
   */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await userService.getById(id);

      // Nunca expor super_admin via essa rota
      if (result.role === 'super_admin') {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Usuário não encontrado' },
        });
        return;
      }

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/admin/users
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createUserSchema.parse(req.body);
      const requester = req.user!;
      const accountId = requester.accountId!;

      // Admin NAO super pode criar OUTRO admin? Plano diz: nao.
      if (body.role === 'admin' && requester.role !== 'super_admin') {
        throw new ForbiddenError(ErrorCodes.CANNOT_MANAGE_OTHER_ADMIN);
      }

      const result = await userService.createScoped(
        accountId,
        {
          nome: body.nome,
          email: body.email,
          password: body.password,
          role: body.role,
          permissions: body.permissions,
        },
        requester.id
      );

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/admin/users/:id
   * (middleware requireSameAccountUser ja garantiu target.accountId === requester.accountId)
   */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = updateUserSchema.parse(req.body);
      const requester = req.user!;
      const accountId = requester.accountId!;

      const existing = await userService.getById(id);

      // Defesa em profundidade
      if (existing.role === 'super_admin') {
        throw new ForbiddenError(ErrorCodes.CANNOT_MANAGE_SUPER_ADMIN);
      }
      if (existing.accountId !== accountId) {
        // Nunca deveria chegar aqui (middleware), mas mantemos a barreira
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Usuário não encontrado' } });
        return;
      }

      // Bloqueia admin nao-super alterando OUTRO admin
      if (
        existing.role === 'admin' &&
        existing.id !== requester.id &&
        requester.role !== 'super_admin'
      ) {
        throw new ForbiddenError(ErrorCodes.CANNOT_MANAGE_OTHER_ADMIN);
      }

      // Bloqueia self-demote: admin nao pode rebaixar a si mesmo
      if (existing.id === requester.id && body.role && body.role !== existing.role) {
        throw new ForbiddenError('Não é possível alterar a própria role');
      }

      // Bloqueia self-suspend/inactive
      if (
        existing.id === requester.id &&
        body.status &&
        body.status !== 'active'
      ) {
        res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Não é possível suspender/desativar a própria conta' },
        });
        return;
      }

      // Bloqueia "promover para admin" feito por admin nao-super
      if (body.role === 'admin' && existing.role !== 'admin' && requester.role !== 'super_admin') {
        throw new ForbiddenError(ErrorCodes.CANNOT_MANAGE_OTHER_ADMIN);
      }

      // Bloqueia "rebaixar admin para agent" quando isso esvaziaria a conta
      if (
        existing.role === 'admin' &&
        body.role === 'agent'
      ) {
        const activeAdmins = await userService.countActiveAdminsInAccount(accountId);
        if (activeAdmins <= 1) {
          throw new ValidationError(ErrorCodes.CANNOT_REMOVE_LAST_ADMIN);
        }
      }

      const result = await userService.updateScoped(id, accountId, body, requester.id);
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/admin/users/:id
   * (verifyPassword middleware ja confirmou senha do requester)
   */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const requester = req.user!;
      const accountId = requester.accountId!;

      if (id === requester.id) {
        res.status(400).json({
          error: { code: 'CANNOT_DELETE_SELF', message: ErrorCodes.CANNOT_DELETE_SELF },
        });
        return;
      }

      const existing = await userService.getById(id);

      if (existing.role === 'super_admin') {
        throw new ForbiddenError(ErrorCodes.CANNOT_MANAGE_SUPER_ADMIN);
      }
      if (existing.accountId !== accountId) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Usuário não encontrado' } });
        return;
      }
      if (existing.role === 'admin' && requester.role !== 'super_admin') {
        throw new ForbiddenError(ErrorCodes.CANNOT_MANAGE_OTHER_ADMIN);
      }

      // Bloqueia delete do ultimo admin da conta
      if (existing.role === 'admin') {
        const activeAdmins = await userService.countActiveAdminsInAccount(accountId);
        if (activeAdmins <= 1) {
          throw new ValidationError(ErrorCodes.CANNOT_REMOVE_LAST_ADMIN);
        }
      }

      await userService.delete(id, requester.id);
      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }
}

export const adminUserController = new AdminUserController();
