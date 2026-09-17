/**
 * T-027 Fase 1 — quebra de documento em trechos indexáveis.
 *
 * Função pura, sem I/O, pra ser testável: é ela que decide a qualidade do RAG.
 * Trecho grande demais dilui o assunto e o cosseno fica morno pra tudo; trecho
 * pequeno demais perde o contexto que dá sentido à frase.
 *
 * Estratégia: respeitar a estrutura do texto (título → parágrafo → frase) e só
 * cortar no meio quando não há alternativa. E sobrepor um pedaço entre trechos
 * vizinhos, porque a resposta que o usuário procura costuma cair justo na
 * fronteira entre dois parágrafos.
 *
 * Tabelas são a exceção à regra: uma linha "Premium | 890 | 8900" só tem
 * sentido junto do cabeçalho "Plano | Mensal | Anual". Um bloco tabular é
 * cortado apenas em fim de linha, e todo trecho que continua a tabela repete
 * o cabeçalho — senão a IA lê "890" sem saber se é mensal ou anual.
 */

export interface Chunk {
  content: string;
  ordem: number;
  tokens: number;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_OVERLAP_TOKENS = 100;

/** Mínimo de linhas consecutivas com o mesmo delimitador pra valer como tabela. */
const MIN_LINHAS_TABELA = 3;

/**
 * Estimativa por caracteres (~4 chars/token em pt-BR). Contar token de verdade
 * exigiria o tokenizer do provider a cada chamada; aqui o número só serve pra
 * dimensionar o trecho, então errar 10% é irrelevante — e não vira cobrança,
 * porque o custo real vem do `usage` da API.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Pedaço que cabe num trecho. `sozinho` marca a continuação de uma tabela: ela
 * já começa pelo cabeçalho e precisa virar um trecho próprio — se entrasse no
 * buffer atrás da sobreposição do trecho anterior, o cabeçalho deixaria de ser
 * a primeira linha.
 */
interface Piece {
  text: string;
  sozinho: boolean;
}

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const pieces = splitToFittingPieces(normalized, maxTokens);

  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const content = buffer.join('\n\n').trim();
    if (content) {
      chunks.push({ content, ordem: chunks.length, tokens: estimateTokens(content) });
    }
  };

  for (const piece of pieces) {
    if (piece.sozinho) {
      flush();
      buffer = [piece.text];
      bufferTokens = estimateTokens(piece.text);
      flush();
      // Sem sobreposição depois da tabela: o rabo seria um punhado de linhas
      // órfãs do cabeçalho — exatamente o que a repetição do cabeçalho evita.
      buffer = [];
      bufferTokens = 0;
      continue;
    }

    const pieceTokens = estimateTokens(piece.text);

    if (bufferTokens + pieceTokens > maxTokens && buffer.length > 0) {
      flush();
      // Sobreposição: recomeça o buffer com o rabo do trecho anterior, pra que
      // uma frase partida na fronteira apareça inteira em pelo menos um trecho.
      const carry = takeTail(buffer, overlapTokens);
      buffer = carry;
      bufferTokens = carry.reduce((sum, p) => sum + estimateTokens(p), 0);
    }

    buffer.push(piece.text);
    bufferTokens += pieceTokens;
  }
  flush();

  return chunks;
}

// ============================================
// Detecção de tabela
// ============================================

type Delimitador = '|' | '\t' | ';' | ',';

/**
 * Ordem importa: `|` e TAB são inequívocos; `;` e `,` aparecem em prosa, por
 * isso exigem pelo menos 3 colunas pra contar — "arroz, feijão" não é tabela.
 */
const DELIMITADORES: Array<{ d: Delimitador; minColunas: number }> = [
  { d: '|', minColunas: 2 },
  { d: '\t', minColunas: 2 },
  { d: ';', minColunas: 3 },
  { d: ',', minColunas: 3 },
];

interface FormaTabular {
  d: Delimitador;
  colunas: number;
}

function formaTabular(linha: string, d?: Delimitador): FormaTabular | null {
  const candidatos = d ? DELIMITADORES.filter((c) => c.d === d) : DELIMITADORES;
  for (const { d: delim, minColunas } of candidatos) {
    // Tabela markdown tem `|` nas pontas; não são colunas.
    const miolo = delim === '|' ? linha.trim().replace(/^\|/, '').replace(/\|$/, '') : linha;
    const colunas = miolo.split(delim).length;
    if (colunas >= minColunas) return { d: delim, colunas };
  }
  return null;
}

/** Linha `|---|:--:|` de tabela markdown — vai junto com o cabeçalho. */
function ehSeparadorMarkdown(linha: string): boolean {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(linha.trim());
}

type Segmento = { tipo: 'texto'; linhas: string[] } | { tipo: 'tabela'; linhas: string[] };

/**
 * Separa o texto em segmentos de prosa e de tabela. Bloco tabular = pelo menos
 * 3 linhas seguidas com o mesmo delimitador e o mesmo nº de colunas (±1 — uma
 * célula vazia no fim não pode quebrar a tabela). Linha em branco encerra.
 */
