/**
 * ATTACHMENT CONTROLLER — Bug A (T-022)
 *
 * GET /api/attachments/:id
 *   Streama a mídia já materializada em disco (ou força materialização lazy
 *   se ainda estiver pending). Autenticação JWT obrigatória (rota está sob
 *   o stack /api comum). RBAC: o attachment precisa pertencer a uma
 *   conversa da accountId do usuário.
 *
 * Headers de resposta:
 *   - Content-Type vindo do Attachment.mimeType (fallback application/octet-stream)
 *   - Content-Length = byteLength do arquivo
 *   - Content-Disposition: inline; filename="<fileName>" — permite o browser
 *     decidir player vs download. Áudio renderiza no <audio> nativo.
 *   - Cache-Control: private, max-age=3600 — mídias são imutáveis post-upload.
 */

import type { NextFunction, Response } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { prisma } from '../config/database';
import { attachmentStorageService } from '../services/attachment-storage.service';
import type { AuthenticatedRequest } from '../types';
import { NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

function getAccountId(req: AuthenticatedRequest): string {
  const id = (req as any).accountId || req.user?.accountId;
  if (!id) throw new ValidationError('accountId ausente na requisição');
  return id;
}

export class AttachmentController {
  async stream(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const id = req.params.id as string;
      if (!id) throw new ValidationError('id é obrigatório');

      const accountId = getAccountId(req);

      // RBAC: garante que o attachment pertence à conta do usuário.
      // Não vazamos 404 vs 403 pra evitar enumeração (sempre 404 se não
      // pertencer).
      const att = await prisma.attachment.findFirst({
        where: {
          id,
          message: { conversation: { accountId } },
        },
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          fileType: true,
          storagePath: true,
          storageStatus: true,
        },
      });

      if (!att) throw new NotFoundError('Attachment não encontrado');

      // Lazy materialize: se ainda não tá em disco (ou status failed por causa
      // de retry), pede ao storage service pra baixar agora.
      let absolutePath: string | null = null;
      let byteLength: number | null = null;
      let mimeType: string | null = att.mimeType ?? null;

      if (att.storagePath && att.storageStatus === 'downloaded') {
        try {
          const candidate = attachmentStorageService.resolveAbsolutePath(att.storagePath);
          const s = await stat(candidate);
          if (s.size > 0) {
            absolutePath = candidate;
            byteLength = s.size;
          }
        } catch {
          // arquivo sumiu — vai pro path lento abaixo
        }
      }

      if (!absolutePath) {
        const materialized = await attachmentStorageService.materialize(att.id);
        if (!materialized) {
          throw new NotFoundError('Attachment indisponível (falha ao baixar)');
        }
        absolutePath = materialized.absolutePath;
        byteLength = materialized.byteLength;
        mimeType = materialized.mimeType ?? mimeType;
      }

      // Defesa: se chegou aqui sem caminho, falha explícita.
      if (!absolutePath || byteLength == null) {
        throw new NotFoundError('Attachment indisponível');
      }

      const contentType = mimeType || this.defaultMime(att.fileType);
      const safeName = (att.fileName || `attachment-${id}`).replace(/"/g, '');

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(byteLength));
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Accel-Buffering', 'no'); // evita buffer em nginx pra streams grandes

      const stream = createReadStream(absolutePath);
      stream.on('error', (err) => {
        logger.error('[attachment] erro lendo arquivo do disco', {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (error) {
      next(error);
    }
  }

  private defaultMime(fileType: string): string {
    switch (fileType) {
      case 'image':
        return 'image/jpeg';
      case 'audio':
        return 'audio/ogg';
      case 'video':
        return 'video/mp4';
      case 'document':
        return 'application/pdf';
      default:
        return 'application/octet-stream';
    }
  }
}

export const attachmentController = new AttachmentController();
