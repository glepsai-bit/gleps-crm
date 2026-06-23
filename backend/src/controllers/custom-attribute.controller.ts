import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { customAttributeService } from '../services/custom-attribute.service';
import { AuthenticatedRequest } from '../types';

/**
 * Custom Attribute Definitions Controller (T-022)
 *
 * Gerencia definições de campos customizados por accountId.
 * Escopos suportados: conversation | contact | account
 * Tipos suportados: text | number | date | list | boolean
 *
 * Todas as rotas exigem JWT + admin/super_admin (ver routes).
 */

const SCOPE_VALUES = ['conversation', 'contact', 'account'] as const;
const TYPE_VALUES = ['text', 'number', 'date', 'list', 'boolean'] as const;

const listQuerySchema = z.object({
  scope: z.enum(SCOPE_VALUES).optional(),
});

const createSchema = z.object({
  scope: z.enum(SCOPE_VALUES),
  key: z
    .string()
    .min(1, 'Key é obrigatório')
    .max(80, 'Key deve ter no máximo 80 caracteres')
    .regex(
      /^[a-z][a-z0-9_]{0,79}$/i,
      'Key deve começar com letra e conter apenas letras, números e underscore'
    ),
  label: z.string().min(1, 'Label é obrigatório'),
  type: z.enum(TYPE_VALUES),
  options: z.array(z.string().min(1)).optional().nullable(),
  required: z.boolean().optional(),
});

const updateSchema = z.object({
  label: z.string().min(1).optional(),
  type: z.enum(TYPE_VALUES).optional(),
  options: z.array(z.string().min(1)).optional().nullable(),
  required: z.boolean().optional(),
});

export class CustomAttributeController {
  /**
   * GET /custom-attributes?scope=conversation|contact|account
   * Lista definições da conta, opcionalmente filtrando por escopo.
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = listQuerySchema.parse(req.query);
      const result = await customAttributeService.list(req.user!.accountId!, query.scope);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /custom-attributes/:id
   */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await customAttributeService.get(id, req.user!.accountId!);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /custom-attributes
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createSchema.parse(req.body);
      const result = await customAttributeService.create(req.user!.accountId!, {
        scope: body.scope,
        key: body.key,
        label: body.label,
        type: body.type,
        options: body.options ?? null,
        required: body.required,
      });

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /custom-attributes/:id
   * Não permite alterar scope/key (são parte da identidade).
   */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = updateSchema.parse(req.body);

      const result = await customAttributeService.update(id, req.user!.accountId!, {
        label: body.label,
        type: body.type,
        options: body.options,
        required: body.required,
      });

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /custom-attributes/:id
   */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      await customAttributeService.delete(id, req.user!.accountId!);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }
}

export const customAttributeController = new CustomAttributeController();
