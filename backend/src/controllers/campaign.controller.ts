import { Request, Response, NextFunction } from 'express';
import { campaignService } from '../services/campaign.service';

function getAccountId(req: Request): string {
  return (req as any).user?.accountId;
}
function getUserId(req: Request): string {
  return (req as any).user?.id;
}

export const campaignController = {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await campaignService.list(getAccountId(req));
      res.json(data);
    } catch (error) { next(error); }
  },

  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await campaignService.get(req.params.id as string, getAccountId(req));
      if (!data) return res.status(404).json({ error: 'Campanha não encontrada' });
      res.json(data);
    } catch (error) { next(error); }
  },

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await campaignService.create({
        accountId: getAccountId(req),
        ...req.body,
        createdBy: getUserId(req),
      });
      res.status(201).json(data);
    } catch (error) { next(error); }
  },

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await campaignService.update(req.params.id as string, getAccountId(req), req.body);
      res.json(data);
    } catch (error) { next(error); }
  },

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      await campaignService.delete(req.params.id as string, getAccountId(req));
      res.json({ success: true });
    } catch (error) { next(error); }
  },

  async addCadence(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await campaignService.addCadence(req.params.id as string, req.body.cadenceId, getAccountId(req));
      res.json(data);
    } catch (error) { next(error); }
  },

  async removeCadence(req: Request, res: Response, next: NextFunction) {
    try {
      const cadenceId = (req.body.cadenceId || req.query.cadenceId) as string;
      const data = await campaignService.removeCadence(req.params.id as string, cadenceId, getAccountId(req));
      res.json(data);
    } catch (error) { next(error); }
  },

  async getStats(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await campaignService.getStats(req.params.id as string, getAccountId(req));
      res.json(data);
    } catch (error) { next(error); }
  },

  async dispatchNow(req: Request, res: Response, next: NextFunction) {
    try {
      const cadenceId = (req.body?.cadenceId || undefined) as string | undefined;
      const data = await campaignService.dispatchNow(req.params.id as string, getAccountId(req), cadenceId);
      res.json(data);
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Erro ao disparar campanha' });
    }
  },
};
