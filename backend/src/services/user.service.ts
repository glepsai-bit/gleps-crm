import { prisma } from '../config/database';
import { UserRole, UserStatus } from '@prisma/client';
import { PaginationParams } from '../types';
import { NotFoundError, ConflictError, ValidationError, ErrorCodes } from '../utils/errors';
import { getPaginationMeta, escapeLike } from '../utils/helpers';
import { authService } from './auth.service';
import { eventService } from './event.service';

export interface CreateUserInput {
  accountId?: string;
  nome: string;
  email: string;
  password: string;
  role: UserRole;
  permissions?: string[];
}

export interface UpdateUserInput {
  nome?: string;
  email?: string;
  role?: UserRole;
  status?: UserStatus;
  permissions?: string[];
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
      // T1-ILIKE-WILDCARD: escapa `%` e `_` para evitar wildcards SQL.
      const safeSearch = escapeLike(filters.search);
      where.OR = [
        { nome: { contains: safeSearch, mode: 'insensitive' } },
        { email: { contains: safeSearch, mode: 'insensitive' } },
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
      },
      select: {
        id: true,
        accountId: true,
        nome: true,
        email: true,
        role: true,
        status: true,
        permissions: true,
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
      },
      select: {
        id: true,
        accountId: true,
        nome: true,
        email: true,
        role: true,
        status: true,
        permissions: true,
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
      },
      account: targetUser.account ? {
        id: targetUser.account.id,
        nome: targetUser.account.nome,
        status: targetUser.account.status,
        timezone: targetUser.account.timezone,
      } : null,
    };
  }

  /**
   * T-024: Lista usuarios escopados por conta (uso do admin de conta).
   * Sempre forca accountId no where e exclui role='super_admin'.
   */
  async listAdminScoped(accountId: string, filters: UserFilters, pagination: PaginationParams) {
    const where: any = {
      accountId,
      role: { not: 'super_admin' as UserRole },
    };

    if (filters.role) {
      where.role = filters.role; // sobrescreve o NOT super_admin propositalmente
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.search) {
      const safeSearch = escapeLike(filters.search);
      where.OR = [
        { nome: { contains: safeSearch, mode: 'insensitive' } },
        { email: { contains: safeSearch, mode: 'insensitive' } },
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
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
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
   * T-024: Limites de agents da conta (consumo do tier).
   */
  async getAgentLimits(accountId: string) {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        maxAgents: true,
        limiteUsuarios: true,
        plano: true,
        _count: { select: { users: true } },
      },
    });

    if (!account) {
      throw new NotFoundError('Conta');
    }

    // BUG-T024-04: conta APENAS agents com status='active'. Desativar um
    // agente que saiu da empresa deve liberar slot do plano (padrao Chatwoot
    // /Front/Help Scout). Se admin tentar abusar (criar/desativar/criar de
    // novo), audit log captura.
    const usedAgents = await prisma.user.count({
      where: { accountId, role: 'agent' as UserRole, status: 'active' },
    });

    return {
      maxAgents: account.maxAgents,
      usedAgents,
      remainingAgents: Math.max(0, account.maxAgents - usedAgents),
      maxUsers: account.limiteUsuarios,
      usedUsers: account._count.users,
      plan: account.plano,
    };
  }

  /**
   * T-024: Cria user escopado em uma conta, validando limite de agents
   * dentro de transacao Serializable para evitar race condition.
   * Bloqueia super_admin/admin (regras de privilege escalation no controller).
   */
  async createScoped(
    accountId: string,
    input: Omit<CreateUserInput, 'accountId'>,
    createdById?: string
  ) {
    const email = input.email.toLowerCase();

    // Pre-check de email fora da transacao (rapido, evita lock se ja duplicado)
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new ConflictError(ErrorCodes.EMAIL_IN_USE, { email: input.email });
    }

    const passwordHash = await authService.hashPassword(input.password);

    // Garante permission 'dashboard' para agents
    let permissions = input.permissions || ['dashboard'];
    if (input.role === 'agent' && !permissions.includes('dashboard')) {
      permissions = ['dashboard', ...permissions];
    }

    // Transacao Serializable: protege contra criacao concorrente que
    // excederia maxAgents (T2 do plano).
    const user = await prisma.$transaction(
      async (tx) => {
        const account = await tx.account.findUnique({
          where: { id: accountId },
          select: { maxAgents: true, limiteUsuarios: true, _count: { select: { users: true } } },
        });

        if (!account) {
          throw new NotFoundError('Conta');
        }

        // Teto total de users
        if (account._count.users >= account.limiteUsuarios) {
          throw new ValidationError(ErrorCodes.USER_LIMIT_EXCEEDED);
        }

        // Teto especifico de agents — BUG-T024-04: so active (coerente com
        // getAgentLimits/badge). Inactives nao consomem slot.
        if (input.role === 'agent') {
          const usedAgents = await tx.user.count({
            where: { accountId, role: 'agent' as UserRole, status: 'active' },
          });
          if (usedAgents >= account.maxAgents) {
            throw new ValidationError(ErrorCodes.AGENT_LIMIT_EXCEEDED);
          }
        }

        return tx.user.create({
          data: {
            accountId,
            nome: input.nome,
            email,
            passwordHash,
            role: input.role,
            permissions,
          },
          select: {
            id: true,
            accountId: true,
            nome: true,
            email: true,
            role: true,
            status: true,
            permissions: true,
            createdAt: true,
          },
        });
      },
      { isolationLevel: 'Serializable' }
    );

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
   * T-024: Update escopado — checa limite de agents quando promovendo admin->agent
   * (improvavel mas previsto) e reforca permissions['dashboard'] para agents.
   */
  async updateScoped(
    id: string,
    accountId: string,
    input: UpdateUserInput,
    updatedById?: string
  ) {
    const existing = await this.getById(id);
    if (existing.accountId !== accountId) {
      // Defensa em profundidade — controller ja deveria ter barrado via middleware
      throw new NotFoundError('Usuário');
    }

    if (input.email && input.email.toLowerCase() !== existing.email) {
      const emailInUse = await prisma.user.findUnique({
        where: { email: input.email.toLowerCase() },
      });
      if (emailInUse) {
        throw new ConflictError(ErrorCodes.EMAIL_IN_USE, { email: input.email });
      }
    }

    // Re-check de limite quando promovendo para agent
    if (input.role === 'agent' && existing.role !== 'agent') {
      const limits = await this.getAgentLimits(accountId);
      if (limits.usedAgents >= limits.maxAgents) {
        throw new ValidationError(ErrorCodes.AGENT_LIMIT_EXCEEDED);
      }
    }

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
      },
      select: {
        id: true,
        accountId: true,
        nome: true,
        email: true,
        role: true,
        status: true,
        permissions: true,
        createdAt: true,
        updatedAt: true,
      },
    });

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
   * T-024: Conta admins ativos de uma conta (para validar regra "nao remover ultimo admin")
   */
  async countActiveAdminsInAccount(accountId: string): Promise<number> {
    return prisma.user.count({
      where: { accountId, role: 'admin' as UserRole, status: 'active' as UserStatus },
    });
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
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { nome: 'asc' },
    });
  }
}

export const userService = new UserService();
