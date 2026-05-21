import { prisma } from '../config/database';
import { TagType } from '@prisma/client';
import { NotFoundError, ValidationError, ErrorCodes } from '../utils/errors';
import { slugify } from '../utils/helpers';
import { eventService } from './event.service';
import { chatwootService } from './chatwoot.service';
import { logger } from '../utils/logger';

export interface CreateTagInput {
  accountId: string;
  funnelId: string;
  name: string;
  type: TagType;
  color?: string;
}

export interface UpdateTagInput {
  name?: string;
  color?: string;
}

export interface TagFilters {
  accountId: string;
  funnelId?: string;
  type?: TagType;
  ativo?: boolean;
}

class TagService {
  /**
   * List tags with filters
   */
  async list(filters: TagFilters) {
    const where: any = {
      accountId: filters.accountId,
    };

    if (filters.funnelId) {
      where.funnelId = filters.funnelId;
    }

    if (filters.type) {
      where.type = filters.type;
    }

    if (filters.ativo !== undefined) {
      where.ativo = filters.ativo;
    }

    const tags = await prisma.tag.findMany({
      where,
      orderBy: [{ type: 'asc' }, { ordem: 'asc' }],
      include: {
        funnel: {
          select: { id: true, name: true },
        },
        _count: {
          select: { leadTags: true },
        },
      },
    });

    return tags.map(t => ({
      ...t,
      leadsCount: t._count.leadTags,
      _count: undefined,
    }));
  }

  /**
   * Get tag by ID
   */
  async getById(id: string, accountId?: string) {
    const where: any = { id };
    if (accountId) {
      where.accountId = accountId;
    }

    const tag = await prisma.tag.findFirst({
      where,
      include: {
        funnel: {
          select: { id: true, name: true },
        },
        _count: {
          select: { leadTags: true },
        },
      },
    });

    if (!tag) {
      throw new NotFoundError('Tag');
    }

    return {
      ...tag,
      leadsCount: tag._count.leadTags,
      _count: undefined,
    };
  }

  /**
   * Create a new tag
   */
  async create(input: CreateTagInput, createdById?: string) {
    // Get the max ordem for the funnel
    const maxOrdem = await prisma.tag.findFirst({
      where: { funnelId: input.funnelId, type: input.type },
      orderBy: { ordem: 'desc' },
      select: { ordem: true },
    });

    const slug = slugify(input.name);

    // Check if slug is unique for the account
    const existingSlug = await prisma.tag.findFirst({
      where: {
        accountId: input.accountId,
        slug,
      },
    });

    const finalSlug = existingSlug ? `${slug}-${Date.now()}` : slug;

    const tag = await prisma.tag.create({
      data: {
        accountId: input.accountId,
        funnelId: input.funnelId,
        name: input.name,
        slug: finalSlug,
        type: input.type,
        color: input.color || '#6366F1',
        ordem: (maxOrdem?.ordem ?? -1) + 1,
      },
    });

    // Sync stage tags with Chatwoot labels
    if (input.type === 'stage') {
      try {
        const account = await prisma.account.findUnique({ where: { id: input.accountId } });
        
    if (account?.chatwootApiKey && account?.chatwootBaseUrl && account?.chatwootAccountId) {
          const label = await chatwootService.createLabel(input.accountId, {
            title: finalSlug,  // Use slug (e.g. "novo_lead"), not display name
            description: `Etapa do Kanban: ${input.name}`,
            color: input.color || '#6366F1',
          });
          
          // Update tag with Chatwoot label ID
          await prisma.tag.update({
            where: { id: tag.id },
            data: { chatwootLabelId: label.id },
          });
          
          logger.info('Tag synced to Chatwoot label', { tagId: tag.id, labelId: label.id });
        }
      } catch (error) {
        logger.warn('Failed to sync tag with Chatwoot', { tagId: tag.id, error });
        // Don't fail the operation, just log the error
      }
    }

    // Record in tag history
    await prisma.tagHistory.create({
      data: {
        tagId: tag.id,
        action: 'tag_created',
        actorType: createdById ? 'user' : 'system',
        actorId: createdById,
        source: 'api',
        tagName: tag.name,
      },
    });

    await eventService.create({
      eventType: 'funnel.stage.created',
      accountId: input.accountId,
      actorType: createdById ? 'user' : 'system',
      actorId: createdById,
      entityType: 'tag',
      entityId: tag.id,
      payload: { name: tag.name, type: tag.type },
    });

    return tag;
  }

