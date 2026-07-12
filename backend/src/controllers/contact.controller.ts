import { prisma } from '../config/database';
import { createReadStream } from 'node:fs';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { contactService } from '../services/contact.service';
import { conversationService } from '../services/conversation.service';
import { avatarStorageService } from '../services/avatar-storage.service';
import { AuthenticatedRequest } from '../types';
import { getPaginationParams } from '../utils/helpers';

// Validation schemas
// H-LEADS-1: nome é obrigatório na criação para evitar registros "zumbi" com tudo null.
// telefone/email continuam opcionais individualmente, mas o schema rejeita strings vazias
// (ex.: "") quando informadas, para não burlar a validação enviando campos em branco.
const createContactSchema = z.object({
  nome: z.string().trim().min(1, 'Nome obrigatório').max(120, 'Nome deve ter no máximo 120 caracteres'),
  telefone: z
    .string()
    .trim()
    .min(1, 'Telefone não pode ser vazio')
    .optional(),
  email: z
    .string()
    .trim()
    .min(1, 'Email não pode ser vazio')
    .email('Email inválido')
    .optional(),
  origem: z.enum(['whatsapp', 'instagram', 'site', 'indicacao', 'outro']).optional(),
});

// Update permite payload parcial: todos os campos opcionais (incluindo nome),
// mas se nome for informado não pode ser string vazia.
const updateContactSchema = z.object({
  nome: z
    .string()
    .trim()
    .min(1, 'Nome não pode ser vazio')
    .max(120, 'Nome deve ter no máximo 120 caracteres')
    .optional(),
  telefone: z
    .string()
    .trim()
    .min(1, 'Telefone não pode ser vazio')
    .optional(),
  email: z
    .string()
    .trim()
    .min(1, 'Email não pode ser vazio')
    .email('Email inválido')
    .optional(),
  origem: z.enum(['whatsapp', 'instagram', 'site', 'indicacao', 'outro']).optional(),
});

const listContactsSchema = z.object({
  search: z.string().optional(),
  origem: z.enum(['whatsapp', 'instagram', 'site', 'indicacao', 'outro']).optional(),
  tagId: z.string().uuid().optional(),
});

const applyTagSchema = z.object({
  tagId: z.string().uuid(),
  source: z.enum(['kanban', 'system', 'api']).default('api'),
});

const addNoteSchema = z.object({
  content: z.string().min(1, 'Conteúdo é obrigatório'),
});

// Schema for external API consumers (n8n etc.) via API key
const queryForApiSchema = z.object({
  aniversario: z.string().optional(),
  tag: z.union([z.string(), z.array(z.string())]).optional(),
  stage: z.string().optional(),
  lastFollowupBefore: z
    .string()
    .datetime({ offset: true })
    .or(z.string().datetime())
    .optional(),
  lastFollowupAfter: z
    .string()
    .datetime({ offset: true })
    .or(z.string().datetime())
    .optional(),
  customAttribute: z.record(z.string()).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
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

  /**
   * GET /api/contacts  (external API — auth via API key, for n8n etc.)
   *
   * Mounted behind `requireApiKey`, so `req.accountId` and `req.apiKey`
   * are populated by the middleware (no JWT user context).
   */
  async queryForApi(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.accountId;
      if (!accountId) {
        res.status(401).json({ error: 'API key inválida ou revogada' });
        return;
      }

      const parsed = queryForApiSchema.parse(req.query);

      const filters = {
        aniversario: parsed.aniversario,
        tag: parsed.tag,
        stage: parsed.stage,
        lastFollowupBefore: parsed.lastFollowupBefore
          ? new Date(parsed.lastFollowupBefore)
          : undefined,
        lastFollowupAfter: parsed.lastFollowupAfter
          ? new Date(parsed.lastFollowupAfter)
          : undefined,
        customAttribute: parsed.customAttribute,
        limit: parsed.limit,
        offset: parsed.offset,
      };

      const result = await contactService.queryForApi(accountId, filters);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/contacts/refresh-avatars  (admin-only)
   * Backfill das fotos de perfil (WhatsApp) dos contatos da conta. Popula os
   * que ainda nao tem foto; com ?force=true reprocessa todos. Cap de 500/req.
   */
  async refreshAvatars(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const force = String(req.query.force ?? '') === 'true';
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

      const summary = await conversationService.backfillAccountAvatars(accountId, {
        force,
        limit,
      });
      res.json({ data: summary });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/contacts/:id/avatar
   * AUDIT-AVATAR: serve a foto de perfil persistida em disco (o CDN do
   * WhatsApp expira em minutos). Autenticado + escopado por conta; sem
   * permissão granular — agentes de chat também precisam ver avatares.
   */
  async serveAvatar(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user!.accountId!;
      const id = req.params.id as string;

      const contact = await prisma.contact.findFirst({
        where: { id, accountId },
        select: { id: true },
      });
      if (!contact) {
        res.status(404).json({ error: { message: 'Contato não encontrado' } });
        return;
      }

      const file = await avatarStorageService.stat(accountId, id);
      if (!file) {
        res.status(404).json({ error: { message: 'Contato sem foto de perfil' } });
        return;
      }

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', String(file.byteLength));
      res.setHeader('Cache-Control', 'private, max-age=86400');
      createReadStream(file.absolutePath)
        .on('error', (err) => next(err))
        .pipe(res);
    } catch (error) {
      next(error);
    }
  }

}

export const contactController = new ContactController();
