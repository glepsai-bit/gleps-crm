import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prospectingService } from '../services/prospecting.service';
import { AuthenticatedRequest } from '../types';

const extractSchema = z.object({
  nicho: z.string().min(1),
  localizacao: z.string().min(1),
});

export class ProspectingController {
  async extractLeads(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = extractSchema.parse(req.body);
      const result = await prospectingService.extractLeads(req.user!.accountId!, body.nicho, body.localizacao);
      res.json({ success: true, leads: result.leads, usage: result.usage });
    } catch (error: any) {
      if (error.statusCode) {
        res.status(error.statusCode).json({ success: false, error: error.message });
        return;
      }
      next(error);
    }
  }

  /**
   * GET /api/prospecting/usage
   * Returns current month extraction usage in "extractions" units (resets monthly).
   */
  async getUsage(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const usage = await prospectingService.getUsage(req.user!.accountId!);
      res.json({ success: true, ...usage });
    } catch (error) {
      next(error);
    }
  }
}

export const prospectingController = new ProspectingController();
