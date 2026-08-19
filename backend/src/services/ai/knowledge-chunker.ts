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

/**
 * Estimativa por caracteres (~4 chars/token em pt-BR). Contar token de verdade
 * exigiria o tokenizer do provider a cada chamada; aqui o número só serve pra
 * dimensionar o trecho, então errar 10% é irrelevante — e não vira cobrança,
 * porque o custo real vem do `usage` da API.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
    const pieceTokens = estimateTokens(piece);

    if (bufferTokens + pieceTokens > maxTokens && buffer.length > 0) {
      flush();
      // Sobreposição: recomeça o buffer com o rabo do trecho anterior, pra que
      // uma frase partida na fronteira apareça inteira em pelo menos um trecho.
      const carry = takeTail(buffer, overlapTokens);
      buffer = carry;
      bufferTokens = carry.reduce((sum, p) => sum + estimateTokens(p), 0);
    }

    buffer.push(piece);
    bufferTokens += pieceTokens;
  }
  flush();

  return chunks;
}

/**
 * Parágrafos que cabem no limite. Um parágrafo grande demais vira frases; uma
 * frase grande demais (log colado, tabela) é cortada por caracteres — último
 * recurso, mas melhor que estourar o limite do embedding.
 */
function splitToFittingPieces(text: string, maxTokens: number): string[] {
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