  /**
   * Update a tag
   */
  async update(id: string, input: UpdateTagInput, accountId: string, updatedById?: string) {
    const existingTag = await this.getById(id, accountId);

    const tag = await prisma.tag.update({
      where: { id },
      data: {
        name: input.name,
        color: input.color,
      },
    });

    // Sync with Chatwoot if tag has a linked label
    if (existingTag.chatwootLabelId) {
      try {
        await chatwootService.updateLabel(accountId, existingTag.chatwootLabelId, {
          title: existingTag.slug,
          description: input.name ? `Etapa do Kanban: ${input.name}` : undefined,
          color: input.color,
        });
        logger.info('Tag update synced to Chatwoot', { tagId: id, labelId: existingTag.chatwootLabelId });
      } catch (error) {
        logger.warn('Failed to sync tag update with Chatwoot', { tagId: id, error });
      }
    }

    await eventService.create({
      eventType: 'funnel.stage.updated',
      accountId,
      actorType: updatedById ? 'user' : 'system',
      actorId: updatedById,
      entityType: 'tag',
      entityId: tag.id,
      payload: { changes: input },
    });

    return tag;
  }

  /**
   * Delete a tag (force option allows removing/migrating leads first)
   */
  async delete(id: string, accountId: string, deletedById: string, options?: { force?: boolean; migrateToId?: string }) {
    const tag = await this.getById(id, accountId);

    // Check if tag has leads
    const leadsCount = await prisma.leadTag.count({
      where: { tagId: id },
    });

    if (leadsCount > 0 && !options?.force) {
      throw new ValidationError(ErrorCodes.TAG_HAS_LEADS);
    }

    // Handle leads before deletion
    if (leadsCount > 0 && options?.force) {
      if (options.migrateToId) {
        // Validate target tag exists and belongs to same account
        await this.getById(options.migrateToId, accountId);
        await prisma.leadTag.updateMany({
          where: { tagId: id },
          data: { tagId: options.migrateToId },
        });
        logger.info('Leads migrated before tag deletion', { fromTagId: id, toTagId: options.migrateToId, count: leadsCount });
      } else {
        await prisma.leadTag.deleteMany({ where: { tagId: id } });
        logger.info('Lead tags removed before tag deletion', { tagId: id, count: leadsCount });
      }
    }

    // Delete Chatwoot label if linked
    if (tag.chatwootLabelId) {
      try {
        await chatwootService.deleteLabel(accountId, tag.chatwootLabelId);
        logger.info('Chatwoot label deleted', { tagId: id, labelId: tag.chatwootLabelId });
      } catch (error) {
        logger.warn('Failed to delete Chatwoot label', { tagId: id, error });
      }
    }

    // Record history BEFORE deleting (tagId: null to avoid FK violation)
    await prisma.tagHistory.create({
      data: {
        tagId: null,
        action: 'tag_deleted',
        actorType: 'user',
        actorId: deletedById,
        source: 'api',
        tagName: tag.name,
      },
    });

    await prisma.tag.delete({ where: { id } });

    await eventService.create({
      eventType: 'funnel.stage.deleted',
      accountId,
      actorType: 'user',
      actorId: deletedById,
      entityType: 'tag',
      entityId: id,
      payload: { name: tag.name, migratedTo: options?.migrateToId || null, leadsAffected: leadsCount },
    });
  }

  /**
   * Reorder a single tag
   */
  async reorder(id: string, ordem: number, accountId: string, reorderedById: string) {
    await this.getById(id, accountId);

    const tag = await prisma.tag.update({
      where: { id },
      data: { ordem },
    });

    return tag;
  }

  /**
   * Reorder multiple tags (swap mode when exactly 2 IDs)
   */
  async reorderBulk(tagIds: string[], accountId: string, reorderedById: string) {
    if (tagIds.length === 2) {
      // Swap mode: exchange ordem values between the two tags
      const [tag1, tag2] = await Promise.all([
        prisma.tag.findUnique({ where: { id: tagIds[0] }, select: { id: true, ordem: true } }),
        prisma.tag.findUnique({ where: { id: tagIds[1] }, select: { id: true, ordem: true } }),
      ]);

      if (!tag1 || !tag2) {
        throw new NotFoundError('Uma ou ambas as tags não foram encontradas');
      }

      await prisma.$transaction([
        prisma.tag.update({ where: { id: tag1.id }, data: { ordem: tag2.ordem } }),
        prisma.tag.update({ where: { id: tag2.id }, data: { ordem: tag1.ordem } }),
      ]);
    } else {
      // Full reorder: assign ordem based on array position
      await prisma.$transaction(
        tagIds.map((id, index) =>
          prisma.tag.update({
            where: { id },
            data: { ordem: index },
          })
        )
      );
    }

    await eventService.create({
      eventType: 'funnel.stage.reordered',
      accountId,
      actorType: 'user',
      actorId: reorderedById,
      entityType: 'tag',
      payload: { tagIds },
    });

    return this.list({ accountId, ativo: true });
  }

