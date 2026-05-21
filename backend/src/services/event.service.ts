import { prisma } from '../config/database';
import { ActorType } from '@prisma/client';
import { EventType, PaginationParams, DateRangeFilter } from '../types';
import { getPaginationMeta } from '../utils/helpers';

export interface CreateEventInput {
  accountId?: string | null;
  eventType: string;
  actorType?: ActorType;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  channel?: string;
  payload?: Record<string, unknown>;
}

export interface EventFilters extends DateRangeFilter {
  accountId?: string;
  eventType?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
}

class EventService {
  /**
   * Create a new audit event (fire-and-forget, never throws)
   */
  async create(input: CreateEventInput): Promise<void> {
    try {
      await prisma.event.create({
        data: {
          accountId: input.accountId ?? null,
          eventType: input.eventType,
          actorType: input.actorType ?? null,
          actorId: input.actorId ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          channel: input.channel ?? null,
          payload: (input.payload as any) ?? undefined,
        },
      });
    } catch (error) {
      // Log error but don't throw - events are fire-and-forget
      console.error('Failed to create audit event:', error);
    }
  }

  /**
   * List events with filters and pagination
   */
  async list(filters: EventFilters, pagination: PaginationParams) {
    const where: any = {};

    if (filters.accountId) {
      where.accountId = filters.accountId;
    }

    if (filters.eventType) {
      where.eventType = { contains: filters.eventType };
    }

    if (filters.entityType) {
      where.entityType = filters.entityType;
    }

    if (filters.entityId) {
      where.entityId = filters.entityId;
    }

    if (filters.actorId) {
      where.actorId = filters.actorId;
    }

    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) {
        where.createdAt.gte = filters.startDate;
      }
      if (filters.endDate) {
        where.createdAt.lte = filters.endDate;
      }
    }

    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.offset,
        take: pagination.limit,
        include: {
          actor: {
            select: {
              id: true,
              nome: true,
              email: true,
            },
          },
        },
      }),
      prisma.event.count({ where }),
    ]);

    return {
      data: events,
      meta: getPaginationMeta(total, pagination),
    };
  }

  /**
   * Get event by ID
   */
  async getById(id: string) {
    return prisma.event.findUnique({
      where: { id },
      include: {
        actor: {
          select: {
            id: true,
            nome: true,
            email: true,
          },
        },
      },
    });
  }

  /**
   * Get events for a specific entity
   */
  async getByEntity(entityType: string, entityId: string, pagination: PaginationParams) {
    const where = { entityType, entityId };

    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.offset,
        take: pagination.limit,
        include: {
          actor: {
            select: {
              id: true,
              nome: true,
              email: true,
            },
          },
        },
      }),
      prisma.event.count({ where }),
    ]);

    return {
      data: events,
      meta: getPaginationMeta(total, pagination),
    };
  }

  /**
   * Get user activity for online status
   */
  async getUserActivity(accountId: string, since: Date = new Date(Date.now() - 5 * 60 * 1000)) {
    const recentEvents = await prisma.event.findMany({
      where: {
        accountId,
        createdAt: { gte: since },
        actorType: 'user',
        actorId: { not: null },
      },
      select: {
        actorId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Group by user, get most recent activity
    const userActivity = new Map<string, Date>();
    for (const event of recentEvents) {
      if (event.actorId && !userActivity.has(event.actorId)) {
        userActivity.set(event.actorId, event.createdAt);
      }
    }

    return Array.from(userActivity.entries()).map(([userId, lastActivity]) => ({
      userId,
      lastActivity,
      isOnline: true,
    }));
  }

  /**
   * Get event statistics for a period
   */
  async getStats(accountId: string, filters: DateRangeFilter) {
    const where: any = { accountId };

    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) {
        where.createdAt.gte = filters.startDate;
      }
      if (filters.endDate) {
        where.createdAt.lte = filters.endDate;
      }
    }

    const events = await prisma.event.groupBy({
      by: ['eventType'],
      where,
      _count: { id: true },
    });

    return events.map(e => ({
      eventType: e.eventType,
      count: e._count.id,
    }));
  }
}

export const eventService = new EventService();
