import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { dashboardService } from '../services/dashboard.service';
import { AuthenticatedRequest } from '../types';
import { getDateRangeFilter } from '../utils/helpers';

const filtersSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  agentId: z.string().uuid().optional(),
});

const consumptionSchema = z.object({
  period: z.enum(['24h', '7d', '30d']).default('24h'),
});

const dinheiroMesaSchema = z.object({
  range: z.enum(['7d', '30d', '90d']).default('30d'),
});

export class DashboardController {
  /**
   * GET /dashboard/kpis
   */
  async getKPIs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);
      const agentId = req.query.agentId as string;

      // Agents see only their own KPIs
      const effectiveAgentId = req.user!.role === 'agent' ? req.user!.id : agentId;

      const result = await dashboardService.getAdminKPIs(
        req.user!.accountId ?? null,
        dateRange,
        effectiveAgentId
      );

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /dashboard/hourly-peak
   */
  async getHourlyPeak(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);
      const result = await dashboardService.getHourlyPeak(req.user!.accountId ?? null, dateRange);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /dashboard/backlog
   */
  async getBacklog(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await dashboardService.getBacklog(req.user!.accountId ?? null);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /dashboard/agents-performance
   */
  async getAgentPerformance(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);
      const result = await dashboardService.getAgentPerformance(req.user!.accountId ?? null, dateRange);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /dashboard/ia-vs-human
   */
  async getIAvsHuman(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const dateRange = getDateRangeFilter(req);
      const result = await dashboardService.getIAvsHuman(req.user!.accountId ?? null, dateRange);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /dashboard/dinheiro-mesa (T-017)
   * KPI de "dinheiro na mesa" — soma orcamentos com outcome=CONSIDERING
   * (cliente disse "vai pensar") nos ultimos N dias. Sensivel: rota tem
   * gate server-side via requireRole('admin', 'super_admin') no router.
   */
  async getDinheiroMesa(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = dinheiroMesaSchema.parse(req.query);
      const result = await dashboardService.getDinheiroMesa(req.user!.accountId ?? null, query.range);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  // Super Admin endpoints

  /**
   * GET /admin/kpis
   */
  async getSuperAdminKPIs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await dashboardService.getSuperAdminKPIs();

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /admin/server-resources
   */
  async getServerResources(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await dashboardService.getServerResources();

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /admin/consumption-history
   */
  async getConsumptionHistory(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = consumptionSchema.parse(req.query);
      const result = await dashboardService.getConsumptionHistory(query.period);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /admin/weekly-consumption
   */
  async getWeeklyConsumption(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await dashboardService.getWeeklyConsumption();
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const dashboardController = new DashboardController();
