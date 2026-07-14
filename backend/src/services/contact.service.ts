import { prisma } from '../config/database';
import { ContactOrigin } from '@prisma/client';
import { PaginationParams } from '../types';
import { ConflictError, NotFoundError, ValidationError, ErrorCodes } from '../utils/errors';
import { getPaginationMeta, escapeLike } from '../utils/helpers';
import { eventService } from './event.service';
import { webhookOutboundService } from './webhook-outbound.service';

export interface CreateContactInput {
  accountId: string;
  nome?: string;
  telefone?: string;
  email?: string;
  origem?: ContactOrigin;
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
      // T1-ILIKE-WILDCARD: escapa `%` e `_` para evitar que um termo de busca
      // como `%` retorne TODOS os registros via wildcard SQL não-intencional.
      const safeSearch = escapeLike(filters.search);
      where.OR = [
        { nome: { contains: safeSearch, mode: 'insensitive' } },
        { email: { contains: safeSearch, mode: 'insensitive' } },
        { telefone: { contains: safeSearch } },
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

    // PLANO-INTEGRACOES §3.3: evento era FANTASMA (UI oferecia, nunca
    // disparava). Fire-and-forget: falha de webhook não quebra o create.
    webhookOutboundService
      .emit(input.accountId, 'contact.created', {
        id: contact.id,
        nome: contact.nome,
        telefone: contact.telefone,
        email: contact.email,
        origem: contact.origem,
        createdAt: contact.createdAt,
      })
      .catch(() => undefined);

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

    // PLANO-INTEGRACOES §3.3: evento era FANTASMA.
    webhookOutboundService
      .emit(contact.accountId, 'contact.updated', {
        id: contact.id,
        nome: contact.nome,
        telefone: contact.telefone,
        email: contact.email,
        updatedAt: contact.updatedAt,
      })
      .catch(() => undefined);

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
   *
   * T1-APPLYTAG-RACE: as 4 escritas (delete stage tags antigas, create leadTag novo,
   * tagHistory para cada delete e tagHistory do create) precisam ser atômicas.
   * Antes ficavam fora de transação — 5 POSTs paralelos batiam o unique
   * `(contactId, tagId)` do LeadTag entre o findUnique e o create, retornando
   * 500 (P2002). Agora a janela é estreita pra dentro da $transaction; em
   * caso de corrida residual, o P2002 vira ConflictError (HTTP 409) — o
   * caller (Kanban) recebe um erro semântico em vez de 500.
   */
  async applyTag(
    id: string,
    accountId: string,
    tagId: string,
    source: 'kanban' | 'system' | 'api',
    appliedById?: string,
    options?: {
      reason?: string;
      apiKeyId?: string;
    }
  ) {
    const contact = await this.getById(id, accountId);

    // Get the tag (read fora da transação — é imutável dentro do tempo de vida da operação)
    const tag = await prisma.tag.findUnique({
      where: { id: tagId },
    });

    if (!tag || tag.accountId !== accountId) {
      throw new NotFoundError('Tag');
    }

    // T1-APPLYTAG-RACE-FIX (BUG 8): com 5 POSTs paralelos em stages diferentes
    // no MESMO lead, cada transaction lia "from" snapshot estática e ao final
    // ficavam todas as N stages aplicadas (violação do invariante kanban:
    // 1 lead = 1 stage) e/ou alguns requests retornavam 404 (P2025 do delete
    // após outra transação já ter removido a linha) em vez de 409/200.
    //
    // Fix em duas frentes:
    //   (a) Serializar pelo contactId via pg_advisory_xact_lock(int8). O hash
    //       é determinístico (hashtext()) e o lock vive só pela transação,
    //       então 5 requests concorrentes no mesmo lead viram fila — "último
    //       a chegar vence" como o brief exige.
    //   (b) Mapear tanto P2002 (unique violation no leadTag.create) quanto
    //       P2025 (RecordNotFound no leadTag.delete) para ConflictError 409,
    //       já que ambos só ocorrem em corrida residual após o lock liberar.
    //
    // O escopo do advisory lock é (accountId, contactId) — não bloqueia outros
    // tenants nem outros leads do mesmo tenant.
    //
    // Para chamadas via API key (source='api' + options.apiKeyId), o actor é
    // gravado como external/<apiKeyId> em vez de system/null, atendendo ao
    // requisito de rastreabilidade do BUG 11.
    const actorType: 'user' | 'external' | 'system' = appliedById
      ? 'user'
      : options?.apiKeyId
        ? 'external'
        : 'system';
    const actorId: string | undefined = appliedById ?? options?.apiKeyId ?? undefined;
    const reason = options?.reason ?? null;

    try {
      await prisma.$transaction(async (tx) => {
        // (a) Advisory lock pelo contactId — serializa concorrência neste lead.
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          id
        );

        // If it's a stage tag, remove other stage tags first (mesma transação).
        if (tag.type === 'stage') {
          const existingStageTags = await tx.leadTag.findMany({
            where: {
              contactId: id,
              tag: { type: 'stage' },
              NOT: { tagId },
            },
            include: { tag: true },
          });

          for (const existing of existingStageTags) {
            await tx.leadTag.delete({
              where: { id: existing.id },
            });

            await tx.tagHistory.create({
              data: {
                contactId: id,
                tagId: existing.tagId,
                action: 'removed',
                actorType,
                actorId,
                source,
                reason,
                tagName: existing.tag.name,
                contactNome: contact.nome,
              },
            });
          }
        }

        // Check if tag is already applied
        const existingLeadTag = await tx.leadTag.findUnique({
          where: {
            contactId_tagId: { contactId: id, tagId },
          },
        });

        if (existingLeadTag) {
          return; // Tag already applied — idempotente
        }

        // Apply the tag
        await tx.leadTag.create({
          data: {
            contactId: id,
            tagId,
            appliedByType: appliedById ? 'user' : 'system',
            appliedById,
            source,
          },
        });

        // Record history
        await tx.tagHistory.create({
          data: {
            contactId: id,
            tagId,
            action: 'added',
            actorType,
            actorId,
            source,
            reason,
            tagName: tag.name,
            contactNome: contact.nome,
          },
        });
      });
    } catch (err: any) {
      // T1-APPLYTAG-RACE: corrida residual entre transações concorrentes que
      // criem a MESMA (contactId, tagId) — Postgres rejeita a segunda com
      // P2002 (unique violation). Em vez de devolver 500, traduzimos pra 409:
      // a tag já foi aplicada por outra request paralela, então o efeito
      // semântico está garantido.
      //
      // P2025 (RecordNotFound) também pode acontecer em corrida residual com
      // delete em LeadTag — outra request já apagou a linha antes desta. O
      // estado final pretendido (essa stage NÃO presente) já está satisfeito,
      // então também devolvemos 409 (e não 404, que confundiria o caller).
      if (err?.code === 'P2002' || err?.code === 'P2025') {
        throw new ConflictError(
          'Concorrência detectada ao aplicar tag — tente novamente',
          { contactId: id, tagId, prismaCode: err.code }
        );
      }
      throw err;
    }

    await eventService.create({
      eventType: tag.type === 'stage' ? 'lead.stage.changed' : 'lead.tag.added',
      accountId,
      actorType,
      actorId,
      entityType: 'contact',
      entityId: id,
      payload: {
        tagId,
        tagName: tag.name,
        source,
        ...(reason ? { reason } : {}),
        ...(options?.apiKeyId ? { apiKeyId: options.apiKeyId } : {}),
      },
    });

    return this.getById(id, accountId);
  }

