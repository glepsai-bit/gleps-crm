import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { financeService } from '../services/finance.service';
import { AuthenticatedRequest } from '../types';
import { getDateRangeFilter } from '../utils/helpers';

const dateRangeSuperRefine = (
  data: { startDate?: string; endDate?: string },
  ctx: z.RefinementCtx
) => {
  if (data.startDate && data.endDate && data.startDate > data.endDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'endDate deve ser >= startDate',
      path: ['endDate'],
    });
  }
};

const revenueChartSchema = z
  .object({
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    granularity: z.enum(['day', 'week', 'month']).default('day'),
  })
  .superRefine(dateRangeSuperRefine);

const financeKpisQuerySchema = z
  .object({
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    responsavelId: z.string().uuid().optional(),
    metodoPagamento: z.enum(['pix', 'boleto', 'debito', 'credito', 'dinheiro', 'convenio']).optional(),
  })
  .superRefine(dateRangeSuperRefine);

const paymentMethodsQuerySchema = z
  .object({
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  })
  .superRefine(dateRangeSuperRefine);

const funnelQuerySchema = z
  .object({
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  })
  .superRefine(dateRangeSuperRefine);

export class FinanceController {
  /**
   * GET /finance/kpis
   */
  async getKPIs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = financeKpisQuerySchema.parse(req.query);
      const dateRange = {
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
      };

      const result = await financeService.getKPIs(req.user!.accountId!, dateRange, {
        responsavelId: query.responsavelId,
        metodoPagamento: query.metodoPagamento,
      });

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /finance/revenue-chart
   */
  async getRevenueChart(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = revenueChartSchema.parse(req.query);
      const dateRange = {
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
      };
      const result = await financeService.getRevenueChart(
        req.user!.accountId!,
        dateRange,
        query.granularity
      );

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /finance/payment-methods
   */
  async getPaymentMethods(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      paymentMethodsQuerySchema.parse(req.query);
      const dateRange = getDateRangeFilter(req);
      const result = await financeService.getPaymentMethods(req.user!.accountId!, dateRange);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /finance/funnel-conversion
   */
  async getFunnelConversion(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      funnelQuerySchema.parse(req.query);
      const dateRange = getDateRangeFilter(req);
      const result = await financeService.getFunnelConversion(req.user!.accountId!, dateRange);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /finance/entries — stub (L-VEN-2)
   *
   * Hoje o módulo financeiro só agrega dados derivados de Sale. O CRUD de
   * lançamentos (receitas/despesas avulsas) está no roadmap mas ainda não
   * foi implementado — ver explicação completa em finance.service.ts.
   * Resposta intencional: 501 NOT IMPLEMENTED com mensagem clara para o
   * frontend/integrador.
   */
  async createEntryStub(_req: AuthenticatedRequest, res: Response, _next: NextFunction): Promise<void> {
    res.status(501).json({
      error: {
        code: 'NOT_IMPLEMENTED',
        message:
          'POST /finance/entries ainda não foi implementado. O módulo financeiro hoje só agrega dados derivados de vendas (Sale). CRUD completo de lançamentos (receitas/despesas avulsas) está no roadmap — ver finance.service.ts para detalhes.',
        feature: 'finance.entries.crud',
      },
    });
  }
}

export const financeController = new FinanceController();
