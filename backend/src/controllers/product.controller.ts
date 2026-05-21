import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { productService } from '../services/product.service';
import { AuthenticatedRequest } from '../types';
import { getPaginationParams } from '../utils/helpers';

// Validation schemas
const createProductSchema = z.object({
  nome: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  valorPadrao: z.number().positive('Valor deve ser positivo'),
  metodosPagamento: z.array(z.enum(['pix', 'boleto', 'debito', 'credito', 'dinheiro', 'convenio'])).optional(),
  conveniosAceitos: z.array(z.string()).optional(),
});

const updateProductSchema = createProductSchema.partial().extend({
  ativo: z.boolean().optional(),
});

const listProductsSchema = z.object({
  search: z.string().optional(),
  ativo: z.string().transform(v => v === 'true').optional(),
});

const toggleStatusSchema = z.object({
  ativo: z.boolean(),
});

export class ProductController {
  /**
   * GET /products
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = listProductsSchema.parse(req.query);
      const filters = {
        accountId: req.user!.accountId!,
        search: query.search,
        ativo: query.ativo,
      };
      const pagination = getPaginationParams(req);

      const result = await productService.list(filters, pagination);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /products/:id
   */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await productService.getById(id, req.user!.accountId!);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /products
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createProductSchema.parse(req.body);
      const result = await productService.create(
        { ...body, accountId: req.user!.accountId! },
        req.user!.id
      );

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /products/:id
   */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = updateProductSchema.parse(req.body);
      const result = await productService.update(id, body, req.user!.accountId!, req.user!.id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /products/:id
   */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      await productService.delete(id, req.user!.accountId!, req.user!.id);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /products/:id/status
   */
  async toggleStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = toggleStatusSchema.parse(req.body);
      const result = await productService.toggleStatus(id, req.user!.accountId!, body.ativo, req.user!.id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const productController = new ProductController();