  /**
   * Remove tag from contact
   */
  async removeTag(
    id: string,
    accountId: string,
    tagId: string,
    source: 'kanban' | 'system' | 'api',
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
   * Query contacts for external API consumers (e.g. n8n).
   * Supports birthday, tag, stage, last-activity and custom-attribute filters.
   *
   * NOTE: Several filters depend on fields that don't exist in the current
   * Contact model — they are skipped here and tracked as TODOs below.
   */
  async queryForApi(
    accountId: string,
    filters: {
      aniversario?: 'today' | 'tomorrow' | string;
      tag?: string | string[];
      stage?: string;
      lastFollowupBefore?: Date;
      lastFollowupAfter?: Date;
      customAttribute?: Record<string, string>;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ data: any[]; total: number }> {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);

    const where: any = { accountId };
    const andConditions: any[] = [];

    // --- Tag filter (slug or id, single or array) ---
    if (filters.tag) {
      const tagValues = Array.isArray(filters.tag) ? filters.tag : [filters.tag];
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const tagIds = tagValues.filter(v => uuidRegex.test(v));
      const tagSlugs = tagValues.filter(v => !uuidRegex.test(v));

      const tagOr: any[] = [];
      if (tagIds.length > 0) tagOr.push({ tagId: { in: tagIds } });
      if (tagSlugs.length > 0) tagOr.push({ tag: { slug: { in: tagSlugs }, accountId } });

      if (tagOr.length > 0) {
        andConditions.push({
          leadTags: { some: { OR: tagOr } },
        });
      }
    }

    // --- Stage filter (slug or id of a tag with type='stage') ---
    if (filters.stage) {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const stageWhere: any = { type: 'stage', accountId };
      if (uuidRegex.test(filters.stage)) {
        stageWhere.id = filters.stage;
      } else {
        stageWhere.slug = filters.stage;
      }
      andConditions.push({
        leadTags: { some: { tag: stageWhere } },
      });
    }

    // --- Last followup filters ---
    // Filtra pelo campo lastFollowupAt do Contact. Nome explícito para deixar
    // claro aos consumidores externos (n8n) que NÃO inclui qualquer atividade
    // (mensagem inbound, mudança de stage etc.), apenas follow-ups registrados.
    if (filters.lastFollowupBefore || filters.lastFollowupAfter) {
      const followupRange: any = {};
      if (filters.lastFollowupBefore) followupRange.lt = filters.lastFollowupBefore;
      if (filters.lastFollowupAfter) followupRange.gt = filters.lastFollowupAfter;
      andConditions.push({ lastFollowupAt: followupRange });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    // --- Aniversário filter ---
    // TODO: campo dataNascimento não existe ainda — adicionar em Sprint futuro.
    // Até lá, rejeitamos explicitamente (HTTP 400) em vez de ignorar silenciosamente,
    // para evitar resultados enganosos para consumidores externos (n8n).
    if (filters.aniversario) {
      throw new ValidationError(
        'Filtro aniversário não suportado: schema Contact não tem dataNascimento. Será implementado em sprint futuro.'
      );
    }

    // --- Custom attribute filter ---
    // TODO: campo customAttributes (jsonb) não existe ainda — adicionar em Sprint futuro.
    if (filters.customAttribute && Object.keys(filters.customAttribute).length > 0) {
      throw new ValidationError(
        'Filtro customAttribute não suportado: schema Contact não tem customAttributes.'
      );
    }

    const [contacts, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          leadTags: {
            include: {
              tag: {
                select: { id: true, name: true, slug: true, color: true, type: true },
              },
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
        leadTags: undefined,
      })),
      total,
    };
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
