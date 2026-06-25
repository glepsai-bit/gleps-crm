/**
 * media-base64.util.ts
 * ====================
 *
 * Helpers para lidar com mídia (imagem/áudio/vídeo/documento) entre o CRM e a
 * Evolution API. Suporta dois fluxos:
 *
 *   1) **Base64 inline** — o cliente envia `mediaBase64` (data URL ou base64
 *      puro). A Evolution aceita data URL diretamente no campo `media` de
 *      `/message/sendMedia` e `audio` de `/message/sendWhatsAppAudio`
 *      (ver evolution.service.ts: regex `^data:`). Nesse caso o caller pode
 *      passar o data URL direto, sem precisar gravar arquivo temporário.
 *
 *   2) **Arquivo temporário servido por URL pública** — quando o payload é
 *      grande demais pra inline ou quando a Evolution não conseguir baixar
 *      direto do base64 (alguns proxies cortam payloads > 5MB), gravamos em
 *      disco e devolvemos uma URL absoluta no formato:
 *
 *         {PUBLIC_API_URL}/api/temp-media/{id}.{ext}
 *
 *      Cada arquivo tem TTL configurável (default 5 minutos); o caller é
 *      responsável por chamar `cleanupExpired()` periodicamente OU agendar
 *      um `setTimeout` no save.
 *
 * Este módulo é **stateless** em memória (apenas tracking de TTL em Map);
 * todo o conteúdo persiste em disco em `backend/uploads/temp/`. Isso permite
 * múltiplos workers compartilharem (desde que os arquivos sejam servidos por
 * Express estático na mesma máquina).
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ValidationError } from './errors';
import { logger } from './logger';

// ============================================
// Types
// ============================================

export interface DecodedDataUrl {
  /** ex: "image/jpeg", "audio/ogg", "application/pdf" */
  mimeType: string;
  /** payload binário decodificado */
  buffer: Buffer;
}

export interface SavedTempMedia {
  /** id (UUID) gerado para o arquivo, usado também como nome no disco */
  id: string;
  /** caminho absoluto no FS local (útil pra testes / debug) */
  tempPath: string;
  /**
   * URL pública absoluta para a Evolution baixar o arquivo. Formato:
   *   {PUBLIC_API_URL}/api/temp-media/{id}.{ext}
   * Se `PUBLIC_API_URL` não estiver setado, retorna caminho relativo
   * (`/api/temp-media/...`) — caller deve garantir que a Evolution consegue
   * resolver isso (em geral só funciona quando os dois rodam na mesma máquina).
   */
  url: string;
  /** mime detectado/passado, ex: "image/jpeg" */
  mimeType: string;
  /** quando o arquivo será considerado expirado (Date.now() + ttlMs) */
  expiresAt: Date;
}

export interface FetchedMedia {
  buffer: Buffer;
  mimeType: string;
}

// ============================================
// Internal state — tracking de TTL para cleanup
// ============================================

interface TempFileEntry {
  id: string;
  tempPath: string;
  expiresAt: number;
  timer?: NodeJS.Timeout;
}

const tempRegistry = new Map<string, TempFileEntry>();

// ============================================
// Constants
// ============================================

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min — tempo padrão pra Evolution baixar
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB — limite WhatsApp pra documento

/**
 * Mapa básico de mimeType → extensão (apenas formatos que o WhatsApp aceita).
 * Lista intencionalmente curta — extensões desconhecidas caem no fallback `.bin`.
 */
const MIME_EXT_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
};

// ============================================
// Helpers
// ============================================

/**
 * Resolve diretório onde os arquivos temporários são gravados. Pode ser
 * sobrescrito via `TEMP_MEDIA_DIR` (útil em testes). Default:
 * `<cwd>/backend/uploads/temp` se rodando no monorepo, ou `os.tmpdir()/gleps-temp-media`.
 */
function getTempDir(): string {
  if (process.env.TEMP_MEDIA_DIR) {
    return process.env.TEMP_MEDIA_DIR;
  }
  // Quando processo roda dentro de /backend (npm run dev), cwd é o backend.
  // Quando roda na raiz do monorepo, queremos `backend/uploads/temp`.
  const cwd = process.cwd();
  const looksLikeBackend = path.basename(cwd) === 'backend';
  return looksLikeBackend
    ? path.join(cwd, 'uploads', 'temp')
    : path.join(cwd, 'backend', 'uploads', 'temp');
}

