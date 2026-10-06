import { prisma } from '../config/database';
import { PaymentMethod, SaleStatus } from '@prisma/client';
import { PaginationParams, DateRangeFilter } from '../types';
import { NotFoundError, ValidationError, ErrorCodes } from '../utils/errors';
import { getPaginationMeta, isValidUUID } from '../utils/helpers';
import { logger } from '../utils/logger';
import { eventService } from './event.service';
import { trackingService } from './tracking.service';
import { webhookOutboundService } from './webhook-outbound.service';

/** ETAPA B — marca da venda que nasceu do lead entrar na etapa de fechamento. */
export const ORIGEM_FECHAMENTO = 'fechamento';

export interface RegistrarFechamentoInput {
  accountId: string;
  contactId: string;
  /** Quanto fechou. Ausente/0 = fechou sem informar valor (venda pendente). */
  valor?: number | null;
  /** Serviço escolhido, se o usuário escolheu um. */
  productId?: string | null;
  /**
   * Quem moveu o lead. Pode ser um usuário, um sentinela (`flow:<id>`,
   * `api:<id>`) ou nada — a venda exige um responsável de verdade, então quem
   * não é usuário da conta cai no primeiro admin ativo dela.
   */
  responsavelId?: string | null;
  /** De onde veio o movimento (kanban, chat, flow, api...). Só vai pro evento. */
  source: string;
}

export interface ResultadoDoFechamento {
  sale: {
    id: string;
    contactId: string;
    valor: number;
    status: SaleStatus;
    paidAt: Date | null;
    createdAt: Date;
  };
  /** false = já havia venda pendente deste fechamento e nada foi criado. */
  criada: boolean;
}

export interface CreateSaleItemInput {
  productId: string;
  quantidade: number;
  valorUnitario: number;
}

export interface CreateSaleInput {
  accountId: string;
  contactId: string;
  metodoPagamento: PaymentMethod;
  convenioNome?: string;
  responsavelId: string;
  items: CreateSaleItemInput[];
}

export interface SaleFilters extends DateRangeFilter {
  accountId: string;
  contactId?: string;
  status?: SaleStatus;
  responsavelId?: string;
  metodoPagamento?: PaymentMethod;
}

class SaleService {
  /**
   * List sales with filters
   */
  async list(filters: SaleFilters, pagination: PaginationParams) {
    const where: any = {
      accountId: filters.accountId,
    };

    if (filters.contactId) {
      where.contactId = filters.contactId;
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.responsavelId) {
      where.responsavelId = filters.responsavelId;
    }

    if (filters.metodoPagamento) {
      where.metodoPagamento = filters.metodoPagamento;
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

    const [sales, total] = await Promise.all([
      prisma.sale.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.offset,
        take: pagination.limit,
        include: {
          contact: {
            select: { id: true, nome: true, telefone: true },
          },
          responsavel: {
            select: { id: true, nome: true },
          },
          items: {
            include: {
              product: {
                select: { id: true, nome: true },
              },
            },
          },
        },
      }),
      prisma.sale.count({ where }),
    ]);

