import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { tagService, funnelService } from '../services/tag.service';
import { contactService } from '../services/contact.service';
import { AuthenticatedRequest } from '../types';

// Validation schemas
const createTagSchema = z.object({
  funnelId: z.string().uuid(),
  name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  type: z.enum(['stage', 'operational']),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Cor inválida').optional(),
});

const updateTagSchema = z.object({
  name: z.string().min(2).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

const reorderTagSchema = z.object({
  ordem: z.number().min(0),
});

const reorderBulkSchema = z.object({
  tagIds: z.array(z.string().uuid()),
});

const listTagsSchema = z.object({
  funnelId: z.string().uuid().optional(),
  type: z.enum(['stage', 'operational']).optional(),
  ativo: z.string().transform(v => v === 'true').optional(),
});

// Funnel schemas
const createFunnelSchema = z.object({
  name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
});

export class TagController {
  /**
   * GET /tags
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = listTagsSchema.parse(req.query);
      const filters = {
        accountId: req.user!.accountId!,
        funnelId: query.funnelId,
        type: query.type,
        ativo: query.ativo,
      };

      const result = await tagService.list(filters);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /tags/:id
   */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await tagService.getById(id, req.user!.accountId!);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /tags
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createTagSchema.parse(req.body);
      const result = await tagService.create(
        { ...body, accountId: req.user!.accountId! },
        req.user!.id
      );

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /tags/:id
   */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = updateTagSchema.parse(req.body);
      const result = await tagService.update(id, body, req.user!.accountId!, req.user!.id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /tags/:id
   */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const force = req.query.force === 'true';
      const migrateToId = req.query.migrateToId as string | undefined;
      
      await tagService.delete(id, req.user!.accountId!, req.user!.id, {
        force: force || undefined,
        migrateToId: migrateToId || undefined,
      });

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /tags/:id/order
   */
  async reorder(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = reorderTagSchema.parse(req.body);
      const result = await tagService.reorder(id, body.ordem, req.user!.accountId!, req.user!.id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /tags/reorder
   */
  async reorderBulk(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = reorderBulkSchema.parse(req.body);
      const result = await tagService.reorderBulk(body.tagIds, req.user!.accountId!, req.user!.id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /tags/kanban
   */
  async getKanbanData(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { funnelId } = req.query;
      const result = await tagService.getKanbanData(req.user!.accountId!, funnelId as string);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /tags/:id/contacts
   */
  async getContactsByStage(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await contactService.getByStage(req.user!.accountId!, id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /tags/sync-labels
   */
  async syncLabels(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await tagService.syncAllLabels(req.user!.accountId!);
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const tagController = new TagController();

export class FunnelController {
  /**
   * GET /funnels
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await funnelService.list(req.user!.accountId!);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /funnels/:id
   */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await funnelService.getById(id, req.user!.accountId!);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /funnels
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createFunnelSchema.parse(req.body);
      const result = await funnelService.create(req.user!.accountId!, body.name, req.user!.id);

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /funnels/:id
   */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = createFunnelSchema.parse(req.body);
      const result = await funnelService.update(id, body.name, req.user!.accountId!);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /funnels/:id
   */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      await funnelService.delete(id, req.user!.accountId!);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }
}

export const funnelController = new FunnelController();
