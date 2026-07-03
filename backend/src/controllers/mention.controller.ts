import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { AuthenticatedRequest } from '../types';
import { UnauthorizedError, ValidationError } from '../utils/errors';

// ============================================
// GET /api/mentions
// ============================================
// T-022 Sprint 4 pareado: complementa o emit socket `mention:new` — permite
// hidratar o array de mentions no mount do AdminLayout (menu do sino) sem
// depender do socket já estar conectado.
//
// Escopo: só mentions do req.user, dentro da conta ativa. `read` é opcional
// como filtro (default: apenas não-lidas). Include mínimo de conversation
// + contact.nome pra UI mostrar "Fulano te mencionou em conversa com X".

const listMentionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  read: z.enum(['true', 'false', 'all']).optional(),
});

export class MentionController {
  async list(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError();
      const accountId = req.user.accountId;
      if (!accountId) throw new ValidationError('accountId obrigatório');

      const parsed = listMentionsQuerySchema.parse(req.query);
      const limit = parsed.limit ?? 20;

      const where: any = {
        userId: req.user.id,
        conversation: { accountId },
      };

      // Default: apenas não-lidas (comportamento clássico de sino de mentions).
      // ?read=all traz tudo; ?read=true traz só lidas.
      const readFilter = parsed.read ?? 'false';
      if (readFilter === 'true') {
        where.read = true;
      } else if (readFilter === 'false') {
        where.read = false;
      }

      const data = await prisma.mention.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          conversation: {
            select: {
              id: true,
              contact: { select: { id: true, nome: true, telefone: true } },
            },
          },
        },
      });

      res.json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/mentions/:id/read — marca mention como lida.
   * Escopado por userId + accountId pra evitar cross-tenant.
   */
  async markRead(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      if (!req.user) throw new UnauthorizedError();
      const accountId = req.user.accountId;
      if (!accountId) throw new ValidationError('accountId obrigatório');

      const id = req.params.id as string;

      const result = await prisma.mention.updateMany({
        where: {
          id,
          userId: req.user.id,
          conversation: { accountId },
        },
        data: { read: true },
      });

      res.json({ data: { updated: result.count } });
    } catch (error) {
      next(error);
    }
  }
}

export const mentionController = new MentionController();
