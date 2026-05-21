import { prisma } from '../config/database';
import { ContactOrigin } from '@prisma/client';
import { PaginationParams } from '../types';
import { NotFoundError, ValidationError, ErrorCodes } from '../utils/errors';
import { getPaginationMeta } from '../utils/helpers';
import { eventService } from './event.service';
import { chatwootService } from './chatwoot.service';
import { logger } from '../utils/logger';

export interface CreateContactInput {
  accountId: string;
  nome?: string;
  telefone?: string;
  email?: string;
  origem?: ContactOrigin;
  chatwootContactId?: number;
  chatwootConversationId?: number;
}

export interface UpdateContactInput {
  nome?: string;
  telefone?: string;
  email?: string;
  origem?: ContactOrigin;
}

export interface ContactFilters {
  accountId: string;
  search?: string;
  origem?: ContactOrigin;
  tagId?: string;
}

class ContactService {
  /**
   * List contacts with filters
   */
  async list(filters: ContactFilters, pagination: PaginationParams) {
    const where: any = {
      accountId: filters.accountId,
    };

    if (filters.search) {
      where.OR = [
        { nome: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
        { telefone: { contains: filters.search } },
      ];
    }

    if (filters.origem) {
      where.origem = filters.origem;
    }

    if (filters.tagId) {
      where.leadTags = {
        some: { tagId: filters.tagId },
      };
    }

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.offset,
        take: pagination.limit,
        include: {
          leadTags: {
            include: {
              tag: {
                select: {
                  id: true,
                  name: true,
                  color: true,
                  type: true,
                },
              },
            },
          },
          _count: {
            select: {
              sales: true,
              leadNotes: true,
            },
          },
        },
      }),
      prisma.contact.count({ where }),
    ]);

    return {
      data: contacts.map(c => ({
        ...c,
        tags: c.leadTags.map(lt => lt.tag),
        salesCount: c._count.sales,
        notesCount: c._count.leadNotes,
        leadTags: undefined,
        _count: undefined,
      })),
      meta: getPaginationMeta(total, pagination),
    };
  }

  /**
   * Get contact by ID
   */
  async getById(id: string, accountId?: string) {
    const where: any = { id };
    if (accountId) {
      where.accountId = accountId;
    }

    const contact = await prisma.contact.findFirst({
      where,
      include: {
        leadTags: {
          include: {
            tag: true,
          },
        },
        _count: {
          select: {
            sales: true,
            leadNotes: true,
          },
        },
      },
    });

    if (!contact) {
      throw new NotFoundError('Contato');
    }

    return {
      ...contact,
      tags: contact.leadTags.map(lt => lt.tag),
      salesCount: contact._count.sales,
      notesCount: contact._count.leadNotes,
      leadTags: undefined,
      _count: undefined,
    };
  }

  /**
   * Create a new contact
   */
  async create(input: CreateContactInput, createdById?: string) {
    const contact = await prisma.contact.create({
      data: {
        accountId: input.accountId,
        nome: input.nome,
        telefone: input.telefone,
        email: input.email?.toLowerCase(),
        origem: input.origem,
        chatwootContactId: input.chatwootContactId,
        chatwootConversationId: input.chatwootConversationId,
      },
    });

    await eventService.create({
      eventType: 'lead.created',
      accountId: input.accountId,
      actorType: createdById ? 'user' : 'system',
      actorId: createdById,
      entityType: 'contact',
      entityId: contact.id,
      payload: { nome: contact.nome, origem: contact.origem },
    });

    return contact;
  }

  /**
   * Update a contact
   */
  async update(id: string, input: UpdateContactInput, accountId: string, updatedById?: string) {
    const existing = await this.getById(id, accountId);

    const contact = await prisma.contact.update({
      where: { id },
      data: {
        nome: input.nome,
        telefone: input.telefone,
        email: input.email?.toLowerCase(),
        origem: input.origem,
      },
    });

    await eventService.create({
      eventType: 'lead.updated',
      accountId: contact.accountId,
      actorType: updatedById ? 'user' : 'system',
      actorId: updatedById,
      entityType: 'contact',
      entityId: contact.id,
      payload: { changes: input },
    });

    return contact;
  }

  /**
   * Delete a contact (only if no sales)
   */
  async delete(id: string, accountId: string, deletedById: string) {
    const contact = await this.getById(id, accountId);

    // Check if contact has sales
    const salesCount = await prisma.sale.count({
      where: { contactId: id },
    });

    if (salesCount > 0) {
      throw new ValidationError(ErrorCodes.CONTACT_HAS_SALES);
    }

    await prisma.contact.delete({ where: { id } });

    await eventService.create({
      eventType: 'lead.updated',
      accountId,
      actorType: 'user',
      actorId: deletedById,
      entityType: 'contact',
      entityId: id,
      payload: { action: 'deleted', nome: contact.nome },
    });
  }

  /**
   * Get contact sales
   */
  async getSales(id: string, accountId: string, pagination: PaginationParams) {
    await this.getById(id, accountId);

    const [sales, total] = await Promise.all([
      prisma.sale.findMany({
        where: { contactId: id },
        orderBy: { createdAt: 'desc' },
        skip: pagination.offset,
        take: pagination.limit,
        include: {
          items: {
            include: {
              product: {
                select: { id: true, nome: true },
              },
            },
          },
          responsavel: {
            select: { id: true, nome: true },
          },
        },
      }),
      prisma.sale.count({ where: { contactId: id } }),
    ]);

    return {
      data: sales,
      meta: getPaginationMeta(total, pagination),
    };
  }

  /**
   * Get contact notes
   */
  async getNotes(id: string, accountId: string, pagination: PaginationParams) {
    await this.getById(id, accountId);

    const [notes, total] = await Promise.all([
      prisma.leadNote.findMany({
        where: { contactId: id },
        orderBy: { createdAt: 'desc' },
        skip: pagination.offset,
        take: pagination.limit,
      }),
      prisma.leadNote.count({ where: { contactId: id } }),
    ]);

    return {
      data: notes,
      meta: getPaginationMeta(total, pagination),
    };
  }

  /**
   * Add note to contact
   */
  async addNote(id: string, accountId: string, content: string, authorId: string, authorName: string) {
    await this.getById(id, accountId);

    const note = await prisma.leadNote.create({
      data: {
        contactId: id,
        authorId,
        authorName,
        content,
      },
    });

    return note;
  }

  /**
   * Get contact tags
   */
  async getTags(id: string, accountId: string) {
    const contact = await this.getById(id, accountId);
    return contact.tags;
  }

  /**
   * Apply tag to contact
   */
  async applyTag(
    id: string,
    accountId: string,
    tagId: string,
    source: 'kanban' | 'chatwoot' | 'system' | 'api',
    appliedById?: string
  ) {
    const contact = await this.getById(id, accountId);

    // Get the tag
    const tag = await prisma.tag.findUnique({
      where: { id: tagId },
    });

    if (!tag || tag.accountId !== accountId) {
      throw new NotFoundError('Tag');
    }

    // If it's a stage tag, remove other stage tags first
    if (tag.type === 'stage') {
      const existingStageTags = await prisma.leadTag.findMany({
        where: {
          contactId: id,
          tag: { type: 'stage' },
        },
        include: { tag: true },
      });

      for (const existing of existingStageTags) {
        await prisma.leadTag.delete({
          where: { id: existing.id },
        });

        await prisma.tagHistory.create({
          data: {
            contactId: id,
            tagId: existing.tagId,
            action: 'removed',
            actorType: appliedById ? 'user' : 'system',
            actorId: appliedById,
            source,
            tagName: existing.tag.name,
            contactNome: contact.nome,
          },
        });
      }
    }

    // Check if tag is already applied
    const existingLeadTag = await prisma.leadTag.findUnique({
      where: {
        contactId_tagId: { contactId: id, tagId },
      },
    });

    if (existingLeadTag) {
      return contact; // Tag already applied
    }

    // Apply the tag
    await prisma.leadTag.create({
      data: {
        contactId: id,
        tagId,
        appliedByType: appliedById ? 'user' : 'system',
        appliedById,
        source,
      },
    });

    // Record history
    await prisma.tagHistory.create({
      data: {
        contactId: id,
        tagId,
        action: 'added',
        actorType: appliedById ? 'user' : 'system',
        actorId: appliedById,
        source,
        tagName: tag.name,
        contactNome: contact.nome,
      },
    });

    await eventService.create({
      eventType: tag.type === 'stage' ? 'lead.stage.changed' : 'lead.tag.added',
      accountId,
      actorType: appliedById ? 'user' : 'system',
      actorId: appliedById,
      entityType: 'contact',
      entityId: id,
      payload: { tagId, tagName: tag.name, source },
    });

    // Sync to Chatwoot if this is a stage change from Kanban
    if (tag.type === 'stage' && source === 'kanban') {
      try {
        await chatwootService.syncLeadStageToConversation(id, tag.slug, accountId);
      } catch (error) {
        logger.warn('Failed to sync stage change to Chatwoot', { contactId: id, tagId, error });
      }
    }

    return this.getById(id, accountId);
  }

  /**
   * Remove tag from contact
   */
  async removeTag(
    id: string,
    accountId: string,
    tagId: string,
    source: 'kanban' | 'chatwoot' | 'system' | 'api',
    removedById?: string
  ) {
    const contact = await this.getById(id, accountId);

    const leadTag = await prisma.leadTag.findUnique({
      where: {
        contactId_tagId: { contactId: id, tagId },
      },
      include: { tag: true },
    });

    if (!leadTag) {
      return contact; // Tag not applied
    }

    await prisma.leadTag.delete({
      where: { id: leadTag.id },
    });

    await prisma.tagHistory.create({
      data: {
        contactId: id,
        tagId,
        action: 'removed',
        actorType: removedById ? 'user' : 'system',
        actorId: removedById,
        source,
        tagName: leadTag.tag.name,
        contactNome: contact.nome,
      },
    });

    await eventService.create({
      eventType: 'lead.tag.removed',
      accountId,
      actorType: removedById ? 'user' : 'system',
      actorId: removedById,
      entityType: 'contact',
      entityId: id,
      payload: { tagId, tagName: leadTag.tag.name, source },
    });

    return this.getById(id, accountId);
  }

  /**
   * Get contact tag history
   */
  async getHistory(id: string, accountId: string, pagination: PaginationParams) {
    await this.getById(id, accountId);

    const [history, total] = await Promise.all([
      prisma.tagHistory.findMany({
        where: { contactId: id },
        orderBy: { createdAt: 'desc' },
        skip: pagination.offset,
        take: pagination.limit,
        include: {
          tag: {
            select: { id: true, name: true, color: true },
          },
        },
      }),
      prisma.tagHistory.count({ where: { contactId: id } }),
    ]);

    return {
      data: history,
      meta: getPaginationMeta(total, pagination),
    };
  }

  /**
   * Get contacts by stage (for Kanban)
   */
  async getByStage(accountId: string, tagId: string) {
    const contacts = await prisma.contact.findMany({
      where: {
        accountId,
        leadTags: {
          some: { tagId },
        },
      },
      include: {
        leadTags: {
          include: {
            tag: {
              select: {
                id: true,
                name: true,
                color: true,
                type: true,
              },
            },
          },
        },
        _count: {
          select: { sales: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return contacts.map(c => ({
      ...c,
      tags: c.leadTags.map(lt => lt.tag),
      salesCount: c._count.sales,
      leadTags: undefined,
      _count: undefined,
    }));
  }

  /**
   * List all lead_tags for an account (for Kanban mapping)
   */
  async listLeadTags(accountId: string) {
    const leadTags = await prisma.leadTag.findMany({
      where: {
        contact: {
          accountId,
        },
      },
      include: {
        tag: {
          select: {
            id: true,
            name: true,
            color: true,
            type: true,
          },
        },
      },
    });

    return leadTags.map(lt => ({
      id: lt.id,
      contact_id: lt.contactId,
      tag_id: lt.tagId,
      applied_by_id: lt.appliedById,
      source: lt.source,
      created_at: (lt.createdAt as any)?.toISOString?.() ?? lt.createdAt,
      tag: lt.tag,
    }));
  }
}

export const contactService = new ContactService();