    return {
      data: sales.map(s => ({
        ...s,
        valor: Number(s.valor),
        items: s.items.map(i => ({
          ...i,
          valorUnitario: Number(i.valorUnitario),
          valorTotal: Number(i.valorTotal),
        })),
      })),
      meta: getPaginationMeta(total, pagination),
    };
  }

  /**
   * Get sale by ID
   */
  async getById(id: string, accountId?: string) {
    const where: any = { id };
    if (accountId) {
      where.accountId = accountId;
    }

    const sale = await prisma.sale.findFirst({
      where,
      include: {
        contact: {
          select: { id: true, nome: true, telefone: true, email: true },
        },
        responsavel: {
          select: { id: true, nome: true, email: true },
        },
        refundedBy: {
          select: { id: true, nome: true },
        },
        items: {
          include: {
            product: {
              select: { id: true, nome: true },
            },
          },
        },
      },
    });

    if (!sale) {
      throw new NotFoundError('Venda');
    }

    return {
      ...sale,
      valor: Number(sale.valor),
      items: sale.items.map(i => ({
        ...i,
        valorUnitario: Number(i.valorUnitario),
        valorTotal: Number(i.valorTotal),
      })),
    };
  }

  /**
   * Create a new sale
   */
  async create(input: CreateSaleInput, createdById: string) {
    // Validate contact exists
    const contact = await prisma.contact.findFirst({
      where: { id: input.contactId, accountId: input.accountId },
    });

    if (!contact) {
      throw new NotFoundError('Contato');
    }

    // Validate products exist
    for (const item of input.items) {
      const product = await prisma.product.findFirst({
        where: { id: item.productId, accountId: input.accountId },
      });

      if (!product) {
        throw new NotFoundError(`Produto ${item.productId}`);
      }
    }

    // Check for recurring sale (scoped to account).
    // T2-RECURRING-SOMEEVERY: marcamos como recorrente apenas quando TODOS os
    // produtos da venda atual já foram comprados antes pelo mesmo contato
    // (vendas mistas com pelo menos 1 produto novo NÃO devem ser recorrentes).
    const productIds = input.items.map(i => i.productId);

    let isRecurring = false;

    if (productIds.length > 0) {
      const previouslyPurchased = await prisma.saleItem.findMany({
        where: {
          productId: { in: productIds },
          sale: {
            accountId: input.accountId,
            contactId: input.contactId,
          },
        },
        select: { productId: true },
        distinct: ['productId'],
      });

      const purchasedSet = new Set(previouslyPurchased.map(p => p.productId));
      isRecurring = productIds.every(pid => purchasedSet.has(pid));
    }

    // Calculate total value
    const totalValue = input.items.reduce(
      (sum, item) => sum + item.quantidade * item.valorUnitario,
      0
    );

    // Create sale with items
    const sale = await prisma.sale.create({
      data: {
        accountId: input.accountId,
        contactId: input.contactId,
        valor: totalValue,
        metodoPagamento: input.metodoPagamento,
        convenioNome: input.convenioNome,
        responsavelId: input.responsavelId,
        isRecurring,
        items: {
          create: input.items.map(item => ({
            productId: item.productId,
            quantidade: item.quantidade,
            valorUnitario: item.valorUnitario,
            valorTotal: item.quantidade * item.valorUnitario,
          })),
        },
      },
      include: {
        items: {
          include: {
            product: { select: { id: true, nome: true } },
          },
        },
        contact: { select: { id: true, nome: true } },
      },
    });

    await eventService.create({
      eventType: 'sale.created',
      accountId: input.accountId,
      actorType: 'user',
      actorId: createdById,
      entityType: 'sale',
      entityId: sale.id,
      payload: {
        contactId: sale.contactId,
        valor: Number(sale.valor),
        items: sale.items.length,
        isRecurring,
      },
    });

    return {
      ...sale,
      valor: Number(sale.valor),
      items: sale.items.map(i => ({
        ...i,
        valorUnitario: Number(i.valorUnitario),
        valorTotal: Number(i.valorTotal),
      })),
    };
  }

  /**
   * Mark sale as paid
   */
  async markPaid(id: string, accountId: string, paidById: string) {
    const sale = await this.getById(id, accountId);

    if (sale.status !== 'pending') {
      throw new ValidationError('Venda já foi paga ou estornada');
    }

    const updatedSale = await prisma.sale.update({
      where: { id },
      data: {
        status: 'paid',
        paidAt: new Date(),
      },
    });

    await eventService.create({
      eventType: 'sale.paid',
      accountId,
      actorType: 'user',
      actorId: paidById,
      entityType: 'sale',
      entityId: id,
      payload: { valor: Number(updatedSale.valor) },
    });

    this.aposPagamento(accountId, updatedSale);

    return this.getById(id, accountId);
  }

  /**
   * O que acontece depois que uma venda vira paga, venha do Financeiro
   * (markPaid) ou do Kanban (registrarFechamento): webhook `sale.paid` e o
   * evento 'Purchase' pro Tracking. Os dois são best-effort — nunca lançam,
   * nunca seguram o pagamento.
   */
  private aposPagamento(
    accountId: string,
    sale: { id: string; contactId: string; valor: unknown; paidAt: Date | null }
  ) {
    // PLANO-INTEGRACOES §3.3: sale.paid era FANTASMA (UI oferecia, nunca
    // disparava). Fire-and-forget: falha de webhook não quebra o pagamento.
    webhookOutboundService
      .emit(accountId, 'sale.paid', {
        id: sale.id,
        contactId: sale.contactId,
        valor: Number(sale.valor),
        paidAt: sale.paidAt,
      })
      .catch(() => undefined);

    // TRACKING-CTWA: venda paga de contato vindo de anúncio → 'Purchase'
    // com valor pra Meta (CAPI). Best-effort, nunca lança.
    if (sale.contactId) {
      void trackingService
        .resolveCtwaForContact(accountId, sale.contactId)
        .then((ctwa) => {
          if (!ctwa) return;
          return trackingService.recordConversionEvent({
            accountId,
            eventName: 'Purchase',
            ctwaClid: ctwa.ctwaClid,
            conversationId: ctwa.conversationId,
            contactId: sale.contactId,
            value: Number(sale.valor),
            currency: 'BRL',
            sourceType: 'sale',
            sourceId: sale.id,
          });
        })
        .catch(() => undefined);
    }
  }

  /**
   * Quem assina a venda. Sale.responsavelId é FK pra User, então um sentinela
   * de fluxo/API ou um usuário de outra conta não serve — cai no primeiro
   * admin ativo da conta. Sem admin ativo não há como gravar a venda.
   */
  private async resolverResponsavel(
    accountId: string,
    candidato?: string | null
  ): Promise<{ id: string; ehQuemMoveu: boolean } | null> {
    if (candidato && isValidUUID(candidato)) {
      const usuario = await prisma.user.findFirst({
        where: { id: candidato, accountId },
        select: { id: true },
      });
      if (usuario) return { id: usuario.id, ehQuemMoveu: true };
    }
    const admin = await prisma.user.findFirst({
      where: { accountId, role: 'admin', status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return admin ? { id: admin.id, ehQuemMoveu: false } : null;
  }

  /**
   * ETAPA B — o lead entrou na etapa de fechamento (ou o usuário informou o
   * valor depois). É o único caminho pelo qual o Kanban/agente registra venda.
   *
   * Regras:
   * - sem valor: cria Sale pending (valor 0, origem 'fechamento'), sem evento
   *   de Purchase. Se já há uma pendente deste fechamento, não cria outra —
   *   o lead que sai e volta da etapa não duplica venda.
   * - com valor: completa a pendente (valor, paid, paidAt) ou cria uma já
   *   paga se não houver; dispara webhook + Purchase (valor + moeda).
   * - item só quando há produto: SaleItem exige product_id (FK), então o
   *   fechamento sem serviço escolhido fica só no Sale.valor.
   *
   * Funciona com o módulo `vendas` desligado: é service, não rota.
   */
  async registrarFechamento(input: RegistrarFechamentoInput): Promise<ResultadoDoFechamento | null> {
    const { accountId, contactId } = input;

    const contact = await prisma.contact.findFirst({
      where: { id: contactId, accountId },
      select: { id: true },
    });
    if (!contact) throw new NotFoundError('Contato');

    const valorInformado = Number(input.valor ?? 0);
    if (!Number.isFinite(valorInformado) || valorInformado < 0) {
      throw new ValidationError('Valor do fechamento inválido');
    }
    const valor = valorInformado > 0 ? Math.round(valorInformado * 100) / 100 : 0;

    let productId: string | null = null;
    if (input.productId) {
      const product = await prisma.product.findFirst({
        where: { id: input.productId, accountId },
        select: { id: true },
      });
      if (!product) throw new NotFoundError('Produto');
      productId = product.id;
    }

    const responsavel = await this.resolverResponsavel(accountId, input.responsavelId);
    if (!responsavel) {
      logger.warn('[sale] fechamento sem responsável possível — conta sem admin ativo', {
        accountId,
        contactId,
      });
      return null;
    }
    const ator = responsavel.ehQuemMoveu
      ? { actorType: 'user' as const, actorId: responsavel.id }
      : { actorType: 'system' as const };

    const pendente = await prisma.sale.findFirst({
      where: { accountId, contactId, origem: ORIGEM_FECHAMENTO, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, contactId: true, valor: true, status: true, paidAt: true, createdAt: true },
    });

    const itemDoProduto = (unitario: number) =>
      productId
        ? { create: [{ productId, quantidade: 1, valorUnitario: unitario, valorTotal: unitario }] }
        : undefined;

    // ---- sem valor: pendente, idempotente ----
    if (valor === 0) {
      if (pendente) {
        return { sale: { ...pendente, valor: Number(pendente.valor) }, criada: false };
      }
      const sale = await prisma.sale.create({
        data: {
          accountId,
          contactId,
          valor: 0,
          status: 'pending',
          metodoPagamento: 'nao_informado',
          responsavelId: responsavel.id,
          origem: ORIGEM_FECHAMENTO,
          items: itemDoProduto(0),
        },
      });
      await eventService.create({
        eventType: 'sale.created',
        accountId,
        ...ator,
        entityType: 'sale',
        entityId: sale.id,
        payload: { contactId, valor: 0, origem: ORIGEM_FECHAMENTO, source: input.source, pendente: true },
      });
      return { sale: { ...sale, valor: 0 }, criada: true };
    }

    // ---- com valor: completa a pendente ou cria paga ----
    const agora = new Date();
    let sale;
    if (pendente) {
      sale = await prisma.$transaction(async (tx) => {
        // O serviço escolhido agora vence o que foi guardado na pendente.
        if (productId) await tx.saleItem.deleteMany({ where: { saleId: pendente.id } });
        else await tx.saleItem.updateMany({
          where: { saleId: pendente.id },
          data: { valorUnitario: valor, valorTotal: valor },
        });
        return tx.sale.update({
          where: { id: pendente.id },
          data: { valor, status: 'paid', paidAt: agora, items: itemDoProduto(valor) },
        });
      });
    } else {
      sale = await prisma.sale.create({
        data: {
          accountId,
          contactId,
          valor,
          status: 'paid',
          paidAt: agora,
          metodoPagamento: 'nao_informado',
          responsavelId: responsavel.id,
          origem: ORIGEM_FECHAMENTO,
          items: itemDoProduto(valor),
        },
      });
      await eventService.create({
        eventType: 'sale.created',
        accountId,
        ...ator,
        entityType: 'sale',
        entityId: sale.id,
        payload: { contactId, valor, origem: ORIGEM_FECHAMENTO, source: input.source },
      });
    }

    await eventService.create({
      eventType: 'sale.paid',
      accountId,
      ...ator,
      entityType: 'sale',
      entityId: sale.id,
      payload: { valor, origem: ORIGEM_FECHAMENTO, source: input.source },
    });

    this.aposPagamento(accountId, sale);

    return { sale: { ...sale, valor: Number(sale.valor) }, criada: !pendente };
  }

  /**
   * Refund entire sale
   */
  async refund(id: string, accountId: string, reason: string, refundedById: string) {
    const sale = await this.getById(id, accountId);

    if (sale.status === 'refunded') {
      throw new ValidationError(ErrorCodes.SALE_ALREADY_REFUNDED);
    }

    // Mark all items as refunded
    await prisma.saleItem.updateMany({
      where: { saleId: id },
      data: {
        refunded: true,
        refundedAt: new Date(),
        refundReason: reason,
      },
    });

    const updatedSale = await prisma.sale.update({
      where: { id },
      data: {
        status: 'refunded',
        refundedAt: new Date(),
        refundReason: reason,
        refundedById,
      },
    });

    await eventService.create({
      eventType: 'sale.refunded',
      accountId,
      actorType: 'user',
      actorId: refundedById,
      entityType: 'sale',
      entityId: id,
      payload: { valor: Number(updatedSale.valor), reason },
    });

    return this.getById(id, accountId);
  }

  /**
   * Refund single item
   */
  async refundItem(
    saleId: string,
    itemId: string,
    accountId: string,
    reason: string,
    refundedById: string
  ) {
    const sale = await this.getById(saleId, accountId);
    const item = sale.items.find(i => i.id === itemId);

    if (!item) {
      throw new NotFoundError('Item');
    }

    if (item.refunded) {
      throw new ValidationError(ErrorCodes.ITEM_ALREADY_REFUNDED);
    }

    // AUDIT-REFUND-TX: operação financeira em 3 passos era não-atômica —
    // crash entre os updates deixava item refunded com status da venda
    // incoerente, e dois estornos concorrentes podiam ambos ler
    // nonRefundedItems>0 e gravar 'partial_refund' com tudo estornado.
    // Transação + lock pessimista da venda (FOR UPDATE) serializa.
    await prisma.$transaction(async (tx) => {
      // Lock da venda: estornos concorrentes da mesma venda enfileiram aqui.
      await tx.$queryRaw`SELECT id FROM sales WHERE id = ${saleId}::uuid FOR UPDATE`;

      await tx.saleItem.update({
        where: { id: itemId },
        data: {
          refunded: true,
          refundedAt: new Date(),
          refundReason: reason,
        },
      });

      const nonRefundedItems = await tx.saleItem.count({
        where: { saleId, refunded: false },
      });

      const newStatus: SaleStatus =
        nonRefundedItems === 0 ? 'refunded' : 'partial_refund';

      await tx.sale.update({
        where: { id: saleId },
        data: {
          status: newStatus,
          ...(newStatus === 'refunded' ? {
            refundedAt: new Date(),
            refundReason: reason,
            refundedById,
          } : {}),
        },
      });
    });

    await eventService.create({
      eventType: 'sale.item.refunded',
      accountId,
      actorType: 'user',
      actorId: refundedById,
      entityType: 'sale',
      entityId: saleId,
      payload: {
        itemId,
        productId: item.productId,
        valor: item.valorTotal,
        reason,
      },
    });

    return this.getById(saleId, accountId);
  }

  /**
   * Get sales KPIs
   */
  async getKPIs(
    accountId: string,
    filters: DateRangeFilter,
    extraFilters: { responsavelId?: string; metodoPagamento?: PaymentMethod } | string = {}
  ) {
    // Backwards-compat: o controller antigo passava `responsavelId` direto como string.
    const normalized: { responsavelId?: string; metodoPagamento?: PaymentMethod } =
      typeof extraFilters === 'string'
        ? { responsavelId: extraFilters }
        : extraFilters || {};

    const where: any = { accountId };

    if (normalized.responsavelId) {
      where.responsavelId = normalized.responsavelId;
    }

    if (normalized.metodoPagamento) {
      where.metodoPagamento = normalized.metodoPagamento;
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

    const [
      totalSales,
      paidSales,
      pendingSales,
      refundedSales,
      totalRevenue,
      avgTicket,
    ] = await Promise.all([
      prisma.sale.count({ where }),
      prisma.sale.count({ where: { ...where, status: 'paid' } }),
      prisma.sale.count({ where: { ...where, status: 'pending' } }),
      prisma.sale.count({ where: { ...where, status: { in: ['refunded', 'partial_refund'] } } }),
      prisma.sale.aggregate({
        where: { ...where, status: 'paid' },
        _sum: { valor: true },
      }),
      prisma.sale.aggregate({
        where: { ...where, status: 'paid' },
        _avg: { valor: true },
      }),
    ]);

    return {
      totalSales,
      paidSales,
      pendingSales,
      refundedSales,
      totalRevenue: Number(totalRevenue._sum.valor || 0),
      avgTicket: Number(avgTicket._avg.valor || 0),
      conversionRate: totalSales > 0 ? (paidSales / totalSales) * 100 : 0,
    };
  }

  /**
   * Get refund audit log
   */
  async getAuditLog(accountId: string, filters: DateRangeFilter, pagination: PaginationParams) {
    const where: any = {
      accountId,
      eventType: { in: ['sale.refunded', 'sale.item.refunded'] },
    };

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
            select: { id: true, nome: true },
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
}

export const saleService = new SaleService();
