import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prospectingAudienceService } from '../services/prospecting-audience.service';
import { AuthenticatedRequest } from '../types';

const leadSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  rating: z.number().optional().nullable(),
  website: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  rawData: z.any().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  keyword: z.string().optional(),
  location: z.string().optional(),
  leads: z.array(leadSchema).min(1),
});

export class ProspectingAudienceController {
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await prospectingAudienceService.list(req.user!.accountId!);
      res.json({ data });
    } catch (err) { next(err); }
  }

  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createSchema.parse(req.body);
      const audience = await prospectingAudienceService.create(
        req.user!.accountId!,
        req.user!.id || null,
        body
      );
      res.status(201).json({ success: true, data: audience });
    } catch (err) { next(err); }
  }

  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const audience = await prospectingAudienceService.getWithLeads(req.user!.accountId!, id);
      if (!audience) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Público não encontrado' } });
        return;
      }
      res.json({ data: audience });
    } catch (err) { next(err); }
  }

  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      await prospectingAudienceService.delete(req.user!.accountId!, id);
      res.json({ success: true });
    } catch (err) { next(err); }
  }
}

export const prospectingAudienceController = new ProspectingAudienceController();
