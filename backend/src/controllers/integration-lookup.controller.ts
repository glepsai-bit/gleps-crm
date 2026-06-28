import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { UnauthorizedError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

/* ============================================================================
 * INTEGRATION LOOKUP (T-LOOKUP-API)
 *
 * Endpoints externos (API key) de DISCOVERY — agentes IA / n8n precisam
 * saber QUEM (users) e ONDE (teams) podem atribuir uma conversa antes de
 * chamar /chat/:id/assign ou /chat/:id/assign-team.
 *
 * Endpoints:
 *   GET /api/integrations/teams
 *     scope: chat:read | chat:write | *
 *     Retorna [{ id, name, slug, agentsCount }] da accountId.
 *     Não há `slug` real no schema (Team só tem `name`); slug é derivado
 *     do name (slugify) pra simetria com os outros endpoints de discovery
 *     (stages, contatos, etc) e estabilidade de cliente.
 *
 *   GET /api/integrations/users?role=agent&teamId=&available=
 *     scope: chat:read | chat:write | *
 *     Query opcionais:
 *       - role: 'agent' | 'admin' — filtra por papel
 *       - teamId: UUID — só users membros desse time
 *       - available: 'true' — só users com AgentAvailability.status='online'
 *     Retorna [{ id, nome, email, role, teamIds, status, lastSeenAt }]
 *     NUNCA retorna passwordHash, refreshTokens ou qualquer campo sensível.
 *
 * Compatibilidade scopes:
 *   chat:read é o scope canônico (discovery faz sentido pra qualquer chave
 *   que opere o chat). Aceitamos chat:write como super-set e '*' (god-mode).
 * ========================================================================= */

function requireAccountId(req: Request): string {
  const accountId = req.accountId;
  if (!accountId) {
    throw new UnauthorizedError('API key inválida ou revogada');
  }
  return accountId;
}

/**
 * Slug determinístico a partir de um nome livre. Mantém apenas a-z0-9 e '-'.
 * Usado pra dar aos clientes externos um identificador estável além do UUID
 * (compatível com o padrão dos outros endpoints de lookup, ex: stages).
 */
function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

const listUsersQuerySchema = z.object({
  role: z.enum(['agent', 'admin']).optional(),
  teamId: z.string().uuid({ message: 'teamId deve ser um UUID válido' }).optional(),
  available: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined)),
});

class IntegrationLookupController {
  /**
   * GET /api/integrations/teams
   *
   * Lista todos os times da conta + contagem de membros. Útil pro agente
   * IA descobrir os teamIds que pode passar pra /chat/:id/assign-team.
   */
  async listTeams(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);

      const teams = await prisma.team.findMany({
        where: { accountId },
        orderBy: [{ name: 'asc' }],
        select: {
          id: true,
          name: true,
          _count: { select: { members: true } },
        },
      });

      const data = teams.map((t) => ({
        id: t.id,
        name: t.name,
        slug: slugify(t.name),
        agentsCount: t._count.members,
      }));

      logger.info('[integration-lookup] list teams', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        count: data.length,
      });

      res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/integrations/users?role=&teamId=&available=
   *
   * Lista usuários da conta com filtros opcionais. SEMPRE retorna apenas
   * campos não-sensíveis (id, nome, email, role, teamIds, status,
   * lastSeenAt). passwordHash, refreshTokens, permissions, etc. ficam fora.
   */
  async listUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = requireAccountId(req);

      const parsed = listUsersQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError('Query inválida', { issues: parsed.error.issues });
      }
      const { role, teamId, available } = parsed.data;

      // Validamos teamId pertence à conta para não dar pista sobre IDs
      // de outras contas (cross-tenant guard antes do where).
      if (teamId) {
        const team = await prisma.team.findFirst({
          where: { id: teamId, accountId },
          select: { id: true },
        });
        if (!team) {
          // Time não encontrado nesta conta: devolve lista vazia
          // (não 404 — é um filtro, não um GET direto).
          res.status(200).json({ data: [] });
          return;
        }
      }

      const where: Record<string, unknown> = {
        accountId,
        status: 'active', // só usuários ativos importam pra atribuição
      };
      if (role) {
        where.role = role;
      }
      if (teamId) {
        where.teamMemberships = { some: { teamId } };
      }
      if (available) {
        where.availability = { is: { status: 'online' } };
      }

      const users = await prisma.user.findMany({
        where,
        orderBy: [{ nome: 'asc' }],
        select: {
          id: true,
          nome: true,
          email: true,
          role: true,
          teamMemberships: { select: { teamId: true } },
          availability: {
            select: { status: true, lastActiveAt: true },
          },
        },
      });

      const data = users.map((u) => ({
        id: u.id,
        nome: u.nome,
        email: u.email,
        role: u.role,
        teamIds: u.teamMemberships.map((m) => m.teamId),
        status: u.availability?.status ?? 'offline',
        lastSeenAt: u.availability?.lastActiveAt?.toISOString() ?? null,
      }));

      logger.info('[integration-lookup] list users', {
        accountId,
        apiKeyId: req.apiKey?.id ?? null,
        filters: { role: role ?? null, teamId: teamId ?? null, available: available ?? null },
        count: data.length,
      });

      res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  }
}

export const integrationLookupController = new IntegrationLookupController();
