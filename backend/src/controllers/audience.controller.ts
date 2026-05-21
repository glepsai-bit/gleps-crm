import { Request, Response, NextFunction } from 'express';
import { audienceService } from '../services/audience.service';

function getAccountId(req: Request): string {
  return (req as any).user?.accountId;
}
function getUserId(req: Request): string {
  return (req as any).user?.id;
}

export const audienceController = {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await audienceService.list(getAccountId(req));
      res.json(data);
    } catch (error) { next(error); }
  },

  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await audienceService.get(req.params.id as string, getAccountId(req));
      if (!data) return res.status(404).json({ error: 'Público não encontrado' });
      res.json(data);
    } catch (error) { next(error); }
  },

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await audienceService.create({
        accountId: getAccountId(req),
        name: req.body.name,
        description: req.body.description,
        createdBy: getUserId(req),
      });
      res.status(201).json(data);
    } catch (error) { next(error); }
  },

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await audienceService.update(req.params.id as string, getAccountId(req), req.body);
      res.json(data);
    } catch (error) { next(error); }
  },

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      await audienceService.delete(req.params.id as string, getAccountId(req));
      res.json({ success: true });
    } catch (error) { next(error); }
  },

  async listContacts(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await audienceService.listContacts(req.params.id as string, getAccountId(req));
      res.json(data);
    } catch (error) { next(error); }
  },

  async addContacts(req: Request, res: Response, next: NextFunction) {
    try {
      const { contactIds } = req.body;
      const data = await audienceService.addContacts(req.params.id as string, getAccountId(req), contactIds);
      res.json(data);
    } catch (error) { next(error); }
  },

  async removeContact(req: Request, res: Response, next: NextFunction) {
    try {
      await audienceService.removeContact(req.params.id as string, getAccountId(req), req.params.contactId as string);
      res.json({ success: true });
    } catch (error) { next(error); }
  },

  async importContacts(req: Request, res: Response, next: NextFunction) {
    try {
      const { rows } = req.body;
      const data = await audienceService.importContacts(req.params.id as string, getAccountId(req), rows);
      res.json(data);
    } catch (error) { next(error); }
  },
};
