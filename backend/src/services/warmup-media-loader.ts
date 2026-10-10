/**
 * Leitura de mídia de `backend/uploads` em base64 pra mandar à Evolution
 * (usado pelo anexo de disparo — disparo-anexo.service).
 *
 * Anti-traversal: validamos que o path resolvido nao escapa de UPLOADS_ROOT.
 * Padrao seguido: attachment-storage.service.ts (mesma raiz UPLOADS_ROOT).
 * NAO servimos uploads/ via express.static — o que vai pra Evolution eh inline.
 *
 * (O nome do arquivo vem do aquecimento antigo, que saiu na etapa C1; a
 * função ficou porque o motor de disparos a usa.)
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');

/**
 * Le um arquivo dentro de UPLOADS_ROOT e devolve seu conteudo em base64.
 * `relativePath` deve ser relativo a UPLOADS_ROOT (ex: 'disparos/<conta>/abc.ogg').
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