function segmentar(text: string): Segmento[] {
  const linhas = text.split('\n');
  const out: Segmento[] = [];
  let texto: string[] = [];
  let i = 0;

  const fechaTexto = () => {
    if (texto.length > 0) {
      out.push({ tipo: 'texto', linhas: texto });
      texto = [];
    }
  };

  while (i < linhas.length) {
    const forma = linhas[i].trim() ? formaTabular(linhas[i]) : null;
    if (!forma) {
      texto.push(linhas[i]);
      i++;
      continue;
    }

    let fim = i + 1;
    while (fim < linhas.length) {
      const f = linhas[fim].trim() ? formaTabular(linhas[fim], forma.d) : null;
      if (!f || Math.abs(f.colunas - forma.colunas) > 1) break;
      fim++;
    }

    if (fim - i >= MIN_LINHAS_TABELA) {
      fechaTexto();
      out.push({ tipo: 'tabela', linhas: linhas.slice(i, fim) });
      i = fim;
    } else {
      texto.push(linhas[i]);
      i++;
    }
  }
  fechaTexto();

  return out;
}

/**
 * Parágrafos que cabem no limite. Um parágrafo grande demais vira frases; uma
 * frase grande demais (log colado) é cortada por caracteres — último recurso,
 * mas melhor que estourar o limite do embedding. Tabelas seguem regra própria
 * (`splitTable`).
 */
function splitToFittingPieces(text: string, maxTokens: number): Piece[] {
  const out: Piece[] = [];

  for (const segmento of segmentar(text)) {
    if (segmento.tipo === 'tabela') {
      out.push(...splitTable(segmento.linhas, maxTokens));
      continue;
    }
    for (const p of splitProse(segmento.linhas.join('\n'), maxTokens)) {
      out.push({ text: p, sozinho: false });
    }
  }

  return out;
}

function splitProse(text: string, maxTokens: number): string[] {
  const out: string[] = [];

  for (const paragraph of text.split(/\n{2,}/)) {
    const p = paragraph.trim();
    if (!p) continue;

    if (estimateTokens(p) <= maxTokens) {
      out.push(p);
      continue;
    }

    let sentenceBuffer = '';
    for (const sentence of p.split(/(?<=[.!?…])\s+/)) {
      const s = sentence.trim();
      if (!s) continue;

      if (estimateTokens(s) > maxTokens) {
        if (sentenceBuffer) {
          out.push(sentenceBuffer);
          sentenceBuffer = '';
        }
        out.push(...hardSplit(s, maxTokens));
        continue;
      }

      const candidate = sentenceBuffer ? `${sentenceBuffer} ${s}` : s;
      if (estimateTokens(candidate) > maxTokens) {
        out.push(sentenceBuffer);
        sentenceBuffer = s;
      } else {
        sentenceBuffer = candidate;
      }
    }
    if (sentenceBuffer) out.push(sentenceBuffer);
  }

  return out;
}

/**
 * Tabela em grupos de linhas inteiras. A primeira parte é um pedaço comum
 * (pode dividir trecho com o parágrafo que apresenta a tabela); cada parte
 * seguinte repete o cabeçalho e vira trecho próprio. Tabela que cabe inteira
 * sai como um pedaço só, sem repetição.
 */
function splitTable(linhas: string[], maxTokens: number): Piece[] {
  const cabecalho =
    linhas.length > 2 && ehSeparadorMarkdown(linhas[1]) ? linhas.slice(0, 2) : linhas.slice(0, 1);
  const corpo = linhas.slice(cabecalho.length);
  const headerText = cabecalho.join('\n');

  const partes: string[] = [];
  let grupo: string[] = [];

  const fecha = () => {
    if (grupo.length === 0) return;
    partes.push([headerText, ...grupo].join('\n'));
    grupo = [];
  };

  for (const linha of corpo) {
    const candidato = [headerText, ...grupo, linha].join('\n');
    if (estimateTokens(candidato) > maxTokens && grupo.length > 0) fecha();

    if (estimateTokens(`${headerText}\n${linha}`) > maxTokens) {
      // Linha maior que o trecho inteiro: não há corte em fim de linha que
      // resolva. Cortar por caracteres é o último recurso, mantendo o cabeçalho.
      fecha();
      const orcamento = Math.max(1, maxTokens - estimateTokens(headerText) - 1);
      for (const pedaco of hardSplit(linha, orcamento)) partes.push(`${headerText}\n${pedaco}`);
      continue;
    }
    grupo.push(linha);
  }
  fecha();

  if (partes.length === 0) partes.push(headerText);

  return partes.map((text, i) => ({ text, sozinho: i > 0 }));
}

function hardSplit(text: string, maxTokens: number): string[] {
  const maxChars = maxTokens * 4;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}

/** Últimos pedaços do buffer que cabem no orçamento de sobreposição. */
function takeTail(pieces: string[], overlapTokens: number): string[] {
  if (overlapTokens <= 0) return [];
  const tail: string[] = [];
  let total = 0;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const t = estimateTokens(pieces[i]);
    // Sem este corte, um único parágrafo maior que a sobreposição seria
    // recarregado inteiro a cada flush e o loop nunca avançaria.
    if (total + t > overlapTokens) break;
    tail.unshift(pieces[i]);
    total += t;
  }
  return tail;
}
