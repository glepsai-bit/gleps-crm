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
}

export const financeController = new FinanceController();
