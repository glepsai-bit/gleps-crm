/**
 * ETAPA D — anexo opcional do disparo (imagem / PDF / áudio), que vai como
 * segunda mensagem 3–8 s depois do texto.
 *
 * Mesmo padrão do warmup-media: arquivo em backend/uploads (fora de qualquer
 * rota estática listável), validado por MIME + magic bytes + tamanho, e lido
 * do disco em base64 na hora de enviar pela Evolution.
 *
 * Caminho: uploads/disparos/<accountId>/<uuid>.<ext>. O `id` que volta pra
 * UI É esse caminho relativo — e na criação do disparo a referência só é
 * aceita se estiver dentro da pasta da própria conta (multi-tenant).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readMediaAsBase64 } from './warmup-media-loader';
import { ValidationError } from '../utils/errors';

export type TipoDeAnexo = 'imagem' | 'pdf' | 'audio';

export interface AnexoDeDisparo {
  /** Caminho relativo a uploads/ — é também o `id` que a UI devolve. */
  path: string;
  tipo: TipoDeAnexo;
  nome: string;
  mime: string;
  tamanho: number;
}

export interface ArquivoRecebido {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

const MB = 1024 * 1024;

export const LIMITE_POR_TIPO: Record<TipoDeAnexo, number> = {
  imagem: 2 * MB,
  pdf: 5 * MB,
  audio: 2 * MB,
};

/** O maior dos limites — teto do multer; o limite por tipo é conferido aqui. */
export const LIMITE_MAXIMO_BYTES = Math.max(...Object.values(LIMITE_POR_TIPO));

const TIPO_POR_MIME: Record<string, TipoDeAnexo> = {
  'image/jpeg': 'imagem',
  'image/png': 'imagem',
  'image/webp': 'imagem',
  'application/pdf': 'pdf',
  'audio/ogg': 'audio',
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/mp4': 'audio',
  'audio/x-m4a': 'audio',
  'audio/m4a': 'audio',
};

const EXT_POR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
};

// Assinatura binária por MIME: o Content-Type é declarado pelo cliente; sem
// isto um .exe "application/pdf" passaria e seria reenviado pelo chip.
const MAGIC_POR_MIME: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) =>
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  'image/webp': (b) =>
    b.length >= 12 &&
    b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  'application/pdf': (b) => b.length >= 4 && b.toString('ascii', 0, 4) === '%PDF',
  'audio/ogg': (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS',
  'audio/mpeg': (b) =>
    (b.length >= 3 && b.toString('ascii', 0, 3) === 'ID3') ||
    (b.length >= 2 && b[0] === 0xff && (b[1] === 0xfb || b[1] === 0xf3 || b[1] === 0xf2)),
  'audio/mp3': (b) => MAGIC_POR_MIME['audio/mpeg'](b),
  'audio/mp4': (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp',
  'audio/x-m4a': (b) => MAGIC_POR_MIME['audio/mp4'](b),
  'audio/m4a': (b) => MAGIC_POR_MIME['audio/mp4'](b),
};

function raizDosUploads(): string {
  return path.resolve(process.cwd(), 'uploads');
}

function nomeSeguro(original: string): string {
  // Sem separador de caminho, sem caractere de controle (< 32): o nome vai
  // pro WhatsApp como fileName e pro disco só como rótulo.
  const base = Array.from(path.basename(original || 'anexo'))
    .map((ch) => (ch.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(ch) ? '_' : ch))
    .join('')
    .trim();
  return (base || 'anexo').slice(0, 120);
}

class DisparoAnexoService {
  tipoPorMime(mime: string): TipoDeAnexo | null {
    return TIPO_POR_MIME[(mime || '').toLowerCase()] ?? null;
  }

  /** Valida (MIME, magic bytes, tamanho) e grava em uploads/disparos/<conta>/. */
  async salvar(accountId: string, arquivo: ArquivoRecebido): Promise<AnexoDeDisparo & { id: string }> {
    const mime = (arquivo.mimetype || '').toLowerCase();
    const tipo = this.tipoPorMime(mime);
    if (!tipo) {
      throw new ValidationError(
        'Formato não aceito. Envie imagem (jpg, png, webp), PDF ou áudio (ogg, mp3, m4a).',
        { mime }
      );
    }
    const confere = MAGIC_POR_MIME[mime];
    if (!confere || !confere(arquivo.buffer)) {
      throw new ValidationError('O conteúdo do arquivo não bate com o formato declarado.', { mime });
    }
    const limite = LIMITE_POR_TIPO[tipo];
    if (arquivo.size > limite || arquivo.buffer.length > limite) {
      throw new ValidationError(
        `Arquivo maior que ${Math.round(limite / MB)} MB — o limite para ${tipo === 'pdf' ? 'PDF' : tipo}.`,
        { tamanho: arquivo.size, limite }
      );
    }

    const ext = EXT_POR_MIME[mime] ?? 'bin';
    const nomeArquivo = `${randomUUID()}.${ext}`;
    const relativo = path.posix.join('disparos', accountId, nomeArquivo);
    const diretorio = path.join(raizDosUploads(), 'disparos', accountId);
    await fs.mkdir(diretorio, { recursive: true });
    await fs.writeFile(path.join(diretorio, nomeArquivo), arquivo.buffer);

    return {
      id: relativo,
      path: relativo,
      tipo,
      nome: nomeSeguro(arquivo.originalname),
      mime,
      tamanho: arquivo.buffer.length,
    };
  }

  /**
   * Confere a referência que a UI devolve no POST /disparos: tem que apontar
   * pra pasta DESTA conta e o arquivo tem que existir. Devolve o anexo
   * normalizado (sem `id`, que é só da API).
   */
  async validarReferencia(
    accountId: string,
    anexo: { id?: string; path?: string; tipo?: string; nome?: string; mime?: string; tamanho?: number }
  ): Promise<AnexoDeDisparo> {
    const relativo = (anexo.path || anexo.id || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const prefixo = `disparos/${accountId}/`;
    if (!relativo.startsWith(prefixo) || relativo.includes('..')) {
      throw new ValidationError('Anexo inválido: envie o arquivo de novo.');
    }
    const absoluto = path.resolve(raizDosUploads(), relativo);
    let tamanho = anexo.tamanho ?? 0;
    try {
      const st = await fs.stat(absoluto);
      tamanho = st.size;
    } catch {
      throw new ValidationError('Anexo não encontrado: envie o arquivo de novo.');
    }
    const mime = (anexo.mime || '').toLowerCase();
    const tipo = this.tipoPorMime(mime) ?? (anexo.tipo as TipoDeAnexo | undefined);
    if (!tipo || !['imagem', 'pdf', 'audio'].includes(tipo)) {
      throw new ValidationError('Anexo com tipo desconhecido: envie o arquivo de novo.');
    }
    return {
      path: relativo,
      tipo,
      nome: nomeSeguro(anexo.nome || path.basename(relativo)),
      mime: mime || (tipo === 'pdf' ? 'application/pdf' : ''),
      tamanho,
    };
  }

  /** Base64 puro do arquivo (anti-traversal no loader). */
  async lerBase64(relativo: string): Promise<string> {
    return readMediaAsBase64(relativo);
  }

  /** Remove o arquivo (best-effort; usado quando o disparo não chega a ser criado). */
  async remover(relativo: string): Promise<void> {
    try {
      await fs.unlink(path.resolve(raizDosUploads(), relativo));
    } catch {
      /* já não existe */
    }
  }
}

export const disparoAnexoService = new DisparoAnexoService();
