import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { teamService } from '../services/team.service';
import { prisma } from '../config/database';
import { AuthenticatedRequest } from '../types';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';

// ============================================
// Validation schemas
// ============================================

const createTeamSchema = z.object({
  name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  description: z.string().optional(),
  allowAutoAssign: z.boolean().optional(),
  businessHours: z.any().optional(),
});

const updateTeamSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.preprocess((v) => (v === null ? undefined : v), z.string().optional()),
  allowAutoAssign: z.boolean().optional(),
  businessHours: z.any().optional(),
});

const addMemberSchema = z.object({
  userId: z.string().uuid('userId inválido'),
  role: z.enum(['member', 'leader']).optional(),
});

// ============================================
// Helper: admin OR leader of the team
// ============================================

/**
 * Allow the action if the user is admin/super_admin OR is a leader of the
 * referenced team. Throws ForbiddenError otherwise.
 */
export async function ensureAdminOrTeamLeader(
  req: AuthenticatedRequest,
  teamId: string
): Promise<void> {
  if (!req.user) {
    throw new UnauthorizedError();
  }

  if (['super_admin', 'admin'].includes(req.user.role)) {
    return;
  }

  if (!req.user.accountId) {
    throw new ForbiddenError();
  }

  // Make sure the team belongs to the user's account before checking membership.
  const team = await prisma.team.findFirst({
    where: { id: teamId, accountId: req.user.accountId },
    select: { id: true },
  });

  if (!team) {
    throw new ForbiddenError();
  }

  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: req.user.id } },
    select: { role: true },
  });

  if (!membership || membership.role !== 'leader') {
    throw new ForbiddenError();
  }
}

// ============================================
// Controller
// ============================================

export class TeamController {
  /**
   * GET /teams
   * List all teams of the authenticated user's account.
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await teamService.list(req.user!.accountId!);
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /teams/:id
   */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await teamService.get(id, req.user!.accountId!);
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /teams
   * Admin only.
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createTeamSchema.parse(req.body);
      const result = await teamService.create(req.user!.accountId!, body);
      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /teams/:id
   * Admin only.
   */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = updateTeamSchema.parse(req.body);
      const result = await teamService.update(id, req.user!.accountId!, body);
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /teams/:id
   * Admin only.
   */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      await teamService.delete(id, req.user!.accountId!);
      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // Membership
  // ============================================

  /**
   * POST /teams/:id/members
   * Body: { userId, role? }
   * Allowed: admin OR leader of the team.
   */
  async addMember(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const teamId = req.params.id as string;
      await ensureAdminOrTeamLeader(req, teamId);

      const body = addMemberSchema.parse(req.body);
      const result = await teamService.addMember(
        teamId,
        req.user!.accountId!,
        body.userId,
        body.role
      );

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /teams/:id/members/:userId
   * Allowed: admin OR leader of the team.
   */
  async removeMember(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const teamId = req.params.id as string;
      const userId = req.params.userId as string;

      await ensureAdminOrTeamLeader(req, teamId);
      await teamService.removeMember(teamId, req.user!.accountId!, userId);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /teams/by-user/me
   * List teams the logged-in user is a member of.
   */
  async listByMe(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await teamService.listTeamsByUser(req.user!.id, req.user!.accountId!);
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const teamController = new TeamController();
