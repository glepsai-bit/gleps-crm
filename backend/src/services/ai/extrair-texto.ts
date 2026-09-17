/**
 * Extração de texto de PDF, Word e HTML pra base de conhecimento.
 *
 * Funções puras (buffer/string → texto) sem I/O de rede nem banco, pra serem
 * testáveis sozinhas. Quem orquestra (upload, URL, limites, criação do doc) é
 * o knowledge.service.
 *
 * O texto extraído vai direto pro chunker, então a saída preserva a estrutura
 * que ele entende: parágrafos separados por linha em branco, tabela como uma
 * linha por registro com células separadas por " | ".
 */

import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { AppError } from '../../utils/errors';

/**
 * Arquivo/página que não rende texto aproveitável. 422 e não 400: o pedido
 * estava bem formado, o conteúdo é que não serve — e a mensagem diz o que fazer.
 */
export class DocumentoIlegivelError extends AppError {
  constructor(message: string) {
    super(message, 422, 'DOCUMENTO_ILEGIVEL');
    Object.setPrototypeOf(this, DocumentoIlegivelError.prototype);
  }
}

/**
 * Abaixo disso um PDF é considerado escaneado (imagem sem camada de texto):
 * capa em branco ou só um rodapé não fazem uma base de conhecimento.
 */
export const MIN_CARACTERES_PDF = 50;

export function contarNaoBrancos(texto: string): number {
  return texto.replace(/\s/g, '').length;
}

/**
 * Normaliza o que sai de qualquer extrator: quebras de linha uniformes, sem
 * espaço sobrando nas pontas das linhas, no máximo uma linha em branco seguida.
 */
export function limparTexto(texto: string): string {
  return texto
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ============================================
// PDF
// ============================================

export async function extrairPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  let texto: string;
  try {
    const r = await parser.getText();
    // `r.text` intercala marcadores "-- 1 of 3 --" entre páginas; o que vai
    // pro índice é o conteúdo, página após página.
    texto = r.pages.map((p) => p.text ?? '').join('\n\n');
  } catch (err) {
    const nome = err instanceof Error ? err.name : '';
    if (nome === 'PasswordException') {
      throw new DocumentoIlegivelError(
        'PDF protegido por senha. Remova a senha e envie de novo, ou cole o conteúdo.'
      );
    }
    throw new DocumentoIlegivelError(
      'Não consegui ler este PDF (arquivo corrompido ou em formato inesperado). Converta pra texto ou cole o conteúdo.'
    );
  } finally {
    await parser.destroy().catch(() => undefined);
  }

  const limpo = limparTexto(texto);
  if (contarNaoBrancos(limpo) < MIN_CARACTERES_PDF) {
    throw new DocumentoIlegivelError(
      'PDF sem texto (provavelmente escaneado). Não é lido: converta pra texto ou cole o conteúdo.'
    );
  }
  return limpo;
}

// ============================================
// Word (.docx)
// ============================================

export async function extrairDocx(buffer: Buffer): Promise<string> {
  let texto: string;
  try {
    const r = await mammoth.extractRawText({ buffer });
    texto = r.value ?? '';
  } catch {
    throw new DocumentoIlegivelError(
      'Não consegui ler este arquivo Word. Só .docx é aceito (o .doc antigo não): salve como .docx ou cole o conteúdo.'
    );
  }

  const limpo = limparTexto(texto);
  if (!limpo) {
    throw new DocumentoIlegivelError(
      'O arquivo Word não tem texto (só imagens?). Cole o conteúdo ou envie outro arquivo.'
    );
  }
  return limpo;
}

// ============================================
// HTML
// ============================================

/** Elementos que nunca têm texto legível pro atendimento. */
const TAGS_DESCARTADAS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'head',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
];

/** Fecham um parágrafo: texto antes e depois não deve colar. */
const TAGS_BLOCO = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'blockquote',
  'pre',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'table',
  'figure',
  'figcaption',
  'address',
  'details',
  'summary',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

const ENTIDADES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  euro: '€',
  deg: '°',
  ccedil: 'ç',
  Ccedil: 'Ç',
  atilde: 'ã',
  otilde: 'õ',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  acirc: 'â',
  ecirc: 'ê',
  ocirc: 'ô',
  agrave: 'à',
};

export function decodificarEntidades(texto: string): string {
  return texto.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (tudo, corpo: string) => {
    if (corpo[0] === '#') {
      const hex = corpo[1] === 'x' || corpo[1] === 'X';
      const codigo = parseInt(corpo.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(codigo) && codigo > 0 && codigo < 0x110000
        ? String.fromCodePoint(codigo)
        : tudo;
    }
    return ENTIDADES[corpo] ?? ENTIDADES[corpo.toLowerCase()] ?? tudo;
  });
}

/**
 * HTML → texto legível, sem dependência: títulos e parágrafos separados por
 * linha em branco, item de lista com "- ", tabela como "célula | célula" por
 * linha. O que não é conteúdo (script, style, nav, cabeçalho, rodapé) some.
 */
export function extrairHtml(html: string): string {
  let h = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of TAGS_DESCARTADAS) {
    h = h.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
  }

  const partes: string[] = [];
  let dentroDePre = 0;
  let primeiraCelula = true;
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;
  let ultimo = 0;

  const texto = (bruto: string) => {
    if (!bruto) return;
    const decodificado = decodificarEntidades(bruto);
    partes.push(dentroDePre > 0 ? decodificado : decodificado.replace(/\s+/g, ' '));
  };

  for (let m = tagRe.exec(h); m; m = tagRe.exec(h)) {
    texto(h.slice(ultimo, m.index));
    ultimo = m.index + m[0].length;

    const tag = m[1].toLowerCase();
    const fechando = m[0][1] === '/';

    if (tag === 'br') {
      partes.push('\n');
    } else if (tag === 'li') {
      // Só na abertura: item vira "- texto" numa linha, e itens seguidos ficam
      // em linhas consecutivas (linha em branco entre eles viraria parágrafo).
      if (!fechando) partes.push('\n- ');
    } else if (tag === 'tr') {
      // Idem: linhas da tabela consecutivas, senão o chunker não vê a tabela.
      if (!fechando) {
        partes.push('\n');
        primeiraCelula = true;
      }
    } else if (tag === 'td' || tag === 'th') {
      if (!fechando) {
        if (!primeiraCelula) partes.push(' | ');
        primeiraCelula = false;
      }
    } else if (TAGS_BLOCO.has(tag)) {
      if (tag === 'pre') dentroDePre += fechando ? -1 : 1;
      partes.push('\n\n');
    }
  }
  texto(h.slice(ultimo));

  return limparTexto(partes.join(''));
}
