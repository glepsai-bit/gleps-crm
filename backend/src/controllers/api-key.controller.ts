import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { apiKeyService } from '../services/api-key.service';
import { AuthenticatedRequest } from '../types';
import { ValidationError, ForbiddenError, NotFoundError, ErrorCodes } from '../utils/errors';

// Validation schemas
// TODO(t022-future): scopes não implementado. Aceitamos o campo no body por
// compat com clientes antigos, mas é ignorado no service (sempre []).
// Ver comentário no apiKey.middleware.ts.
const generateApiKeySchema = z.object({
  name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
});

/**
 * Ensure the requester can act on the given accountId.
 * - super_admin: pode tudo
 * - admin: somente sobre a própria conta
 */
function assertCanAccessAccount(req: AuthenticatedRequest, accountId: string): void {
  if (!accountId) {
    throw new ValidationError('accountId é obrigatório');
  }

  const user = req.user;
  if (!user) {
    throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
  }

  if (user.role === 'super_admin') {
    return;
  }

  if (user.role === 'admin' && user.accountId === accountId) {
    return;
  }

  throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
}

export class ApiKeyController {
  /**
   * GET /api/api-keys/accounts/:accountId
   * Lista as API keys da conta (nunca retorna a chave em claro).
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.params.accountId as string;
      assertCanAccessAccount(req, accountId);

      const result = await apiKeyService.list(accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/api-keys/accounts/:accountId
   * Body: { name }
   * Retorna a chave em texto plano APENAS UMA VEZ.
   * TODO(t022-future): scopes removido do schema — ver apiKey.middleware.ts.
   */
  async generate(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.params.accountId as string;
      assertCanAccessAccount(req, accountId);

      const body = generateApiKeySchema.parse(req.body);

      // TODO(t022-future): scopes ignorado por hora (god-mode na accountId).
      const result = await apiKeyService.generate(
        accountId,
        body.name,
        req.user!.id,
        []
      );

      res.status(201).json({
        data: {
          id: result.id,
          name: result.name,
          plaintextKey: result.plaintextKey,
          prefix: result.prefix,
          createdAt: result.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/api-keys/:id?accountId=...
   * Revoga (soft-delete) a API key, sempre escopada por accountId.
   */
  async revoke(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      if (!id) {
        throw new ValidationError('id da API key é obrigatório');
      }

      const accountId = (req.query.accountId as string) || '';
      assertCanAccessAccount(req, accountId);

      const { count } = await apiKeyService.revoke(id, accountId);
      if (count === 0) {
        throw new NotFoundError('API key não encontrada nesta conta');
      }

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }
}

export const apiKeyController = new ApiKeyController();
