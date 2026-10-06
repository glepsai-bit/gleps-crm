import { prisma } from '../config/database';
import { Prisma, TagType } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError, ErrorCodes } from '../utils/errors';
import { slugify } from '../utils/helpers';
import { eventService } from './event.service';
import { logger } from '../utils/logger';

/**
 * ETAPA B — papel fixo de uma etapa. 'fechamento' é onde o lead vira venda;
 * 'perda' é onde ele sai do funil. Todo funil tem exatamente uma de cada, e
 * elas não se apagam: o gatilho da venda e as métricas do dashboard dependem
 * de existirem.
 */
export type PapelDaEtapa = 'fechamento' | 'perda';

export const ETAPAS_FIXAS: ReadonlyArray<{
  name: string;
  slug: string;
  color: string;
  papel: PapelDaEtapa;
}> = [
  { name: 'Fechado', slug: 'fechado', color: '#F0A532', papel: 'fechamento' },
  { name: 'Perdido', slug: 'perdido', color: '#E5484D', papel: 'perda' },
];

export const MENSAGEM_ETAPA_FIXA = 'Esta etapa é fixa do funil';

/** O que basta pra criar etapas: serve tanto pro client quanto pra um `tx`. */
type DbComTags = Pick<Prisma.TransactionClient, 'tag'>;

/**
 * Garante Fechado e Perdido no funil (criação de funil, conta nova, seed).
 * Só cria o que falta, pelo papel — não duplica se já houver. O slug é único
 * por conta, então o segundo funil da conta leva o sufixo do próprio funil.
 */
export async function criarEtapasFixas(
  db: DbComTags,
  accountId: string,
  funnelId: string,
  funnelSlug: string
) {
  const criadas = [];
  for (const fixa of ETAPAS_FIXAS) {
    const jaTem = await db.tag.findFirst({
      where: { funnelId, papel: fixa.papel },
      select: { id: true },
    });
    if (jaTem) continue;

    const ultima = await db.tag.findFirst({
      where: { funnelId, type: 'stage' },
      orderBy: { ordem: 'desc' },
      select: { ordem: true },
    });

    let slug = fixa.slug;
    if (await db.tag.findFirst({ where: { accountId, slug }, select: { id: true } })) {
      slug = `${fixa.slug}-${funnelSlug}`;
    }
    if (await db.tag.findFirst({ where: { accountId, slug }, select: { id: true } })) {
      slug = `${slug}-${Date.now()}`;
    }

    criadas.push(
      await db.tag.create({
        data: {
          accountId,
          funnelId,
          name: fixa.name,
          slug,
          type: 'stage',
          color: fixa.color,
          ordem: (ultima?.ordem ?? -1) + 1,
          papel: fixa.papel,
        },
      })
    );
  }
  return criadas;
}

export interface CreateTagInput {
  accountId: string;
  funnelId: string;
  name: string;
  type: TagType;
  color?: string;
}

