import { Response, NextFunction } from 'express';
import { insightsService } from '../services/insights.service';
import { AuthenticatedRequest } from '../types';
import { getDateRangeFilter } from '../utils/helpers';

export class InsightsController {
  /**
   * GET /insights/kpis
   */
  async getKPIs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);
      const result = await insightsService.getKPIs(req.user!.accountId!, dateRange);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /insights/products
   */
  async getProductAnalysis(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);
      const result = await insightsService.getProductAnalysis(req.user!.accountId!, dateRange);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /insights/temporal
   */
  async getTemporalAnalysis(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);
      const result = await insightsService.getTemporalAnalysis(req.user!.accountId!, dateRange);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /insights/marketing
   */
  async getMarketingMetrics(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);
      const result = await insightsService.getMarketingMetrics(req.user!.accountId!, dateRange);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /insights/payment-methods
   */
  async getPaymentMethodsAnalysis(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);
      const result = await insightsService.getPaymentMethodsAnalysis(req.user!.accountId!, dateRange);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /insights/automatic
   */
  async getAutomaticInsights(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);
      const result = await insightsService.getAutomaticInsights(req.user!.accountId!, dateRange);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /insights/agents-ranking
   */
  async getAgentsRanking(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);
      const result = await insightsService.getAgentsRanking(req.user!.accountId!, dateRange);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const insightsController = new InsightsController();
