import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { whatsappTemplateService } from '../services/whatsapp-template.service';
import { AuthenticatedRequest } from '../types';

// T1-XSS-TEMPLATE: rejeita qualquer tag HTML no conteúdo do template.
// Templates de WhatsApp usam apenas texto puro + variáveis (`{nome}`), nunca
// rich text/HTML. Permitir tags abriria espaço para XSS na UI de preview e
// para payloads inesperados no destino (Evolution API/WhatsApp).
const HTML_TAG_REGEX = /<[^>]+>/;

// Validation schemas
const createWhatsappTemplateSchema = z.object({
  name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres').max(120),
  content: z
    .string()
    .min(1, 'Conteúdo do template é obrigatório')
    .max(4096, 'Conteúdo do template excede 4096 caracteres')
    .refine(
      (v) => !HTML_TAG_REGEX.test(v),
      'Conteúdo não pode conter HTML (use texto puro + variáveis, ex.: {nome})'
    ),
  category: z.string().max(60).optional(),
});

const updateWhatsappTemplateSchema = createWhatsappTemplateSchema.partial();

export class WhatsappTemplateController {
  /**
   * GET /whatsapp/templates
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.user!.accountId as string;
      const result = await whatsappTemplateService.list(accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /whatsapp/templates/:id
   */
  async get(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const accountId = req.user!.accountId as string;
      const result = await whatsappTemplateService.get(id, accountId);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /whatsapp/templates
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createWhatsappTemplateSchema.parse(req.body);
      const accountId = req.user!.accountId as string;
      const result = await whatsappTemplateService.create(accountId, {
        ...body,
        createdById: req.user!.id,
      });

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /whatsapp/templates/:id
   */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const accountId = req.user!.accountId as string;
      const body = updateWhatsappTemplateSchema.parse(req.body);
      const result = await whatsappTemplateService.update(id, accountId, body);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /whatsapp/templates/:id
   */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const accountId = req.user!.accountId as string;
      await whatsappTemplateService.delete(id, accountId);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }
}

export const whatsappTemplateController = new WhatsappTemplateController();
