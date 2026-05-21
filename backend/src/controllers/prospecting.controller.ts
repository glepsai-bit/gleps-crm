import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prospectingService } from '../services/prospecting.service';
import { AuthenticatedRequest } from '../types';

const extractSchema = z.object({
  nicho: z.string().min(1),
  localizacao: z.string().min(1),
});

const dispatchSchema = z.object({
  inbox_assignments: z.array(z.object({
    inbox_id: z.number(),
    inbox_name: z.string(),
    contacts: z.array(z.object({
      nome: z.string(),
      telefone: z.string(),
    })),
  })).min(1),
  messages: z.array(z.string().min(1)).min(1),
  delay_seconds: z.number().min(5).max(300).default(30),
  keyword: z.string().optional(),
  location: z.string().optional(),
});

const cancelSchema = z.object({ batch_id: z.string().uuid() });

const resumeSchema = z.object({
  batch_id: z.string().uuid(),
  messages: z.array(z.string().min(1)).min(1),
  delay_seconds: z.number().min(5).max(300).optional(),
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

  async listInboxes(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const inboxes = await prospectingService.listInboxes(req.user!.accountId!);
      res.json({ success: true, inboxes });
    } catch (error) {
      next(error);
    }
  }

  async dispatch(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = dispatchSchema.parse(req.body);
      const result = await prospectingService.dispatch(
        req.user!.accountId!,
        body.inbox_assignments,
        body.messages,
        body.delay_seconds,
        body.keyword,
        body.location
      );
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  async cancelBatch(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = cancelSchema.parse(req.body);
      await prospectingService.cancelBatch(req.user!.accountId!, body.batch_id);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  async resumeBatch(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = resumeSchema.parse(req.body);
      const result = await prospectingService.resumeBatch(
        req.user!.accountId!, body.batch_id, body.messages, body.delay_seconds
      );
      res.json({ success: true, batch_id: body.batch_id, ...result });
    } catch (error: any) {
      if (error.statusCode) {
        res.status(error.statusCode).json({ success: false, error: error.message });
        return;
      }
      next(error);
    }
  }

  async getBatches(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const batches = await prospectingService.getBatches(req.user!.accountId!);
      res.json({ data: batches });
    } catch (error) {
      next(error);
    }
  }

  async getBatchLogs(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const batchId = req.params.batchId as string;
      const logs = await prospectingService.getBatchLogs(batchId);
      res.json({ data: logs });
    } catch (error) {
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
