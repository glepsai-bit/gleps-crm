import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { saleService } from '../services/sale.service';
import { AuthenticatedRequest } from '../types';
import { getPaginationParams, getDateRangeFilter } from '../utils/helpers';

// Validation schemas
const createSaleItemSchema = z.object({
  productId: z.string().uuid(),
  quantidade: z.number().int().positive(),
  valorUnitario: z.number().positive(),
});

const createSaleSchema = z.object({
  contactId: z.string().uuid(),
  metodoPagamento: z.enum(['pix', 'boleto', 'debito', 'credito', 'dinheiro', 'convenio']),
  convenioNome: z.string().optional(),
  items: z.array(createSaleItemSchema).min(1, 'Pelo menos um item é obrigatório'),
});

const refundSchema = z.object({
  reason: z.string().min(3, 'Justificativa deve ter pelo menos 3 caracteres'),
});

const listSalesSchema = z.object({
  contactId: z.string().uuid().optional(),
  status: z.enum(['pending', 'paid', 'refunded', 'partial_refund']).optional(),
  responsavelId: z.string().uuid().optional(),
  metodoPagamento: z.enum(['pix', 'boleto', 'debito', 'credito', 'dinheiro', 'convenio']).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export class SaleController {
  /**
   * GET /sales
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = listSalesSchema.parse(req.query);
      const pagination = getPaginationParams(req);

      // Agents can only see their own sales
      let responsavelId = query.responsavelId;
      if (req.user!.role === 'agent') {
        responsavelId = req.user!.id;
      }

      const filters = {
        accountId: req.user!.accountId!,
        contactId: query.contactId,
        status: query.status,
        responsavelId,
        metodoPagamento: query.metodoPagamento,
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
      };

      const result = await saleService.list(filters, pagination);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /sales/:id
   */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await saleService.getById(id, req.user!.accountId!);

      // Agents can only see their own sales
      if (req.user!.role === 'agent' && result.responsavelId !== req.user!.id) {
        res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'Acesso negado' },
        });
        return;
      }

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /sales
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createSaleSchema.parse(req.body);
      const result = await saleService.create(
        {
          ...body,
          accountId: req.user!.accountId!,
          responsavelId: req.user!.id,
        },
        req.user!.id
      );

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /sales/:id/pay
   */
  async markPaid(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await saleService.markPaid(id, req.user!.accountId!, req.user!.id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /sales/:id/refund
   */
  async refund(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = refundSchema.parse(req.body);
      const result = await saleService.refund(id, req.user!.accountId!, body.reason, req.user!.id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /sales/:id/items/:itemId/refund
   */
  async refundItem(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const itemId = req.params.itemId as string;
      const body = refundSchema.parse(req.body);
      const result = await saleService.refundItem(
        id,
        itemId,
        req.user!.accountId!,
        body.reason,
        req.user!.id
      );

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /sales/kpis
   */
  async getKPIs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);

      // Agents see only their own KPIs
      const responsavelId = req.user!.role === 'agent' ? req.user!.id : undefined;

      const result = await saleService.getKPIs(req.user!.accountId!, dateRange, responsavelId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /sales/audit-log
   */
  async getAuditLog(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);
      const pagination = getPaginationParams(req);

      const result = await saleService.getAuditLog(req.user!.accountId!, dateRange, pagination);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
}

export const saleController = new SaleController();
