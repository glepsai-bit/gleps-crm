import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { contactService } from '../services/contact.service';
import { AuthenticatedRequest } from '../types';
import { getPaginationParams } from '../utils/helpers';

// Validation schemas
const createContactSchema = z.object({
  nome: z.string().optional(),
  telefone: z.string().optional(),
  email: z.string().email().optional(),
  origem: z.enum(['whatsapp', 'instagram', 'site', 'indicacao', 'outro']).optional(),
});

const updateContactSchema = createContactSchema;

const listContactsSchema = z.object({
  search: z.string().optional(),
  origem: z.enum(['whatsapp', 'instagram', 'site', 'indicacao', 'outro']).optional(),
  tagId: z.string().uuid().optional(),
});

const applyTagSchema = z.object({
  tagId: z.string().uuid(),
  source: z.enum(['kanban', 'chatwoot', 'system', 'api']).default('api'),
});

const addNoteSchema = z.object({
  content: z.string().min(1, 'Conteúdo é obrigatório'),
});

export class ContactController {
  /**
   * GET /contacts
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const filters = {
        ...listContactsSchema.parse(req.query),
        accountId: req.user!.accountId!,
      };
      const pagination = getPaginationParams(req);

      const result = await contactService.list(filters, pagination);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /contacts/:id
   */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await contactService.getById(id, req.user!.accountId!);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /contacts
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createContactSchema.parse(req.body);
      const result = await contactService.create(
        { ...body, accountId: req.user!.accountId! },
        req.user!.id
      );

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /contacts/:id
   */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = updateContactSchema.parse(req.body);
      const result = await contactService.update(id, body, req.user!.accountId!, req.user!.id);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /contacts/:id
   */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      await contactService.delete(id, req.user!.accountId!, req.user!.id);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /contacts/:id/sales
   */
  async getSales(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const pagination = getPaginationParams(req);
      const result = await contactService.getSales(id, req.user!.accountId!, pagination);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /contacts/:id/notes
   */
  async getNotes(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const pagination = getPaginationParams(req);
      const result = await contactService.getNotes(id, req.user!.accountId!, pagination);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /contacts/:id/notes
   */
  async addNote(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = addNoteSchema.parse(req.body);
      const result = await contactService.addNote(
        id,
        req.user!.accountId!,
        body.content,
        req.user!.id,
        req.user!.nome
      );

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /contacts/:id/tags
   */
  async getTags(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await contactService.getTags(id, req.user!.accountId!);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /contacts/:id/tags
   */
  async applyTag(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = applyTagSchema.parse(req.body);
      const result = await contactService.applyTag(
        id,
        req.user!.accountId!,
        body.tagId,
        body.source,
        req.user!.id
      );

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /contacts/:id/tags/:tagId
   */
  async removeTag(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const tagId = req.params.tagId as string;
      const result = await contactService.removeTag(
        id,
        req.user!.accountId!,
        tagId,
        'api',
        req.user!.id
      );

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /contacts/:id/history
   */
  async getHistory(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const pagination = getPaginationParams(req);
      const result = await contactService.getHistory(id, req.user!.accountId!, pagination);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /lead-tags
   * List all lead_tags for the account (used by Kanban)
   */
  async listLeadTags(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const result = await contactService.listLeadTags(accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }
}

export const contactController = new ContactController();
