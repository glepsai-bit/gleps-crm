/**
 * T-023 V2 — Warmup Media Loader
 *
 * Helper para resolver o payload de midia que vai ser enviado pra Evolution:
 *  - Se template.mediaUrl preenchido (URL absoluta, ex: CDN/S3), retorna a URL.
 *  - Caso contrario, le do disco (uploads/<accountId>/warmup/<type>/<file>) e
 *    converte pra base64 inline (Evolution aceita base64 raw OU URL http(s)).
 *
 * Anti-traversal: validamos que o path resolvido nao escapa de UPLOADS_ROOT.
 *
 * Padrao seguido: attachment-storage.service.ts (mesma raiz UPLOADS_ROOT).
 * NAO servimos uploads/ via express.static — o que vai pra Evolution eh inline.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');

export interface MediaTemplateRef {
  mediaUrl?: string | null;
  mediaPath?: string | null;
}

/**
 * Le um arquivo dentro de UPLOADS_ROOT e devolve seu conteudo em base64.
 * `relativePath` deve ser relativo a UPLOADS_ROOT (ex: 'acc-id/warmup/audio/abc.ogg').
 *
 * Lanca Error('Path traversal detectado') se o path tentar escapar de UPLOADS_ROOT.
 */
export async function readMediaAsBase64(relativePath: string): Promise<string> {
  if (!relativePath || typeof relativePath !== 'string') {
    throw new Error('mediaPath vazio');
  }

  // Resolve e normaliza
  const fullPath = path.resolve(UPLOADS_ROOT, relativePath);

  // Anti-traversal: garante que fullPath esta dentro de UPLOADS_ROOT.
  // Append separator pra evitar match parcial (ex: /uploads-malicioso/).
  const rootWithSep = UPLOADS_ROOT.endsWith(path.sep)
    ? UPLOADS_ROOT
    : UPLOADS_ROOT + path.sep;
  if (!fullPath.startsWith(rootWithSep) && fullPath !== UPLOADS_ROOT) {
    throw new Error('Path traversal detectado');
  }

  const buf = await fs.readFile(fullPath);
  return buf.toString('base64');
}

/**
 * Resolve o payload de midia a enviar pra Evolution.
 *
 * Prioridade:
 *  1. template.mediaUrl absoluta (http(s)://...) -> retorna como esta.
 *  2. template.mediaPath -> le do disco e devolve base64.
 *  3. erro: 'Template sem media' (caller deve cair em fallback).
 */
export async function resolveMediaPayload(template: MediaTemplateRef): Promise<string> {
  if (template.mediaUrl && /^https?:\/\//i.test(template.mediaUrl)) {
    return template.mediaUrl;
  }
  if (template.mediaPath) {
    return readMediaAsBase64(template.mediaPath);
  }
  throw new Error('Template sem media');
}
