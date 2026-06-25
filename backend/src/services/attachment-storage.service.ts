/**
 * ATTACHMENT STORAGE SERVICE — Bug A (T-022)
 *
 * Problema: o frontend recebia diretamente a URL Evolution (ex.: directPath /
 * mediaUrl). Essa URL precisa do header `apikey` para autorizar download e
 * não roda CORS pra origem do CRM, então o <audio src=...> não tocava — o
 * elemento permanecia no estado readyState=0 e o browser silenciava o erro.
 *
 * Solução: backend baixa a mídia (com apikey) no momento do webhook
 * messages.upsert, materializa em disco (uploads/<accountId>/<id>.<ext>) e
 * passa a servir via endpoint autenticado GET /api/attachments/:id. O
 * frontend só vê uma URL nossa, com Bearer JWT, sem CORS exótico.
 *
 * Fallback: se a Evolution responder com base64 inline (caso comum em audio
 * PTT), gravamos o base64 decodificado. Se o download falhar, marcamos
 * storage_status='failed' e a próxima leitura tenta de novo (lazy retry).
 *
 * Convenções:
 *   - Diretório raiz: <repo>/backend/uploads/ (em prod, montar volume).
 *   - Caminho relativo gravado no DB: '<accountId>/<id>.<ext>' (sem prefixo)
 *   - resolvePath() junta sempre com UPLOADS_ROOT — nenhum path absoluto vai
 *     pro DB pra que deploy/CDN reescrita seja transparente.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

// ============================================
// Config
// ============================================

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');

const MIME_EXT_FALLBACK: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
};

// ============================================
// Types
// ============================================

export interface MaterializedAttachment {
  storagePath: string; // relativo a UPLOADS_ROOT
  absolutePath: string;
  byteLength: number;
  mimeType: string | null;
}

interface EvolutionConfigForDownload {
  baseUrl: string;
  apiKey: string;
}

// ============================================
// Helpers
// ============================================

function extFromMime(mime: string | null | undefined): string {
  if (!mime) return 'bin';
  const lower = mime.toLowerCase();
  if (MIME_EXT_FALLBACK[lower]) return MIME_EXT_FALLBACK[lower];
  // ex.: 'audio/ogg; codecs=opus' → pega antes do ;
  const base = lower.split(';')[0]?.trim();
  if (base && MIME_EXT_FALLBACK[base]) return MIME_EXT_FALLBACK[base];
  const slash = base?.split('/')[1];
  return (slash || 'bin').replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
}

function isDataUrl(url: string): boolean {
  return /^data:/i.test(url);
}

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function decodeDataUrl(url: string): { mimeType: string; bytes: Buffer } | null {
  // data:audio/ogg;base64,XXXX
  const match = url.match(/^data:([^;]+)(;base64)?,(.+)$/i);
  if (!match) return null;
  const mimeType = match[1] || 'application/octet-stream';
  const isBase64 = match[2] === ';base64';
  const payload = match[3] || '';
  const bytes = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf-8');
  return { mimeType, bytes };
}

async function ensureDir(absDir: string): Promise<void> {
  await fs.mkdir(absDir, { recursive: true });
}

// ============================================
// Service
// ============================================

class AttachmentStorageService {
  getUploadsRoot(): string {
    return UPLOADS_ROOT;
  }

  resolveAbsolutePath(storagePath: string): string {
    // Defesa anti-path-traversal: rejeita qualquer caminho que escape de UPLOADS_ROOT.
    const safeRelative = storagePath.replace(/^[/\\]+/, '');
    const abs = path.resolve(UPLOADS_ROOT, safeRelative);
    if (!abs.startsWith(UPLOADS_ROOT + path.sep) && abs !== UPLOADS_ROOT) {
      throw new Error(`storagePath fora da raiz uploads: ${storagePath}`);
    }
    return abs;
  }

  /**
   * Resolve credenciais Evolution para um accountId — duplica a lógica
   * de evolution.service mas SEM exigir `evolutionInstance` (download é
   * orientado por URL absoluta da própria Evolution, basta apikey).
   */
  private async getDownloadConfig(
    accountId: string
  ): Promise<EvolutionConfigForDownload | null> {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { evolutionBaseUrl: true, evolutionApiKey: true },
    });
    if (account?.evolutionBaseUrl && account?.evolutionApiKey) {
      return {
        baseUrl: account.evolutionBaseUrl.replace(/\/$/, ''),
        apiKey: account.evolutionApiKey,
      };
    }
    // Cai pro singleton global de SystemSettings (lazy import pra evitar ciclo).
    try {
      const { systemSettingsService } = await import('./system-settings.service');
      const global = await systemSettingsService.getEvolutionConfig();
      if (global) {
        return {
          baseUrl: global.baseUrl.replace(/\/$/, ''),
          apiKey: global.apiKey,
        };
      }
    } catch (err) {
      logger.warn('[attachment-storage] falhou ao carregar config global', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  /**
   * Baixa de uma URL HTTP arbitrária da Evolution. Se a URL pertence ao mesmo
   * baseUrl da Evolution da conta, anexamos o header `apikey` — sem isso a
   * Evolution responde 401/403 em mídias.
   */
  private async fetchFromHttp(
    accountId: string,
    url: string
  ): Promise<{ bytes: Buffer; mimeType: string | null }> {
    const cfg = await this.getDownloadConfig(accountId);

    const headers: Record<string, string> = {};
    if (cfg && url.startsWith(cfg.baseUrl)) {
      headers.apikey = cfg.apiKey;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(
        `Download mídia falhou: ${response.status} ${response.statusText} (${url})`
      );
    }

    const arrayBuf = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuf);
    const mimeType = response.headers.get('content-type');
    return { bytes, mimeType };
  }

  /**
   * Materializa o attachment em disco se ainda não estiver materializado.
   * Idempotente: chamadas concorrentes para o mesmo id resolvem-se pelo lock
   * implícito do filesystem (fs.writeFile sobrescreve atomicamente em ext4/apfs).
   *
   * Retorna o MaterializedAttachment com o caminho absoluto pronto pra stream.
   */
  async materialize(attachmentId: string): Promise<MaterializedAttachment | null> {
    const att = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: {
        id: true,
        storagePath: true,
        storageStatus: true,
        sourceUrl: true,
        fileUrl: true,
        mimeType: true,
        message: { select: { conversation: { select: { accountId: true } } } },
      },
    });

    if (!att) return null;

    const accountId = att.message?.conversation?.accountId;
    if (!accountId) {
      logger.warn('[attachment-storage] attachment sem accountId derivável', {
        attachmentId,
      });
      return null;
    }

    // Caminho rápido: já está em disco.
    if (att.storagePath && att.storageStatus === 'downloaded') {
      try {
        const abs = this.resolveAbsolutePath(att.storagePath);
        const stat = await fs.stat(abs);
        if (stat.size > 0) {
          return {
            storagePath: att.storagePath,
            absolutePath: abs,
            byteLength: stat.size,
            mimeType: att.mimeType ?? null,
          };
        }
        // 0 bytes ou inexistente: refaz download
        logger.warn('[attachment-storage] arquivo em disco corrompido — refaz download', {
          attachmentId,
        });
      } catch {
        // some falhou; refaz
      }
    }

    // URL pra baixar: prioriza sourceUrl (preserva original), fallback fileUrl.
    const sourceUrl = att.sourceUrl || att.fileUrl;
    if (!sourceUrl) {
      await this.markFailed(attachmentId, 'sem URL fonte');
      return null;
    }

    try {
      let bytes: Buffer;
      let mimeType: string | null = att.mimeType ?? null;

      if (isDataUrl(sourceUrl)) {
        const decoded = decodeDataUrl(sourceUrl);
        if (!decoded) throw new Error('data URL malformado');
        bytes = decoded.bytes;
        mimeType = mimeType || decoded.mimeType;
      } else if (isAbsoluteHttp(sourceUrl)) {
        const fetched = await this.fetchFromHttp(accountId, sourceUrl);
        bytes = fetched.bytes;
        mimeType = mimeType || fetched.mimeType;
      } else {
        throw new Error(`URL fonte sem scheme suportado: ${sourceUrl.slice(0, 60)}`);
      }

      if (bytes.byteLength === 0) {
        throw new Error('download retornou 0 bytes');
      }

      const ext = extFromMime(mimeType);
      const relative = path.posix.join(accountId, `${attachmentId}.${ext}`);
      const abs = this.resolveAbsolutePath(relative);
      await ensureDir(path.dirname(abs));
      await fs.writeFile(abs, bytes);

      const apiUrl = `/api/attachments/${attachmentId}`;

      await prisma.attachment.update({
        where: { id: attachmentId },
        data: {
          storagePath: relative,
          storageStatus: 'downloaded',
          fileSize: bytes.byteLength,
          mimeType: mimeType ?? undefined,
          // sourceUrl preserva a URL original — não mexemos.
          fileUrl: apiUrl,
        },
      });

      logger.info('[attachment-storage] materializou attachment', {
        attachmentId,
        bytes: bytes.byteLength,
        mimeType,
        storagePath: relative,
      });

      return {
        storagePath: relative,
        absolutePath: abs,
        byteLength: bytes.byteLength,
        mimeType,
      };
    } catch (err) {
      await this.markFailed(
        attachmentId,
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }
  }

  private async markFailed(attachmentId: string, reason: string): Promise<void> {
    logger.warn('[attachment-storage] marcando attachment failed', {
      attachmentId,
      reason,
    });
    try {
      await prisma.attachment.update({
        where: { id: attachmentId },
        data: { storageStatus: 'failed' },
      });
    } catch {
      // best-effort
    }
  }
}

export const attachmentStorageService = new AttachmentStorageService();