  /**
   * Get tags with lead counts for Kanban
   */
  async getKanbanData(accountId: string, funnelId?: string) {
    const where: any = {
      accountId,
      type: 'stage',
      ativo: true,
    };

    if (funnelId) {
      where.funnelId = funnelId;
    }

    const tags = await prisma.tag.findMany({
      where,
      orderBy: { ordem: 'asc' },
      include: {
        leadTags: {
          include: {
            contact: {
              include: {
                leadTags: {
                  include: {
                    tag: {
                      select: { id: true, name: true, color: true, type: true },
                    },
                  },
                },
                _count: {
                  select: { sales: true },
                },
              },
            },
          },
        },
      },
    });

    return tags.map(tag => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      ordem: tag.ordem,
      leads: tag.leadTags.map(lt => ({
        ...lt.contact,
        tags: lt.contact.leadTags.map(t => t.tag),
        salesCount: lt.contact._count.sales,
        leadTags: undefined,
        _count: undefined,
      })),
    }));
  }

  /**
   * Reconcile all active stage tags with Chatwoot labels
   * - garante título por slug
   * - corrige vínculos quebrados (chatwootLabelId inválido)
   * - cria labels faltantes
   */
  async syncAllLabels(accountId: string) {
    const account = await prisma.account.findUnique({ where: { id: accountId } });

    if (!account?.chatwootApiKey || !account?.chatwootBaseUrl || !account?.chatwootAccountId) {
      throw new ValidationError('Configuração do Chatwoot incompleta.');
    }

    const tags = await prisma.tag.findMany({
      where: {
        accountId,
        type: 'stage',
        ativo: true,
      },
      orderBy: { ordem: 'asc' },
    });

    const results: { tagId: string; tagName: string; slug: string; labelId?: number; error?: string }[] = [];

    for (const tag of tags) {
      try {
        const labelId = await chatwootService.syncTagToLabel(tag.id, accountId);

        if (!labelId) {
          results.push({
            tagId: tag.id,
            tagName: tag.name,
            slug: tag.slug,
            error: 'Falha ao reconciliar etiqueta no Chatwoot',
          });
          continue;
        }

        results.push({
          tagId: tag.id,
          tagName: tag.name,
          slug: tag.slug,
          labelId,
        });
      } catch (error: any) {
        results.push({
          tagId: tag.id,
          tagName: tag.name,
          slug: tag.slug,
          error: error?.message || 'Erro desconhecido',
        });
        logger.warn('Failed to reconcile tag label', { tagId: tag.id, error });
      }
    }

    return {
      synced: results.filter(r => !r.error).length,
      failed: results.filter(r => r.error).length,
      details: results,
    };
  }
}

export const tagService = new TagService();

// Funnel Service
class FunnelService {
  async list(accountId: string) {
    return prisma.funnel.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
      include: {
        _count: {
          select: { tags: true },
        },
      },
    });
  }

  async getById(id: string, accountId?: string) {
    const where: any = { id };
    if (accountId) {
      where.accountId = accountId;
    }

    const funnel = await prisma.funnel.findFirst({
      where,
      include: {
        tags: {
          orderBy: { ordem: 'asc' },
        },
      },
    });

    if (!funnel) {
      throw new NotFoundError('Funil');
    }

    return funnel;
  }

  async create(accountId: string, name: string, createdById?: string) {
    const slug = slugify(name);

    const funnel = await prisma.funnel.create({
      data: {
        accountId,
        name,
        slug,
      },
    });

    return funnel;
  }

  async update(id: string, name: string, accountId: string) {
    await this.getById(id, accountId);

    return prisma.funnel.update({
      where: { id },
      data: { name },
    });
  }

  async delete(id: string, accountId: string) {
    const funnel = await this.getById(id, accountId);

    // Check if it's the default funnel
    if (funnel.isDefault) {
      throw new ValidationError('Não é possível excluir o funil padrão');
    }

    // Check if funnel has tags with leads
    const tagsWithLeads = await prisma.tag.findFirst({
      where: {
        funnelId: id,
        leadTags: { some: {} },
      },
    });

    if (tagsWithLeads) {
      throw new ValidationError('Funil possui tags com leads e não pode ser excluído');
    }

    await prisma.funnel.delete({ where: { id } });
  }
}

export const funnelService = new FunnelService();
