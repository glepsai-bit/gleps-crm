import { prisma } from '../config/database';
import { AccountStatus } from '@prisma/client';
import { PaginationParams } from '../types';
import { NotFoundError, ConflictError, ErrorCodes } from '../utils/errors';
import { getPaginationMeta, escapeLike } from '../utils/helpers';
import { eventService } from './event.service';

const SENSITIVE_KEYS = [
  'evolutionApiKey',
  'evolutionWebhookSecret',
  'openaiApiKey',
  'sendgridApiKey',
  'googleClientSecret',
] as const;

/**
 * Replace sensitive credential fields with '***SET***' (if value provided)
 * or null (if explicitly cleared), so audit/event payloads never store secrets in plain text.
 */
function maskSensitiveFields<T extends Record<string, any>>(input: T): T {
  const masked: Record<string, any> = { ...input };
  for (const key of SENSITIVE_KEYS) {
    if (key in masked) {
      const value = masked[key];
      if (value === null || value === undefined || value === '') {
        masked[key] = null;
      } else {
        masked[key] = '***SET***';
      }
    }
  }
  return masked as T;
}

export interface CreateAccountInput {
  nome: string;
  plano?: string;
  limiteUsuarios?: number;
  monthlyExtractionLimit?: number;
  monthlyEmailLimit?: number;
  dailyEmailLimit?: number;
  timezone?: string;
  evolutionBaseUrl?: string;
  evolutionApiKey?: string;
  evolutionInstance?: string;
  evolutionWebhookSecret?: string;
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
      // T1-ILIKE-WILDCARD: escapa `%` e `_` para evitar wildcards SQL.
      where.nome = { contains: escapeLike(filters.search), mode: 'insensitive' };
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
    const account = await prisma.$transaction(async (tx) => {
      const created = await tx.account.create({
        data: {
          nome: input.nome,
          plano: input.plano,
          limiteUsuarios: input.limiteUsuarios ?? 10,
          monthlyExtractionLimit: input.monthlyExtractionLimit ?? 500,
          monthlyEmailLimit: input.monthlyEmailLimit ?? 3000,
          dailyEmailLimit: input.dailyEmailLimit ?? 100,
          timezone: input.timezone ?? 'America/Sao_Paulo',
          evolutionBaseUrl: input.evolutionBaseUrl,
          evolutionApiKey: input.evolutionApiKey,
          evolutionInstance: input.evolutionInstance,
          evolutionWebhookSecret: input.evolutionWebhookSecret,
          googleClientId: input.googleClientId,
          googleClientSecret: input.googleClientSecret,
          googleRedirectUri: input.googleRedirectUri,
        },
      });

      // Create default funnel
      await tx.funnel.create({
        data: {
          accountId: created.id,
          name: 'Funil Principal',
          slug: 'principal',
          isDefault: true,
        },
      });

      await eventService.create({
        eventType: 'account.created',
        accountId: created.id,
        actorType: createdById ? 'user' : 'system',
        actorId: createdById,
        entityType: 'account',
        entityId: created.id,
        payload: { nome: created.nome, plano: created.plano },
      });

      return created;
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
        evolutionBaseUrl: input.evolutionBaseUrl,
        evolutionApiKey: input.evolutionApiKey,
        evolutionInstance: input.evolutionInstance,
        evolutionWebhookSecret: input.evolutionWebhookSecret,
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
      payload: { changes: maskSensitiveFields(input) },
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

}

export const accountService = new AccountService();
