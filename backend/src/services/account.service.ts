import { prisma } from '../config/database';
import { AccountStatus } from '@prisma/client';
import { PaginationParams } from '../types';
import { NotFoundError, ConflictError, ErrorCodes } from '../utils/errors';
import { getPaginationMeta } from '../utils/helpers';
import { eventService } from './event.service';

export interface CreateAccountInput {
  nome: string;
  plano?: string;
  limiteUsuarios?: number;
  monthlyExtractionLimit?: number;
  monthlyEmailLimit?: number;
  dailyEmailLimit?: number;
  timezone?: string;
  chatwootBaseUrl?: string;
  chatwootAccountId?: string;
  chatwootApiKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri?: string;
}

export interface UpdateAccountInput extends Partial<CreateAccountInput> {
  status?: AccountStatus;
  openaiApiKey?: string | null;
  sendgridApiKey?: string | null;
  sendgridFromEmail?: string | null;
  sendgridFromName?: string | null;
}

export interface AccountFilters {
  status?: AccountStatus;
  search?: string;
}

class AccountService {
  /**
   * List all accounts with filters
   */
  async list(filters: AccountFilters, pagination: PaginationParams) {
    const where: any = {};

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.search) {
      where.nome = { contains: filters.search, mode: 'insensitive' };
    }

