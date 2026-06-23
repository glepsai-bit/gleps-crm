import { Team, TeamMember, User } from '@prisma/client';
import { prisma } from '../config/database';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export interface CreateTeamInput {
  name: string;
  description?: string;
  allowAutoAssign?: boolean;
  businessHours?: any;
}

export type UpdateTeamInput = Partial<CreateTeamInput>;

export type TeamWithMembers = Team & { members: TeamMember[] };

class TeamService {
  // ============================================
  // Helpers
  // ============================================

  /**
   * Ensure a team belongs to the given account, returning it with members.
   * Throws NotFoundError otherwise.
   */
  private async ensureTeam(id: string, accountId: string): Promise<TeamWithMembers> {
    const team = await prisma.team.findFirst({
      where: { id, accountId },
      include: { members: true },
    });

    if (!team) {
      throw new NotFoundError('Time');
    }

    return team;
  }

  // ============================================
  // CRUD
  // ============================================

  /**
   * List all teams of an account with their members.
   */
  async list(accountId: string): Promise<TeamWithMembers[]> {
    return prisma.team.findMany({
      where: { accountId },
      orderBy: { name: 'asc' },
      include: { members: true },
    });
  }

  /**
   * Get a single team scoped by account.
   */
  async get(id: string, accountId: string): Promise<TeamWithMembers> {
    return this.ensureTeam(id, accountId);
  }

  /**
   * Create a new team for an account.
   * `name` must be unique per account (enforced by @@unique([accountId, name])).
   */
  async create(accountId: string, input: CreateTeamInput): Promise<Team> {
    const name = (input.name || '').trim();

    if (!name) {
      throw new ValidationError('name é obrigatório');
    }

    const existing = await prisma.team.findFirst({
      where: { accountId, name },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictError('Já existe um time com este nome nesta conta');
    }

    const team = await prisma.team.create({
      data: {
        accountId,
        name,
        description: input.description ?? null,
        allowAutoAssign: input.allowAutoAssign ?? true,
        businessHours: input.businessHours ?? undefined,
      },
    });

    logger.info('Team created', { accountId, teamId: team.id, name });

    return team;
  }

  /**
   * Partially update a team. `name`, when provided, must remain unique per account.
   */
  async update(id: string, accountId: string, partial: UpdateTeamInput): Promise<Team> {
    await this.ensureTeam(id, accountId);

    const data: Record<string, unknown> = {};

    if (partial.name !== undefined) {
      const name = (partial.name || '').trim();
      if (!name) {
        throw new ValidationError('name não pode ser vazio');
      }

      const clash = await prisma.team.findFirst({
        where: { accountId, name, NOT: { id } },
        select: { id: true },
      });

      if (clash) {
        throw new ConflictError('Já existe um time com este nome nesta conta');
      }

      data.name = name;
    }

    if (partial.description !== undefined) {
      data.description = partial.description;
    }

    if (partial.allowAutoAssign !== undefined) {
      data.allowAutoAssign = partial.allowAutoAssign;
    }

    if (partial.businessHours !== undefined) {
      data.businessHours = partial.businessHours;
    }

    const team = await prisma.team.update({
      where: { id },
      data,
    });

    logger.info('Team updated', { accountId, teamId: id, fields: Object.keys(data) });

    return team;
  }

  /**
   * Delete a team. Members cascade via FK; relations on Inbox/Conversation/SLAPolicy
   * use SetNull, so nothing else needs cleanup here.
   */
  async delete(id: string, accountId: string): Promise<void> {
    await this.ensureTeam(id, accountId);

    await prisma.team.delete({ where: { id } });

    logger.info('Team deleted', { accountId, teamId: id });
  }

  // ============================================
  // Membership
  // ============================================

  /**
   * Add a user as a team member. `role` defaults to "member" (alt: "leader").
   * The user must belong to the same account as the team.
   * If the user is already a member, returns the existing record.
   */
  async addMember(
    teamId: string,
    accountId: string,
    userId: string,
    role: string = 'member'
  ): Promise<TeamMember> {
    await this.ensureTeam(teamId, accountId);

    const user = await prisma.user.findFirst({
      where: { id: userId, accountId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundError('Usuário');
    }

    const normalizedRole = role === 'leader' ? 'leader' : 'member';

    const existing = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });

    if (existing) {
      // Keep the call idempotent; update role if it changed.
      if (existing.role !== normalizedRole) {
        return prisma.teamMember.update({
          where: { id: existing.id },
          data: { role: normalizedRole },
        });
      }
      return existing;
    }

    const member = await prisma.teamMember.create({
      data: { teamId, userId, role: normalizedRole },
    });

    logger.info('Team member added', { accountId, teamId, userId, role: normalizedRole });

    return member;
  }

  /**
   * Remove a user from a team. No-op (silent) if the user is not a member.
   */
  async removeMember(teamId: string, accountId: string, userId: string): Promise<void> {
    await this.ensureTeam(teamId, accountId);

    const existing = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { id: true },
    });

    if (!existing) {
      return;
    }

    await prisma.teamMember.delete({ where: { id: existing.id } });

    logger.info('Team member removed', { accountId, teamId, userId });
  }

  /**
   * List all teams a given user is a member of, scoped by account.
   */
  async listTeamsByUser(userId: string, accountId: string): Promise<Team[]> {
    const memberships = await prisma.teamMember.findMany({
      where: {
        userId,
        team: { accountId },
      },
      include: { team: true },
      orderBy: { team: { name: 'asc' } },
    });

    return memberships.map(m => m.team);
  }

  // ============================================
  // Round-robin assignment
  // ============================================

  /**
   * Pick the next active assignee for a team using round-robin.
   *
   * Strategy:
   *  - Look at the most recent conversation that was assigned to a user of this team
   *    (Conversation.teamId + assigneeId, ordered by updatedAt desc).
   *  - Find that user's position in the (deterministically-ordered) active member list
   *    and return the next one. If no prior assignment exists, return the first member.
   *  - Only active members (User.status === 'active') are eligible.
   *  - Returns null if the team has no active members.
   */
  async pickAssignee(teamId: string, accountId: string): Promise<User | null> {
    await this.ensureTeam(teamId, accountId);

    // Fetch members with their user, filter to active, sort deterministically by
    // membership createdAt — gives a stable rotation order independent of insertion noise.
    const memberships = await prisma.teamMember.findMany({
      where: { teamId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });

    const activeMembers = memberships
      .map(m => m.user)
      .filter(u => u && u.status === 'active' && u.accountId === accountId);

    if (activeMembers.length === 0) {
      return null;
    }

    // Find the most recent conversation assigned via this team to a current member.
    const memberIds = activeMembers.map(u => u.id);
    const lastAssignment = await prisma.conversation.findFirst({
      where: {
        accountId,
        teamId,
        assigneeId: { in: memberIds },
      },
      orderBy: { updatedAt: 'desc' },
      select: { assigneeId: true },
    });

    if (!lastAssignment?.assigneeId) {
      return activeMembers[0];
    }

    const lastIndex = activeMembers.findIndex(u => u.id === lastAssignment.assigneeId);

    // If the last assignee is no longer in the active list, start from the top.
    if (lastIndex === -1) {
      return activeMembers[0];
    }

    const nextIndex = (lastIndex + 1) % activeMembers.length;
    return activeMembers[nextIndex];
  }
}

export const teamService = new TeamService();