/** Garante existência do diretório (idempotente). */
async function ensureTempDir(): Promise<string> {
  const dir = getTempDir();
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    // Fallback: se /backend/uploads/temp não puder ser criado (permissões),
    // cai pra os.tmpdir(). Loga warning pra investigação.
    logger.warn('media-base64: falha ao criar TEMP_MEDIA_DIR, usando os.tmpdir()', {
      attempted: dir,
      error: err instanceof Error ? err.message : String(err),
    });
    const fallback = path.join(os.tmpdir(), 'gleps-temp-media');
    await fs.mkdir(fallback, { recursive: true });
    return fallback;
  }
  return dir;
}

function extFromMime(mimeType: string): string {
  const lower = (mimeType || '').toLowerCase().split(';')[0].trim();
  return MIME_EXT_MAP[lower] || 'bin';
}

function buildPublicUrl(id: string, ext: string): string {
  const baseRaw =
    process.env.PUBLIC_API_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    process.env.API_BASE_URL ||
    '';
  const base = baseRaw.replace(/\/+$/, '');
  const pathPart = `/api/temp-media/${id}.${ext}`;
  return base ? `${base}${pathPart}` : pathPart;
}

// ============================================
// Public API
// ============================================

/**
 * Decodifica uma data URL no formato `data:<mime>;base64,<payload>` para
 * `{ mimeType, buffer }`.
 *
 * Aceita variantes:
 *   - `data:image/jpeg;base64,XXXX`
 *   - `data:application/pdf;name=foo.pdf;base64,XXXX` (params são descartados)
 *   - `data:;base64,XXXX` (sem mime — vira `application/octet-stream`)
 *
 * Lança `ValidationError` se o formato for inválido ou se o payload exceder
 * `MAX_MEDIA_BYTES` (25MB).
 */
export function decodeDataUrl(dataUrl: string): DecodedDataUrl {
  if (typeof dataUrl !== 'string' || dataUrl.trim() === '') {
    throw new ValidationError('dataUrl é obrigatório');
  }

  const trimmed = dataUrl.trim();
  // Regex tolerante: captura mime opcional, ignora params extras, exige `;base64,`.
  const match = trimmed.match(/^data:([^;,]*)(?:;[^,]*)?;base64,(.+)$/i);
  if (!match) {
    throw new ValidationError(
      'dataUrl inválido — esperado formato data:<mime>;base64,<payload>'
    );
  }

  const rawMime = (match[1] || '').trim();
  const mimeType = rawMime !== '' ? rawMime.toLowerCase() : 'application/octet-stream';
  const payload = match[2].replace(/\s+/g, ''); // remove whitespace/quebras

  let buffer: Buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch {
    throw new ValidationError('dataUrl inválido — payload base64 corrompido');
  }

  if (buffer.length === 0) {
    throw new ValidationError('dataUrl inválido — payload base64 vazio');
  }

  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new ValidationError(
      `Mídia excede tamanho máximo (${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB)`
    );
  }

  return { mimeType, buffer };
}

/**
 * Reconstrói uma data URL a partir de buffer + mime. Útil quando o caller
 * quer passar inline pra Evolution sem gravar arquivo.
 */
