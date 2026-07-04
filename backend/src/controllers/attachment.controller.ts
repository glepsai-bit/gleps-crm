/**
 * ATTACHMENT CONTROLLER — Bug A (T-022) + PISTA D (upload multipart)
 *
 * GET /api/attachments/:id
 *   Streama a mídia já materializada em disco (ou força materialização lazy
 *   se ainda estiver pending). Autenticação JWT obrigatória (rota está sob
 *   o stack /api comum). RBAC:
 *   - Se o attachment tem messageId (fluxo Evolution + legacy), valida via
 *     conversation.accountId.
 *   - PISTA D: se messageId=NULL (upload pending do agente), valida via
 *     storagePath prefix (accountId eh o primeiro segmento — `<accountId>/`).
 *
 * POST /api/attachments/upload  (PISTA D)
 *   Multipart form-data: campo `file` (binary) + campo `conversationId`.
 *   Valida ownership da conversationId, grava buffer em disco via
 *   storeFromBuffer, retorna { id, fileUrl, fileType, fileSize, mimeType }.
 *   O composer usa fileUrl (/api/attachments/<id>) no proximo POST de
 *   message — o message.service linka a row pre-existente.
 *
 * Headers de resposta (stream):
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
      //
      // PISTA D: attachments criados via POST /api/attachments/upload podem
      // ter messageId=NULL (upload pending, ainda nao linkado a nenhuma msg).
      // Nesses casos o filtro por message.conversation.accountId eh vazio.
      // Fallback: valida via storagePath — o layout eh `<accountId>/<id>.<ext>`,
      // entao startsWith(`${accountId}/`) equivale a "pertence a essa conta".
      const att = await prisma.attachment.findFirst({
        where: {
          id,
          OR: [
            // Fluxo padrao: attachment ja linkado a uma message da conta.
            { message: { conversation: { accountId } } },
            // PISTA D: upload pending do agente — messageId ainda null.
            // storagePath prefixado por `<accountId>/` prova o pertencimento.
            {
              messageId: null,
              storagePath: { startsWith: `${accountId}/` },
            },
          ],
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

  /**
   * PISTA D — POST /api/attachments/upload
   *
   * Multipart form-data: campo `file` (binary) + campo `conversationId`.
   * Fluxo hibrido do MessageComposer: anexos ate 5MB seguem base64 inline,
   * arquivos maiores sobem por aqui (upload dedicado) e o composer envia
   * a message referenciando fileUrl=/api/attachments/<id>.
   *
   * Validacoes:
   *   - conversationId pertence a accountId do usuario (RBAC).
   *   - file presente + nao vazio (multer garante limits.fileSize).
   *   - mimetype string nao vazia.
   *
   * NAO cria Message aqui — apenas Attachment com messageId=null. O link
   * ocorre no proximo POST /api/conversations/:id/messages, na mesma
   * transacao que cria a Message (message.service).
   */
  async upload(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const accountId = getAccountId(req);

      const file = (req as unknown as { file?: Express.Multer.File }).file;
      if (!file) {
        throw new ValidationError('Arquivo obrigatorio (campo "file")');
      }
      if (!file.buffer || file.buffer.byteLength === 0) {
        throw new ValidationError('Arquivo vazio');
      }

      const conversationId =
        typeof req.body?.conversationId === 'string'
          ? req.body.conversationId.trim()
          : '';
      if (!conversationId) {
        throw new ValidationError('conversationId obrigatorio');
      }

      // RBAC: garante que a conversa pertence a accountId. Nao vazamos
      // 404 vs 403 — sempre NotFound se cross-tenant.
      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, accountId },
        select: { id: true },
      });
      if (!conversation) {
        throw new NotFoundError('Conversa nao encontrada');
      }

      const stored = await attachmentStorageService.storeFromBuffer(
        accountId,
        file.buffer,
        file.mimetype || 'application/octet-stream',
        file.originalname || null
      );

      logger.info('[attachment] upload multipart concluido', {
        attachmentId: stored.id,
        conversationId,
        accountId,
        bytes: stored.fileSize,
        mimeType: stored.mimeType,
        fileType: stored.fileType,
      });

      res.status(201).json({
        data: {
          id: stored.id,
          fileUrl: stored.fileUrl,
          fileType: stored.fileType,
          fileSize: stored.fileSize,
          mimeType: stored.mimeType,
          fileName: stored.fileName,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const attachmentController = new AttachmentController();
