import { prisma } from '../config/database';
import { PaginationParams } from '../types';
import { NotFoundError, ValidationError, ErrorCodes } from '../utils/errors';
import { getPaginationMeta } from '../utils/helpers';
import { eventService } from './event.service';

export interface CreateProductInput {
  accountId: string;
  nome: string;
  valorPadrao: number;
  metodosPagamento?: string[];
  conveniosAceitos?: string[];
}

export interface UpdateProductInput {
  nome?: string;
  valorPadrao?: number;
  metodosPagamento?: string[];
  conveniosAceitos?: string[];
  ativo?: boolean;
}

export interface ProductFilters {
  accountId: string;
  search?: string;
  ativo?: boolean;
}

class ProductService {
  /**
   * List products with filters
   */
  async list(filters: ProductFilters, pagination: PaginationParams) {
    const where: any = {
      accountId: filters.accountId,
    };

    if (filters.search) {
      where.nome = { contains: filters.search, mode: 'insensitive' };
    }

    if (filters.ativo !== undefined) {
      where.ativo = filters.ativo;
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { nome: 'asc' },
        skip: pagination.offset,
        take: pagination.limit,
        include: {
          _count: {
            select: { saleItems: true },
          },
        },
      }),
      prisma.product.count({ where }),
    ]);

    return {
      data: products.map(p => ({
        ...p,
        valorPadrao: Number(p.valorPadrao),
        salesCount: p._count.saleItems,
        _count: undefined,
      })),
      meta: getPaginationMeta(total, pagination),
    };
  }

  /**
   * Get product by ID
   */
  async getById(id: string, accountId?: string) {
    const where: any = { id };
    if (accountId) {
      where.accountId = accountId;
    }

    const product = await prisma.product.findFirst({
      where,
      include: {
        _count: {
          select: { saleItems: true },
        },
      },
    });

    if (!product) {
      throw new NotFoundError('Produto');
    }

    return {
      ...product,
      valorPadrao: Number(product.valorPadrao),
      salesCount: product._count.saleItems,
      _count: undefined,
    };
  }

  /**
   * Create a new product
   */
  async create(input: CreateProductInput, createdById?: string) {
    const product = await prisma.product.create({
      data: {
        accountId: input.accountId,
        nome: input.nome,
        valorPadrao: input.valorPadrao,
        metodosPagamento: input.metodosPagamento || ['pix'],
        conveniosAceitos: input.conveniosAceitos || [],
      },
    });

    await eventService.create({
      eventType: 'product.created',
      accountId: input.accountId,
      actorType: createdById ? 'user' : 'system',
      actorId: createdById,
      entityType: 'product',
      entityId: product.id,
      payload: { nome: product.nome, valorPadrao: Number(product.valorPadrao) },
    });

    return {
      ...product,
      valorPadrao: Number(product.valorPadrao),
    };
  }

  /**
   * Update a product
   */
  async update(id: string, input: UpdateProductInput, accountId: string, updatedById?: string) {
    await this.getById(id, accountId);

    const product = await prisma.product.update({
      where: { id },
      data: {
        nome: input.nome,
        valorPadrao: input.valorPadrao,
        metodosPagamento: input.metodosPagamento,
        conveniosAceitos: input.conveniosAceitos,
        ativo: input.ativo,
      },
    });

    await eventService.create({
      eventType: 'product.updated',
      accountId,
      actorType: updatedById ? 'user' : 'system',
      actorId: updatedById,
      entityType: 'product',
      entityId: product.id,
      payload: { changes: input },
    });

    return {
      ...product,
      valorPadrao: Number(product.valorPadrao),
    };
  }

  /**
   * Delete a product (only if no sales)
   */
  async delete(id: string, accountId: string, deletedById: string) {
    const product = await this.getById(id, accountId);

    // Check if product has sales
    const salesCount = await prisma.saleItem.count({
      where: { productId: id },
    });

    if (salesCount > 0) {
      throw new ValidationError(ErrorCodes.PRODUCT_HAS_SALES);
    }

    await prisma.product.delete({ where: { id } });

    await eventService.create({
      eventType: 'product.deleted',
      accountId,
      actorType: 'user',
      actorId: deletedById,
      entityType: 'product',
      entityId: id,
      payload: { nome: product.nome },
    });
  }

  /**
   * Toggle product status
   */
  async toggleStatus(id: string, accountId: string, ativo: boolean, updatedById: string) {
    await this.getById(id, accountId);

    const product = await prisma.product.update({
      where: { id },
      data: { ativo },
    });

    await eventService.create({
      eventType: 'product.updated',
      accountId,
      actorType: 'user',
      actorId: updatedById,
      entityType: 'product',
      entityId: product.id,
      payload: { ativo },
    });

    return {
      ...product,
      valorPadrao: Number(product.valorPadrao),
    };
  }
}

export const productService = new ProductService();