export function toDataUrl(buffer: Buffer, mimeType: string): string {
  const mime = (mimeType || 'application/octet-stream').toLowerCase();
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * Salva mídia em arquivo temporário e devolve URL pública pra Evolution baixar.
 *
 * Estratégia:
 *   1. Gera UUID, monta caminho `<TEMP_MEDIA_DIR>/<uuid>.<ext>`
 *   2. Grava o buffer
 *   3. Registra entry com TTL (default 5min) — após o tempo, deleta do disco
 *   4. Retorna `{ url, tempPath, mimeType, expiresAt }`
 *
 * O caller é tipicamente o adapter Evolution: quando `mediaBase64` chega muito
 * grande pra inline, este helper produz a URL que a Evolution baixa via HTTP.
 */
export async function saveTempMedia(
  buffer: Buffer,
  mimeType: string,
  options: { filename?: string; ttlMs?: number } = {}
): Promise<SavedTempMedia> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ValidationError('buffer vazio ou inválido');
  }
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new ValidationError(
      `Mídia excede tamanho máximo (${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB)`
    );
  }

  const dir = await ensureTempDir();
  const id = randomUUID();
  const ext = extFromMime(mimeType);
  const tempPath = path.join(dir, `${id}.${ext}`);

  await fs.writeFile(tempPath, buffer);

  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  // Agendamento de cleanup. unref() pra não segurar o process.exit.
  const timer = setTimeout(() => {
    void deleteTempFile(id).catch((err) => {
      logger.warn('media-base64: cleanup timer falhou', { id, error: String(err) });
    });
  }, ttlMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  tempRegistry.set(id, { id, tempPath, expiresAt: expiresAt.getTime(), timer });

  logger.info('media-base64: temp file salvo', {
    id,
    mimeType,
    bytes: buffer.length,
    ttlMs,
    filename: options.filename,
  });

  return {
    id,
    tempPath,
    url: buildPublicUrl(id, ext),
    mimeType,
    expiresAt,
  };
}

/**
 * Recupera o caminho FS de um temp file (usado pelo route handler
 * `/api/temp-media/:id`). Retorna `null` se id desconhecido ou expirado.
 */
export function getTempFile(idOrFilename: string): { tempPath: string; expiresAt: Date } | null {
  // Aceita tanto `uuid` quanto `uuid.ext` (route handler pode passar ambos).
  const id = idOrFilename.includes('.') ? idOrFilename.split('.')[0] : idOrFilename;
  const entry = tempRegistry.get(id);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    // Expirou — disparar delete async, devolver null pro caller.
    void deleteTempFile(id).catch(() => undefined);
    return null;
  }
  return { tempPath: entry.tempPath, expiresAt: new Date(entry.expiresAt) };
}

/**
 * Remove um temp file do disco e do registry. Idempotente.
 */
export async function deleteTempFile(id: string): Promise<void> {
  const entry = tempRegistry.get(id);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  tempRegistry.delete(id);
  try {
    await fs.unlink(entry.tempPath);
  } catch (err) {
    // Não-fatal: arquivo pode já ter sumido. Logamos só em debug.
    logger.debug('media-base64: unlink falhou (ok se arquivo já sumiu)', {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Varre o registry e remove qualquer entry expirada. Chamado pelo timer
 * individual de cada save, mas exposto pra testes e pra um eventual cron
 * de saneamento (se um worker reiniciar e os timers se perderem).
 */
export async function cleanupExpired(): Promise<number> {
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, entry] of tempRegistry.entries()) {
    if (entry.expiresAt < now) expired.push(id);
  }
  for (const id of expired) {
    await deleteTempFile(id);
  }
  return expired.length;
}

/**
 * Baixa mídia de uma URL pública (caller passa `mediaUrl` http(s)).
 * Devolve `{ buffer, mimeType }` — útil quando precisamos transformar a URL
 * em base64 inline (ex: para retransmitir, fazer thumbnail, salvar).
 *
 * Em geral o caller NÃO precisa disso: a Evolution baixa URLs HTTP por si só.
 * Use apenas quando precisar processar o conteúdo no CRM antes de mandar.
 */
export async function fetchFromUrl(
  url: string,
  options: { timeoutMs?: number } = {}
): Promise<FetchedMedia> {
  if (!/^https?:\/\//i.test(url)) {
    throw new ValidationError('fetchFromUrl: esperado http(s)://...');
  }
  const timeoutMs = options.timeoutMs ?? 30000;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(
      `fetchFromUrl falhou: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!response.ok) {
    throw new Error(`fetchFromUrl retornou status ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length') || '0');
  if (contentLength > MAX_MEDIA_BYTES) {
    throw new ValidationError(
      `Mídia excede tamanho máximo (${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB)`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new ValidationError(
      `Mídia excede tamanho máximo (${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB)`
    );
  }

  const mimeType =
    (response.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0]
      .trim()
      .toLowerCase();

  return { buffer, mimeType };
}

// Exposto pra testes — não chamar em produção.
export const __internal = {
  getTempDir,
  ensureTempDir,
  extFromMime,
  buildPublicUrl,
  tempRegistry,
  MAX_MEDIA_BYTES,
  DEFAULT_TTL_MS,
};
