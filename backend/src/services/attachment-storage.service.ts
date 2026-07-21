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

// FIX-INBOUND-MEDIA: sentinel de sourceUrl para mídia criptografada inbound
// sem url plana — materialize descriptografa via getBase64FromMediaMessage
// pelo externalId da mensagem.
export const WA_ENCRYPTED_MEDIA_SENTINEL = 'wa-encrypted-media://pending';

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

/**
 * PISTA D: retorno de storeFromBuffer — shape que o controller devolve pro
 * frontend fazer POST na message referenciando esse attachment via fileUrl
 * relativo (/api/attachments/<id>).
 */
export interface StoredAttachment {
  id: string;
  fileUrl: string;
  fileType: 'image' | 'video' | 'audio' | 'document';
  fileSize: number;
  mimeType: string;
  fileName: string | null;
  storagePath: string;
}

interface EvolutionConfigForDownload {
  baseUrl: string;
  apiKey: string;
}

/**
 * PISTA D: deriva fileType (image|video|audio|document) do MIME. Espelha
 * mimeToFileType do frontend (MessageComposer.tsx) pra que ambos os lados
 * classifiquem do mesmo jeito. Sticker eh tratado como image no upload
 * (o composer nao gera sticker).
 */
function deriveFileType(
  mimeType: string
): 'image' | 'video' | 'audio' | 'document' {
  const m = mimeType.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
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

/**
 * WhatsApp CDN (mmg.whatsapp.net) serve mídia end-to-end encrypted. Um GET
 * direto retorna bytes cifrados — o browser não decodifica. Precisamos pedir
 * pra Evolution descriptografar via chat/getBase64FromMediaMessage. Detecta
 * pelo host clássico (mmg.whatsapp.net), pelo path .enc, ou pelo params
 * `mms3=true` que a Evolution encaminha em `mediaUrl` de messages.upsert.
 */
function isWhatsAppCdn(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    if (/(^|\.)whatsapp\.net$/i.test(u.hostname)) return true;
    if (u.pathname.endsWith('.enc')) return true;
    if (u.searchParams.get('mms3') === 'true') return true;
    return false;
  } catch {
    return false;
  }
}

