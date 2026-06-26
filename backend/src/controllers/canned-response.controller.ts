import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { cannedResponseService } from '../services/canned-response.service';
import { AuthenticatedRequest } from '../types';

/**
 * Canned Responses Controller (T-022 — chat interno / respostas prontas)
 *
 * CRUD de respostas prontas escopadas por accountId.
 * - GET (list/get) liberado para qualquer usuário autenticado da conta (agents
 *   usam para autocomplete "/" no MessageComposer).
 * - POST/PATCH/DELETE exigem admin/super_admin (ver routes).
 *
 * O accountId é resolvido via JWT (req.user.accountId) — nunca confiar em
 * accountId vindo de body/query.
 */

const listQuerySchema = z.object({
  search: z.string().optional(),
});

// T1-CANNED-SPACE: shortCode é o gatilho do composer (`/atalho`). O composer
// dá split por whitespace, então um shortCode com espaço (ex.: `hello world`)
// nunca casaria — só `hello` seria considerado. Forçamos um charset seguro
// (letras/dígitos/`_`/`-`) para evitar entradas que silenciosamente não
// funcionam e também caracteres exóticos que confundem o autocomplete.
const SHORT_CODE_REGEX = /^[a-zA-Z0-9_-]+$/;
const SHORT_CODE_ERROR =
  'shortCode deve conter apenas letras, números, "_" e "-" (sem espaços)';

const createSchema = z.object({
  shortCode: z
    .string()
    .min(1, 'shortCode é obrigatório')
    .max(80, 'shortCode deve ter no máximo 80 caracteres')
    .regex(SHORT_CODE_REGEX, SHORT_CODE_ERROR),
  content: z.string().min(1, 'content é obrigatório'),
  description: z.string().nullable().optional(),
});

const updateSchema = z.object({
  shortCode: z
    .string()
    .min(1, 'shortCode é obrigatório')
    .max(80, 'shortCode deve ter no máximo 80 caracteres')
    .regex(SHORT_CODE_REGEX, SHORT_CODE_ERROR)
    .optional(),
  content: z.string().min(1, 'content é obrigatório').optional(),
  description: z.string().nullable().optional(),
});

export class CannedResponseController {
  /**
   * GET /canned-responses?search=...
   * Lista respostas prontas da conta autenticada.
   */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = listQuerySchema.parse(req.query);
      const result = await cannedResponseService.list(
        req.user!.accountId!,
        query.search
      );

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /canned-responses/:id
   */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const result = await cannedResponseService.get(id, req.user!.accountId!);

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /canned-responses
   */
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createSchema.parse(req.body);
      const result = await cannedResponseService.create(req.user!.accountId!, {
        shortCode: body.shortCode,
        content: body.content,
        description: body.description ?? null,
        createdById: req.user!.id,
      });

      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /canned-responses/:id
   */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      const body = updateSchema.parse(req.body);

      const result = await cannedResponseService.update(id, req.user!.accountId!, {
        shortCode: body.shortCode,
        content: body.content,
        description: body.description,
      });

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /canned-responses/:id
   */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = req.params.id as string;
      await cannedResponseService.delete(id, req.user!.accountId!);

      res.json({ data: { success: true } });
    } catch (error) {
      next(error);
    }
  }
}

export const cannedResponseController = new CannedResponseController();