    const [accounts, total] = await Promise.all([
      prisma.account.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.offset,
        take: pagination.limit,
        include: {
          _count: {
            select: {
              users: true,
              contacts: true,
              sales: true,
            },
          },
        },
      }),
      prisma.account.count({ where }),
    ]);

    return {
      data: accounts.map(a => ({
        ...a,
        usersCount: a._count.users,
        contactsCount: a._count.contacts,
        salesCount: a._count.sales,
        _count: undefined,
      })),
      meta: getPaginationMeta(total, pagination),
    };
  }

  /**
   * Get account by ID
   */
  async getById(id: string) {
    const account = await prisma.account.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            users: true,
            contacts: true,
            sales: true,
            products: true,
            tags: true,
          },
        },
      },
    });

    if (!account) {
      throw new NotFoundError('Conta');
    }

    return {
      ...account,
      usersCount: account._count.users,
      contactsCount: account._count.contacts,
      salesCount: account._count.sales,
      productsCount: account._count.products,
      tagsCount: account._count.tags,
      _count: undefined,
    };
  }

  /**
   * Create a new account
   */
  async create(input: CreateAccountInput, createdById?: string) {
    const account = await prisma.account.create({
      data: {
        nome: input.nome,
        plano: input.plano,
        limiteUsuarios: input.limiteUsuarios ?? 10,
        monthlyExtractionLimit: input.monthlyExtractionLimit ?? 500,
        monthlyEmailLimit: input.monthlyEmailLimit ?? 3000,
        dailyEmailLimit: input.dailyEmailLimit ?? 100,
        timezone: input.timezone ?? 'America/Sao_Paulo',
        chatwootBaseUrl: input.chatwootBaseUrl,
        chatwootAccountId: input.chatwootAccountId,
        chatwootApiKey: input.chatwootApiKey,
        googleClientId: input.googleClientId,
        googleClientSecret: input.googleClientSecret,
        googleRedirectUri: input.googleRedirectUri,
      },
    });

    // Create default funnel
    await prisma.funnel.create({
      data: {
        accountId: account.id,
        name: 'Funil Principal',
        slug: 'principal',
        isDefault: true,
      },
    });

    await eventService.create({
      eventType: 'account.created',
      accountId: account.id,
      actorType: createdById ? 'user' : 'system',
      actorId: createdById,
      entityType: 'account',
      entityId: account.id,
      payload: { nome: account.nome, plano: account.plano },
    });

    return account;
  }

  /**
   * Update an account
   */
  async update(id: string, input: UpdateAccountInput, updatedById?: string) {
    const existing = await this.getById(id);

    const account = await prisma.account.update({
      where: { id },
      data: {
        nome: input.nome,
        plano: input.plano,
        limiteUsuarios: input.limiteUsuarios,
        monthlyExtractionLimit: input.monthlyExtractionLimit,
        monthlyEmailLimit: input.monthlyEmailLimit,
        dailyEmailLimit: input.dailyEmailLimit,
        timezone: input.timezone,
        status: input.status,
        chatwootBaseUrl: input.chatwootBaseUrl,
        chatwootAccountId: input.chatwootAccountId,
        chatwootApiKey: input.chatwootApiKey,
        googleClientId: input.googleClientId,
        googleClientSecret: input.googleClientSecret,
        googleRedirectUri: input.googleRedirectUri,
        openaiApiKey: input.openaiApiKey,
        sendgridApiKey: input.sendgridApiKey,
        sendgridFromEmail: input.sendgridFromEmail,
        sendgridFromName: input.sendgridFromName,
      },
    });

    await eventService.create({
      eventType: 'account.updated',
      accountId: account.id,
      actorType: updatedById ? 'user' : 'system',
      actorId: updatedById,
      entityType: 'account',
      entityId: account.id,
      payload: { changes: input },
    });

    return account;
  }

  /**
   * Pause an account
   */
  async pause(id: string, pausedById: string, reason?: string) {
    const account = await prisma.account.update({
      where: { id },
      data: { status: 'paused' },
    });

    await eventService.create({
      eventType: 'account.paused',
      accountId: account.id,
      actorType: 'user',
      actorId: pausedById,
      entityType: 'account',
      entityId: account.id,
      payload: { reason },
    });

    return account;
  }

  /**
   * Activate an account
   */
  async activate(id: string, activatedById: string) {
    const account = await prisma.account.update({
      where: { id },
      data: { status: 'active' },
    });

    await eventService.create({
      eventType: 'account.activated',
      accountId: account.id,
      actorType: 'user',
      actorId: activatedById,
      entityType: 'account',
      entityId: account.id,
    });

    return account;
  }

  /**
   * Delete an account (soft delete by changing status to cancelled)
   */
  async delete(id: string, deletedById: string) {
    // Check if account has any data
    const account = await this.getById(id);

    // Change status to cancelled instead of hard delete
    await prisma.account.update({
      where: { id },
      data: { status: 'cancelled' },
    });

    await eventService.create({
      eventType: 'account.deleted',
      accountId: id,
      actorType: 'user',
      actorId: deletedById,
      entityType: 'account',
      entityId: id,
      payload: { nome: account.nome },
    });
  }

  /**
   * Get account statistics
   */
  async getStats(id: string) {
    const account = await this.getById(id);

    // Get counts
    const [
      usersCount,
      activeUsersCount,
      contactsCount,
      salesCount,
      totalRevenue,
      productsCount,
    ] = await Promise.all([
      prisma.user.count({ where: { accountId: id } }),
      prisma.user.count({ where: { accountId: id, status: 'active' } }),
      prisma.contact.count({ where: { accountId: id } }),
      prisma.sale.count({ where: { accountId: id } }),
      prisma.sale.aggregate({
        where: { accountId: id, status: 'paid' },
        _sum: { valor: true },
      }),
      prisma.product.count({ where: { accountId: id } }),
    ]);

    return {
      account,
      stats: {
        usersCount,
        activeUsersCount,
        contactsCount,
        salesCount,
        totalRevenue: totalRevenue._sum.valor || 0,
        productsCount,
        userLimitUsage: `${usersCount}/${account.limiteUsuarios}`,
      },
    };
  }

  /**
   * Test Chatwoot connection
   */
  async testChatwootConnection(id: string) {
    const account = await this.getById(id);

    if (!account.chatwootBaseUrl || !account.chatwootApiKey) {
      return { connected: false, error: 'Configuração do Chatwoot incompleta' };
    }

    try {
      // Test connection by fetching account info
      const response = await fetch(
        `${account.chatwootBaseUrl}/api/v1/accounts/${account.chatwootAccountId}/agents`,
        {
          headers: {
            'api_access_token': account.chatwootApiKey,
          },
        }
      );

      if (response.ok) {
        const data: any = await response.json();
        return { connected: true, agentsCount: data.length };
      } else {
        return { connected: false, error: `HTTP ${response.status}` };
      }
    } catch (error: any) {
      return { connected: false, error: error.message };
    }
  }

  /**
   * Get Chatwoot agents
   */
  async getChatwootAgents(id: string) {
    const account = await this.getById(id);

    if (!account.chatwootBaseUrl || !account.chatwootApiKey) {
      return [];
    }

    try {
      const response = await fetch(
        `${account.chatwootBaseUrl}/api/v1/accounts/${account.chatwootAccountId}/agents`,
        {
          headers: {
            'api_access_token': account.chatwootApiKey,
          },
        }
      );

      if (response.ok) {
        return response.json();
      }
      return [];
    } catch {
      return [];
    }
  }
}

export const accountService = new AccountService();
