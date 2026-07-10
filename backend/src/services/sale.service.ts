import { prisma } from '../config/database';
import { PaymentMethod, SaleStatus } from '@prisma/client';
import { PaginationParams, DateRangeFilter } from '../types';
import { NotFoundError, ValidationError, ErrorCodes } from '../utils/errors';
import { getPaginationMeta } from '../utils/helpers';
import { eventService } from './event.service';

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

    return this.getById(id, accountId);
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
