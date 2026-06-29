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

// BUG-009: validacao por MAGIC BYTES (defesa contra MIME spoofing).
//
// Antes, a validacao usava apenas file.mimetype (vindo do header
// Content-Type, fornecido pelo cliente). Atacante poderia enviar .exe/.html
// declarando audio/ogg, passar pelo gate ALLOWED_MIME, ficar acessivel via
// /uploads/ e ser re-enviado via Evolution (risco de flag do chip pela Meta).
//
// Agora inspecionamos os primeiros bytes (assinatura binaria) e exigimos
// que batam com o MIME declarado.
const MAGIC_BY_MIME: Record<string, (buf: Buffer) => boolean> = {
  // OGG: "OggS" nos primeiros 4 bytes
  'audio/ogg': (buf) =>
    buf.length >= 4 && buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53,
  // MP3: ID3 ou frame sync 0xFFFB/0xFFF3/0xFFF2
  'audio/mpeg': (buf) =>
    (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
    (buf.length >= 2 &&
      buf[0] === 0xff &&
      (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)),
  // WAV: "RIFF....WAVE"
  'audio/wav': (buf) =>
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x41 &&
    buf[10] === 0x56 &&
    buf[11] === 0x45,
  // MP4/M4A: ftyp atom em offset 4
  'audio/mp4': (buf) =>
    buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70,
  // WEBP: "RIFF....WEBP"
  'image/webp': (buf) =>
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50,
  // JPEG: FF D8 FF
  'image/jpeg': (buf) =>
    buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  'image/png': (buf) =>
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a,
};

function verifyMagicBytes(buf: Buffer, declaredMime: string): boolean {
  const verifier = MAGIC_BY_MIME[declaredMime];
  if (!verifier) return false;
  return verifier(buf);
}

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

      // 1.5) BUG-009: valida MAGIC BYTES (defesa contra MIME spoofing).
      // file.mimetype eh declarado pelo cliente; sem essa checagem, um .exe
      // declarado como audio/ogg passaria, ficaria acessivel em /uploads e
      // poderia flag o chip via Evolution.
      if (!verifyMagicBytes(file.buffer, file.mimetype)) {
        throw new ValidationError(
          `Conteudo do arquivo nao bate com o MIME declarado "${file.mimetype}"`,
          { declaredMime: file.mimetype }
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

      // BUG-047: era 'Template' (label generico). Agora reflete o recurso real.
      if (!template) throw new NotFoundError('Midia');

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