/**
 * `papel` fica de fora de propósito: a etapa fixa pode mudar de nome e cor,
 * nunca de papel — é o papel que o gatilho da venda procura.
 */
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
    let ordem = (maxOrdem?.ordem ?? -1) + 1;

    // ETAPA B — etapa nova entra ANTES das fixas: Fechado e Perdido encerram
    // o funil, então tudo que vier depois delas não faz sentido no Kanban.
    // Abre espaço empurrando a primeira fixa (e o que estiver atrás dela).
    if (input.type === 'stage') {
      const primeiraFixa = await prisma.tag.findFirst({
        where: { funnelId: input.funnelId, type: 'stage', papel: { not: null } },
        orderBy: { ordem: 'asc' },
        select: { ordem: true },
      });
      if (primeiraFixa) {
        ordem = primeiraFixa.ordem;
        await prisma.tag.updateMany({
          where: { funnelId: input.funnelId, type: 'stage', ordem: { gte: ordem } },
          data: { ordem: { increment: 1 } },
        });
      }
    }

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
        ordem,
      },
    });

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

    // ETAPA B — Fechado e Perdido não se apagam, nem com force: sem elas o
    // funil não tem onde registrar venda nem perda.
    if (tag.papel) {
      throw new ConflictError(MENSAGEM_ETAPA_FIXA, { tagId: id, papel: tag.papel });
    }

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
    const existente = await this.getById(id, accountId);
    if (existente.papel) {
      throw new ValidationError(MENSAGEM_ETAPA_FIXA, { tagId: id, papel: existente.papel });
    }

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
    // ISOLAMENTO ENTRE CONTAS (achado de auditoria): este endpoint recebe os
    // ids pelo corpo da requisição, e o `where: { id }` puro escreve em
    // QUALQUER tag do banco. Um admin reordenava o funil de outro cliente só
    // mandando os ids dele. A conferência abaixo é o que fecha isso, e as
    // escritas repetem o accountId como segunda barreira — se um dia alguém
    // mexer aqui e furar a conferência, a escrita ainda não atravessa.
    const proprias = await prisma.tag.findMany({
      where: { id: { in: tagIds }, accountId },
      select: { id: true, ordem: true, papel: true },
    });
    // Lote inteiro ou nada: aprovar só as próprias deixaria a reordenação pela
    // metade, que é pior que recusar — o funil ficaria num estado que o usuário
    // não pediu.
    if (proprias.length !== new Set(tagIds).size) {
      throw new NotFoundError('Uma ou ambas as tags não foram encontradas');
    }
    const ordemPorId = new Map(proprias.map((t) => [t.id, t.ordem]));
    const papelPorId = new Map(proprias.map((t) => [t.id, t.papel]));

    if (tagIds.length === 2) {
      // ETAPA B — trocar de lugar com uma fixa a tiraria do fim do funil.
      if (tagIds.some((id) => papelPorId.get(id))) {
        throw new ValidationError(MENSAGEM_ETAPA_FIXA, { tagIds });
      }
      // Swap mode: exchange ordem values between the two tags
      const [id1, id2] = tagIds;
      await prisma.$transaction([
        prisma.tag.updateMany({
          where: { id: id1, accountId },
          data: { ordem: ordemPorId.get(id2)! },
        }),
        prisma.tag.updateMany({
          where: { id: id2, accountId },
          data: { ordem: ordemPorId.get(id1)! },
        }),
      ]);
    } else {
      // Full reorder: assign ordem based on array position.
      // ETAPA B — as fixas vão pro fim seja qual for a posição em que
      // chegaram, Fechado antes de Perdido.
      const pesoDoPapel = (id: string) => {
        const papel = papelPorId.get(id);
        if (papel === 'fechamento') return 1;
        if (papel === 'perda') return 2;
        return 0;
      };
      const ordenadas = [...tagIds].sort((a, b) => pesoDoPapel(a) - pesoDoPapel(b));
      await prisma.$transaction(
        ordenadas.map((id, index) =>
          prisma.tag.updateMany({
            where: { id, accountId },
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
      papel: tag.papel,
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
   * @deprecated REMOVED — sync de labels externos foi descontinuado.
   * Mantido como stub para não quebrar a rota POST /tags/sync-labels.
   */
  async syncAllLabels(_accountId: string) {
    return {
      synced: 0,
      failed: 0,
      details: [] as Array<{ tagId: string; tagName: string; slug: string; labelId?: number; error?: string }>,
      // BUG-035: removido "(FitPark)" do payload exposto — brand legado.
      deprecated: 'REMOVED — sync de labels externos foi descontinuado.',
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

    // ETAPA B — funil já nasce com Fechado e Perdido, na mesma transação:
    // um funil sem etapa de fechamento não tem onde registrar venda.
    const funnel = await prisma.$transaction(async (tx) => {
      const criado = await tx.funnel.create({
        data: {
          accountId,
          name,
          slug,
        },
      });
      await criarEtapasFixas(tx, accountId, criado.id, criado.slug);
      return criado;
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