function decodeDataUrl(url: string): { mimeType: string; bytes: Buffer } | null {
  // RFC 2397: data:[<mediatype>][;param=value...][;base64],<data>
  // AUDIT-AUDIO-DATAURL: a regex antiga (`data:([^;]+)(;base64)?,`) não
  // aceitava parâmetros entre o mime e o ;base64 — e o MediaRecorder do
  // Chrome/Edge grava exatamente `data:audio/webm;codecs=opus;base64,...`.
  // TODO áudio gravado no composer falhava a materialização ('data URL
  // malformado' → storageStatus=failed) e o player do CRM mostrava "Não foi
  // possível carregar o áudio", embora o dispatch pro WhatsApp funcionasse
  // (usa decodeDataUrlBase64, que corta no primeiro ','). Parser alinhado.
  if (!/^data:/i.test(url)) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const header = url.slice(5, comma); // sem o prefixo 'data:'
  const payload = url.slice(comma + 1);
  const parts = header.split(';');
  const mimeType =
    (parts[0] || '').trim() || 'application/octet-stream';
  const isBase64 = parts.some((p) => p.trim().toLowerCase() === 'base64');
  try {
    const bytes = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf-8');
    if (payload.length > 0 && bytes.length === 0) return null;
    return { mimeType, bytes };
  } catch {
    return null;
  }
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
        message: {
          select: {
            id: true,
            externalId: true,
            conversationId: true,
            conversation: {
              select: {
                accountId: true,
                inbox: { select: { evolutionInstance: true } },
              },
            },
          },
        },
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
      } else if (isWhatsAppCdn(sourceUrl) || sourceUrl === WA_ENCRYPTED_MEDIA_SENTINEL) {
        // WhatsApp CDN (ou mídia inbound sem url plana — sentinel) entrega
        // arquivo criptografado end-to-end (magic bytes aleatórios). Pedimos a
        // Evolution que descriptografe usando a mediaKey armazenada pelo
        // Baileys — endpoint chat/getBase64FromMediaMessage, pelo messageId.
        const messageKeyId = att.message?.externalId;
        const instance = att.message?.conversation?.inbox?.evolutionInstance ?? null;
        if (!messageKeyId) {
          throw new Error('WhatsApp CDN sem message externalId — nao da pra descriptografar');
        }
        const { evolutionService } = await import('./evolution.service');
        const decrypted = await evolutionService.getBase64FromMediaMessage(accountId, {
          instance,
          messageKeyId,
        });
        if (!decrypted) {
          throw new Error('Evolution getBase64FromMediaMessage devolveu vazio');
        }
        bytes = Buffer.from(decrypted.base64, 'base64');
        mimeType = mimeType || decrypted.mimetype || null;
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

      // FIX-INBOUND-MEDIA: re-emite a mensagem via socket com o fileUrl real
      // (/api/attachments/<id>). Sem isto, a imagem/vídeo inbound aparecia
      // quebrada (fileUrl ainda era a URL cifrada/sentinel do momento do
      // create) até o refetch de 60s. Best-effort: nunca lança.
      const linkedMsgId = att.message?.id;
      const linkedConvId = att.message?.conversationId;
      if (linkedMsgId && linkedConvId) {
        try {
          const fresh = await prisma.message.findUnique({
            where: { id: linkedMsgId },
            include: { attachments: true },
          });
          if (fresh) {
            const { emitMessageUpdated } = await import('../socket');
            emitMessageUpdated(accountId, linkedConvId, fresh);
          }
        } catch (emitErr) {
          logger.debug('[attachment-storage] re-emit pós-materialize falhou', {
            attachmentId,
            error: emitErr instanceof Error ? emitErr.message : String(emitErr),
          });
        }
      }

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

  /**
   * PISTA D — Upload multipart dedicado.
   *
   * Persiste um buffer bruto (recebido via multer.memoryStorage no controller
   * /api/attachments/upload) no diretorio uploads/<accountId>/<uuid>.<ext> e
   * cria a row Attachment com messageId=null / storageStatus='downloaded'.
   * O controller retorna { id, fileUrl } pro frontend; quando o usuario
   * finaliza o composer, POST /api/conversations/:id/messages referencia
   * esse fileUrl e o message.service linka a row (messageId = novaMsg.id).
   *
   * Diferente de materialize(): NAO baixa nada da rede, NAO precisa de
   * Evolution config, e nao popula sourceUrl (nao existe URL "original" —
   * o upload veio do proprio browser do agente).
   *
   * Idempotente por accountId: dois uploads simultaneos geram uuids distintos
   * e paths distintos, sem colisao.
   */
  async storeFromBuffer(
    accountId: string,
    buffer: Buffer,
    mimeType: string,
    fileName: string | null
  ): Promise<StoredAttachment> {
    if (!accountId) {
      throw new Error('accountId obrigatorio pra storeFromBuffer');
    }
    if (!buffer || buffer.byteLength === 0) {
      throw new Error('buffer vazio');
    }
    const normalizedMime = (mimeType || 'application/octet-stream').trim();
    const fileType = deriveFileType(normalizedMime);
    const ext = extFromMime(normalizedMime);

    // uuid gerado pelo Prisma via @default(uuid()) — geramos manualmente
    // aqui pra montar o path ANTES do INSERT (senao teria que fazer 2
    // roundtrips: create + update com storagePath).
    const { randomUUID } = await import('node:crypto');
    const id = randomUUID();
    const relative = path.posix.join(accountId, `${id}.${ext}`);
    const abs = this.resolveAbsolutePath(relative);
    await ensureDir(path.dirname(abs));
    await fs.writeFile(abs, buffer);

    const apiUrl = `/api/attachments/${id}`;

    await prisma.attachment.create({
      data: {
        id,
        // messageId: nao populado — sera linkado pelo message.service quando
        // o composer fizer POST na message referenciando esse fileUrl.
        fileType,
        fileUrl: apiUrl,
        fileSize: buffer.byteLength,
        fileName: fileName ?? null,
        mimeType: normalizedMime,
        storagePath: relative,
        storageStatus: 'downloaded',
        // sourceUrl: null — nao ha URL "original" pra retry (upload do agente).
      },
    });

    logger.info('[attachment-storage] storeFromBuffer criou attachment', {
      attachmentId: id,
      accountId,
      bytes: buffer.byteLength,
      mimeType: normalizedMime,
      fileType,
      storagePath: relative,
    });

    return {
      id,
      fileUrl: apiUrl,
      fileType,
      fileSize: buffer.byteLength,
      mimeType: normalizedMime,
      fileName: fileName ?? null,
      storagePath: relative,
    };
  }
}

export const attachmentStorageService = new AttachmentStorageService();
