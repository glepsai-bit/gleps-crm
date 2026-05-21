import { prisma } from '../config/database';
import { UserRole, UserStatus } from '@prisma/client';
import { PaginationParams } from '../types';
import { NotFoundError, ConflictError, ValidationError, ErrorCodes } from '../utils/errors';
import { getPaginationMeta } from '../utils/helpers';
import { authService } from './auth.service';
import { eventService } from './event.service';

export interface CreateUserInput {
  accountId?: string;
  nome: string;
  email: string;
  password: string;
  role: UserRole;
  permissions?: string[];
  chatwootAgentId?: number;
}

export interface UpdateUserInput {
  nome?: string;
  email?: string;
  role?: UserRole;
  status?: UserStatus;
  permissions?: string[];
  chatwootAgentId?: number;
}

export interface UserFilters {
  accountId?: string;
  role?: UserRole;
  status?: UserStatus;
  search?: string;
}

class UserService {
  /**
   * List users with filters
   */
  async list(filters: UserFilters, pagination: PaginationParams) {
    const where: any = {};

    if (filters.accountId) {
      where.accountId = filters.accountId;
    }

    if (filters.role) {
      where.role = filters.role;
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.search) {
      where.OR = [
        { nome: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.offset,
        take: pagination.limit,
        select: {
          id: true,
          accountId: true,
          nome: true,
          email: true,
          role: true,
          status: true,
          permissions: true,
          chatwootAgentId: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
          account: {
            select: {
              id: true,
              nome: true,
              status: true,
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    return {
      data: users,
      meta: getPaginationMeta(total, pagination),
    };
  }

  /**
   * Get user by ID
   */
  async getById(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        accountId: true,
        nome: true,
        email: true,
        role: true,
        status: true,
        permissions: true,
        chatwootAgentId: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        account: {
          select: {
            id: true,
            nome: true,
            status: true,
            timezone: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundError('Usuário');
    }

    return user;
  }

  /**
   * Create a new user
   */
  async create(input: CreateUserInput, createdById?: string) {
    // Check if email is already in use
    const existingUser = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
    });

    if (existingUser) {
      throw new ConflictError(ErrorCodes.EMAIL_IN_USE, { email: input.email });
    }

    // Check account user limit if not super_admin
    if (input.role !== 'super_admin' && input.accountId) {
      const account = await prisma.account.findUnique({
        where: { id: input.accountId },
        include: { _count: { select: { users: true } } },
      });

      if (!account) {
        throw new NotFoundError('Conta');
      }

      if (account._count.users >= account.limiteUsuarios) {
        throw new ValidationError(ErrorCodes.USER_LIMIT_EXCEEDED);
      }
    }

    // Hash password
    const passwordHash = await authService.hashPassword(input.password);

    // Ensure dashboard permission for agents
    let permissions = input.permissions || ['dashboard'];
    if (input.role === 'agent' && !permissions.includes('dashboard')) {
      permissions = ['dashboard', ...permissions];
    }

    const user = await prisma.user.create({
      data: {
        accountId: input.role === 'super_admin' ? null : input.accountId,
        nome: input.nome,
        email: input.email.toLowerCase(),
        passwordHash,
        role: input.role,
        permissions,
        chatwootAgentId: input.chatwootAgentId,
      },
      select: {
        id: true,
        accountId: true,
        nome: true,
        email: true,
        role: true,
        status: true,
        permissions: true,
        chatwootAgentId: true,
        createdAt: true,
      },
    });

    await eventService.create({
      eventType: 'user.created',
      accountId: user.accountId,
      actorType: createdById ? 'user' : 'system',
      actorId: createdById,
      entityType: 'user',
      entityId: user.id,
      payload: { email: user.email, role: user.role },
    });

    return user;
  }

  /**
   * Update a user
   */
  async update(id: string, input: UpdateUserInput, updatedById?: string) {
    const existing = await this.getById(id);

    // Check if email is being changed and is already in use
    if (input.email && input.email.toLowerCase() !== existing.email) {
      const emailInUse = await prisma.user.findUnique({
        where: { email: input.email.toLowerCase() },
      });

      if (emailInUse) {
        throw new ConflictError(ErrorCodes.EMAIL_IN_USE, { email: input.email });
      }
    }

    // Ensure dashboard permission for agents
    let permissions = input.permissions;
    if (permissions && (input.role === 'agent' || existing.role === 'agent')) {
      if (!permissions.includes('dashboard')) {
        permissions = ['dashboard', ...permissions];
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        nome: input.nome,
        email: input.email?.toLowerCase(),
        role: input.role,
        status: input.status,
        permissions,
        chatwootAgentId: input.chatwootAgentId,
      },
      select: {
        id: true,
        accountId: true,
        nome: true,
        email: true,
        role: true,
        status: true,
        permissions: true,
        chatwootAgentId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Log suspend event if status changed to suspended
    if (input.status === 'suspended' && existing.status !== 'suspended') {
      await eventService.create({
        eventType: 'user.suspended',
        accountId: user.accountId,
        actorType: 'user',
        actorId: updatedById,
        entityType: 'user',
        entityId: user.id,
        payload: { email: user.email },
      });
    } else {
      await eventService.create({
        eventType: 'user.updated',
        accountId: user.accountId,
        actorType: updatedById ? 'user' : 'system',
        actorId: updatedById,
        entityType: 'user',
        entityId: user.id,
        payload: { changes: input },
      });
    }

    return user;
  }

  /**
   * Delete a user
   */
  async delete(id: string, deletedById: string) {
    const user = await this.getById(id);

    await prisma.user.delete({ where: { id } });

    await eventService.create({
      eventType: 'user.deleted',
      accountId: user.accountId,
      actorType: 'user',
      actorId: deletedById,
      entityType: 'user',
      entityId: id,
      payload: { email: user.email, nome: user.nome },
    });
  }

  /**
   * Change user password
   */
  async changePassword(id: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { passwordHash: true },
    });

    if (!user) {
      throw new NotFoundError('Usuário');
    }

    // Verify current password
    const isValid = await authService.verifyPassword(id, currentPassword);
    if (!isValid) {
      throw new ValidationError(ErrorCodes.PASSWORD_INVALID);
    }

    // Hash new password
    const passwordHash = await authService.hashPassword(newPassword);

    await prisma.user.update({
      where: { id },
      data: { passwordHash },
    });

    // Revoke all refresh tokens
    await prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const updatedUser = await this.getById(id);

    await eventService.create({
      eventType: 'auth.password.reset',
      accountId: updatedUser.accountId,
      actorType: 'user',
      actorId: id,
      entityType: 'user',
      entityId: id,
      payload: { method: 'self_change' },
    });
  }

  /**
   * Impersonate a user (Super Admin only)
   */
  async impersonate(targetUserId: string, impersonatorId: string) {
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      include: { account: true },
    });

    if (!targetUser) {
      throw new NotFoundError('Usuário');
    }

    await eventService.create({
      eventType: 'user.impersonated',
      accountId: targetUser.accountId,
      actorType: 'user',
      actorId: impersonatorId,
      entityType: 'user',
      entityId: targetUserId,
      payload: { targetEmail: targetUser.email },
    });

    // Generate token for target user (will include impersonation flag)
    return {
      user: {
        id: targetUser.id,
        nome: targetUser.nome,
        email: targetUser.email,
        role: targetUser.role,
        accountId: targetUser.accountId,
        permissions: targetUser.permissions,
        status: targetUser.status,
        chatwootAgentId: targetUser.chatwootAgentId,
      },
      account: targetUser.account ? {
        id: targetUser.account.id,
        nome: targetUser.account.nome,
        status: targetUser.account.status,
        timezone: targetUser.account.timezone,
        chatwootBaseUrl: targetUser.account.chatwootBaseUrl,
        chatwootAccountId: targetUser.account.chatwootAccountId,
        chatwootApiKey: targetUser.account.chatwootApiKey,
      } : null,
    };
  }

  /**
   * Get users by account
   */
  async getByAccount(accountId: string) {
    return prisma.user.findMany({
      where: { accountId },
      select: {
        id: true,
        nome: true,
        email: true,
        role: true,
        status: true,
        permissions: true,
        chatwootAgentId: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { nome: 'asc' },
    });
  }
}

export const userService = new UserService();
