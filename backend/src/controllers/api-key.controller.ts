import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { apiKeyService } from '../services/api-key.service';
import { AuthenticatedRequest } from '../types';
import { ValidationError, ForbiddenError, ErrorCodes } from '../utils/errors';

// Validation schemas
const generateApiKeySchema = z.object({
  name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  scopes: z.array(z.string()).optional(),
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
   * Body: { name, scopes? }
   * Retorna a chave em texto plano APENAS UMA VEZ.
   */
  async generate(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.params.accountId as string;
      assertCanAccessAccount(req, accountId);

      const body = generateApiKeySchema.parse(req.body);

      const result = await apiKeyService.generate(
        accountId,
        body.name,
        req.user!.id,
        body.scopes ?? []
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

      await apiKeyService.revoke(id, accountId);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }
}

export const apiKeyController = new ApiKeyController();
