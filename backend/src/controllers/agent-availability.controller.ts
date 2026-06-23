/**
 * AGENT AVAILABILITY CONTROLLER — T-022 Sprint 4 (Chat interno)
 *
 * Endpoints HTTP para presença de agentes (online | away | busy | offline).
 * Cada agente gerencia o próprio status; admins/super_admins também batem nos
 * mesmos endpoints (eles também são "agentes" presentes na UI do chat interno).
 *
 * Endpoints:
 *   - GET  /availability/me                — status do usuário autenticado
 *   - POST /availability/me      body:{status} — define manualmente o status
 *   - POST /availability/heartbeat         — keep-alive (mantém online)
 *   - GET  /availability/online            — lista agentes online da conta
 *
 * Singleton: `agentAvailabilityController`.
 */

import { Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  agentAvailabilityService,
  AvailabilityStatus,
} from '../services/agent-availability.service';
import { AuthenticatedRequest } from '../types';
import {
  ValidationError,
  ForbiddenError,
  UnauthorizedError,
  ErrorCodes,
} from '../utils/errors';

// ============================================
// Validação
// ============================================

const statusSchema = z.object({
  status: z.enum(['online', 'away', 'busy', 'offline']),
});

export class AgentAvailabilityController {
  /**
   * GET /availability/me
   * Retorna o status atual do usuário autenticado.
   */
  async getMe(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError();
      }

      const row = await agentAvailabilityService.getStatus(req.user.id);

      res.json({ data: row });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /availability/me  body: { status }
   * Define manualmente o status do usuário autenticado.
   */
  async setMe(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError();
      }

      const parsed = statusSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Status inválido', {
          issues: parsed.error.flatten(),
        });
      }

      const row = await agentAvailabilityService.setStatus(
        req.user.id,
        parsed.data.status as AvailabilityStatus
      );

      res.json({ data: row });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /availability/heartbeat
   * Atualiza `lastActiveAt` do usuário autenticado. Promove offline → online
   * automaticamente; preserva away/busy escolhidos pelo usuário.
   */
  async heartbeat(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError();
      }

      await agentAvailabilityService.heartbeat(req.user.id);

      res.json({ data: { ok: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /availability/online
   * Lista os agentes atualmente online da conta do usuário autenticado.
   * Super admin sem conta corrente recebe 403 (precisa estar em alguma conta).
   */
  async listOnline(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError();
      }

      if (!req.user.accountId) {
        throw new ForbiddenError(ErrorCodes.PERMISSION_DENIED);
      }

      const users = await agentAvailabilityService.listOnline(req.user.accountId);

      // Não vazar passwordHash / refreshToken / etc — devolve apenas campos públicos.
      const data = users.map((u: any) => ({
        id: u.id,
        nome: u.nome,
        email: u.email,
        role: u.role,
        avatarUrl: u.avatarUrl ?? null,
      }));

      res.json({ data });
    } catch (error) {
      next(error);
    }
  }
}

export const agentAvailabilityController = new AgentAvailabilityController();
