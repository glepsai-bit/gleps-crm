/**
 * T-027 Fase 1 — embeddings para a base de conhecimento (RAG).
 *
 * IMPORTANTE (limitação real, não escolha): a Anthropic não tem endpoint de
 * embeddings. Então a indexação da base de conhecimento SEMPRE usa OpenAI,
 * mesmo que o agente responda com Claude. Uma conta que só cadastrou chave
 * Anthropic consegue conversar, mas não consegue indexar documento — e o erro
 * abaixo diz isso em vez de estourar um 401 cru da OpenAI.
 *
 * Modelo: text-embedding-3-small (1536 dimensões). Trocar de modelo invalida
 * todos os chunks já indexados — vetores de modelos diferentes não são
 * comparáveis —, por isso o nome do modelo é constante e a troca exige
 * reindexar tudo.
 */

import { getOpenAI, resolveKey } from './client-factory';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

/** $0.02 por 1M tokens (text-embedding-3-small). */
const USD_PER_TOKEN = 0.02 / 1_000_000;

const TIMEOUT_MS = 60_000;
/** Lote conservador: a API aceita mais, mas o teto real é de tokens, não de itens. */
const BATCH_SIZE = 96;

export interface EmbedResult {
  vectors: number[][];
  tokens: number;
  usdEstimate: number;
}

export class EmbeddingsUnavailableError extends AppError {
  constructor() {
    super(
      'A base de conhecimento precisa de uma chave OpenAI (a Anthropic não oferece embeddings). ' +
        'Cadastre em Administração → Integrações.',
      503
    );
  }
}

/**
 * Gera embeddings preservando a ORDEM da entrada — o chamador casa
 * `vectors[i]` com `texts[i]` pra montar os chunks. A API devolve `index` em
 * cada item justamente porque a ordem da resposta não é garantida; ignorar
 * isso embaralharia o conteúdo dos chunks silenciosamente.
 */
export async function embed(accountId: string, texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) return { vectors: [], tokens: 0, usdEstimate: 0 };

  try {
    await resolveKey(accountId, 'openai');
  } catch {
    throw new EmbeddingsUnavailableError();
  }

  const client = await getOpenAI(accountId, TIMEOUT_MS);
  const vectors: number[][] = new Array(texts.length);
  let tokens = 0;

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const res = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });

    for (const item of res.data) {
      vectors[start + item.index] = item.embedding;
    }
    tokens += res.usage?.total_tokens ?? 0;
  }

  const missing = vectors.findIndex((v) => !v);
  if (missing !== -1) {
    logger.error('[ai/embeddings] resposta incompleta da API', {
      esperado: texts.length,
      faltando: missing,
    });
    throw new AppError('A API de embeddings devolveu menos vetores que o esperado.', 502);
  }

  return { vectors, tokens, usdEstimate: tokens * USD_PER_TOKEN };
}

/**
 * Similaridade do cosseno. Os vetores da OpenAI já vêm normalizados (norma 1),
 * mas normalizar de novo custa pouco e protege contra vetor vindo de outra
 * origem — sem isso, um vetor não normalizado dá score > 1 e desordena o rank.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
