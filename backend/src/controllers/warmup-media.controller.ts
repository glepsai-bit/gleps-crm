/**
 * T-023 V2 — WhatsApp Warmup Media Controller (Phase 3B)
 *
 * Endpoints REST para CRUD de templates de midia (audio/sticker/image)
 * que sao usados pelo cron de warmup para distribuir mensagens nao-texto
 * nas conversas de aquecimento. Templates "globais" (accountId=null) sao
 * seeds compartilhados; admins podem subir seus proprios por conta
 * (multi-tenant scope obrigatorio).
 *
 * Rotas (todas exigem JWT admin via warmup.routes.ts):
 *   POST   /api/warmup/media/upload    multipart upload (file + type)
 *   GET    /api/warmup/media           lista (proprio + globais)
 *   DELETE /api/warmup/media/:id       exclui template + remove arquivo
 *
 * Storage: backend/uploads/warmup/{type}/{filename}, servido estatico
 * em /uploads (ver server.ts). Validacoes runtime: MIME whitelist por
 * tipo + tamanho maximo (audio 1MB, sticker 200KB, image 2MB) para
 * proteger disco e evitar abuso.
 */

import { Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { AuthenticatedRequest } from '../types';
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../utils/errors';
import { logger } from '../utils/logger';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const mediaTypeEnum = z.enum(['audio', 'sticker', 'image']);

const uploadBodySchema = z.object({
  type: mediaTypeEnum,
  category: z.string().trim().max(40).optional(),
  content: z.string().trim().max(500).optional(),
});

const listQuerySchema = z.object({
  type: mediaTypeEnum.optional(),
});

// ─── Limites e whitelists ────────────────────────────────────────────────────

const MAX_BYTES: Record<'audio' | 'sticker' | 'image', number> = {
  audio: 1 * 1024 * 1024,
  sticker: 200 * 1024,
  image: 2 * 1024 * 1024,
};

const ALLOWED_MIME: Record<'audio' | 'sticker' | 'image', string[]> = {
  audio: ['audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/mp4'],
  sticker: ['image/webp'],
  image: ['image/jpeg', 'image/png', 'image/webp'],
};

const EXT_BY_MIME: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Raiz absoluta dos uploads. Usa backend/uploads (mesmo caminho que
 * server.ts expoe estaticamente em /uploads).
 */
function uploadsRoot(): string {
  return path.resolve(process.cwd(), 'uploads');
}

/**
 * Resolve URL absoluta pra UI exibir/baixar a midia.
 * Concatena API_URL com /uploads/<relative>.
 */
function buildMediaUrl(relativePath: string): string {
  const base = (env.API_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/uploads/${relativePath.replace(/^\/+/, '')}`;
}

/**
 * Serializa um WarmupTemplate de midia pro shape de resposta.
 */
function serializeTemplate(t: {
  id: string;
  accountId: string | null;
  type: string;
  category: string;
  content: string;
  mediaPath: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  mediaSizeBytes: number | null;
  mediaDurationMs: number | null;
  fileName: string | null;
  createdAt: Date;
}) {
  return {
    id: t.id,
    accountId: t.accountId,
    type: t.type,
    category: t.category,
    content: t.content,
    mediaUrl: t.mediaUrl ?? (t.mediaPath ? buildMediaUrl(t.mediaPath) : null),
    mediaMimeType: t.mediaMimeType,
    mediaSizeBytes: t.mediaSizeBytes,
    mediaDurationMs: t.mediaDurationMs,
    fileName: t.fileName,
    isGlobal: t.accountId === null,
    createdAt: t.createdAt.toISOString(),
  };
}

// ─── Controller ──────────────────────────────────────────────────────────────

class WarmupMediaController {
  /**
   * POST /api/warmup/media/upload
   * Multipart form-data: file (binary) + type + category? + content?
   * Persiste arquivo no disco e cria WarmupTemplate apontando para ele.
   */
  async upload(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      const userId = req.user?.id;
      if (!accountId) throw new UnauthorizedError();

      // multer.memoryStorage(): arquivo veio em req.file.buffer
      const file = (req as unknown as { file?: Express.Multer.File }).file;
      if (!file) {
        throw new ValidationError('Arquivo obrigatorio (campo "file")');
      }

      const body = uploadBodySchema.parse(req.body ?? {});
      const type = body.type as 'audio' | 'sticker' | 'image';

      // 1) Valida MIME contra whitelist do tipo
      const allowedMimes = ALLOWED_MIME[type];
      if (!allowedMimes.includes(file.mimetype)) {
        throw new ValidationError(
          `MIME type "${file.mimetype}" nao permitido para ${type}`,
          { allowed: allowedMimes }
        );
      }

      // 2) Valida tamanho (multer ja aplica um teto generico, aqui aplicamos
      //    o limite especifico por tipo)
      const maxBytes = MAX_BYTES[type];
      if (file.size > maxBytes) {
        throw new ValidationError(
          `Arquivo excede o tamanho maximo de ${Math.round(maxBytes / 1024)}KB para ${type}`,
          { sizeBytes: file.size, maxBytes }
        );
      }

      // 3) Escolhe extensao e nome final
      const ext = EXT_BY_MIME[file.mimetype] ?? 'bin';
      const filename = `${type}-${randomUUID()}.${ext}`;
      const relativePath = `warmup/${type}/${filename}`;
      const absoluteDir = path.join(uploadsRoot(), 'warmup', type);
      const absolutePath = path.join(absoluteDir, filename);

      // 4) Garante diretorio + grava
      await fs.mkdir(absoluteDir, { recursive: true });
      await fs.writeFile(absolutePath, file.buffer);

      // 5) Cria registro em WarmupTemplate
      const created = await prisma.warmupTemplate.create({
        data: {
          accountId,
          type,
          category: body.category ?? 'media',
          content: body.content ?? '',
          mediaPath: relativePath,
          mediaMimeType: file.mimetype,
          mediaSizeBytes: file.size,
          fileName: file.originalname,
          uploadedById: userId ?? null,
        },
      });

      logger.info('[warmup-media] template created', {
        accountId,
        templateId: created.id,
        type,
        sizeBytes: file.size,
        mimeType: file.mimetype,
      });

      res.status(201).json({
        data: {
          id: created.id,
          type: created.type,
          mediaUrl: buildMediaUrl(relativePath),
          sizeBytes: file.size,
          mimeType: file.mimetype,
          fileName: file.originalname,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Payload invalido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * GET /api/warmup/media?type=
   * Lista templates de midia da accountId + globais (accountId=null).
   * Filtra por type opcional.
   */
  async list(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      if (!accountId) throw new UnauthorizedError();

      const query = listQuerySchema.parse({
        type: req.query.type,
      });

      const where: Prisma.WarmupTemplateWhereInput = {
        OR: [{ accountId }, { accountId: null }],
        // Somente registros de midia tem mediaPath/mediaUrl preenchido.
        // Filtra registros do tipo desejado (default: todos os 3 de midia).
        type: query.type
          ? query.type
          : { in: ['audio', 'sticker', 'image'] },
      };

      const templates = await prisma.warmupTemplate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });

      res.status(200).json({
        data: templates.map(serializeTemplate),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('Query invalida', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }

  /**
   * DELETE /api/warmup/media/:id
   * Multi-tenant: admin so deleta da propria conta; super_admin pode
   * deletar globais (accountId=null) tambem. Remove arquivo best-effort
   * (fs.unlink swallowed se o arquivo ja sumiu).
   */
  async delete(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = req.user?.accountId;
      const role = req.user?.role;
      if (!accountId) throw new UnauthorizedError();

      const id = z.string().uuid().parse(req.params.id);

      // Lookup com scope: proprios da conta + (se super_admin) globais.
      const orClauses: Prisma.WarmupTemplateWhereInput[] = [{ accountId }];
      if (role === 'super_admin') {
        orClauses.push({ accountId: null });
      }

      const template = await prisma.warmupTemplate.findFirst({
        where: {
          id,
          OR: orClauses,
        },
      });

      if (!template) throw new NotFoundError('Template');

      // Remove o arquivo do disco (best-effort).
      if (template.mediaPath) {
        const absolutePath = path.join(uploadsRoot(), template.mediaPath);
        try {
          await fs.unlink(absolutePath);
        } catch (err) {
          // ENOENT (arquivo ja foi removido) eh ok; outros erros sao logados.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn('[warmup-media] falha ao remover arquivo do disco', {
              templateId: id,
              path: absolutePath,
              error: (err as Error).message,
            });
          }
        }
      }

      await prisma.warmupTemplate.delete({ where: { id: template.id } });

      logger.info('[warmup-media] template deleted', {
        accountId,
        templateId: id,
      });

      res.status(204).send();
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(new ValidationError('id invalido', { issues: error.issues }));
        return;
      }
      next(error);
    }
  }
}

export const warmupMediaController = new WarmupMediaController();
