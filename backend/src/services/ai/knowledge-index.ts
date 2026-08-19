/**
 * T-027 Fase 1 — busca semântica na base de conhecimento.
 *
 * ESTA É A ÚNICA PORTA DE ACESSO aos embeddings. Todo o resto do sistema
 * (agente, playground, ferramentas) chama `search()` e nunca lê
 * `knowledge_chunks` direto. É o que torna a decisão de storage reversível:
 * migrar pra pgvector é reimplementar este arquivo, sem tocar em chamador.
 *
 * Hoje: embeddings em jsonb, cosseno calculado no Node. O Postgres de produção
 * é o postgres:16-alpine padrão — exigir a extensão `vector` obrigaria a trocar
 * a imagem do banco em produção, o que não se paga no volume atual (uma base de
 * conhecimento de negócio tem dezenas a poucos milhares de trechos, não milhões).
 */

import { prisma } from '../../config/database';
import { embed, cosineSimilarity } from './embeddings';
import { logger } from '../../utils/logger';

export interface SearchHit {
  chunkId: string;
  docId: string;
  docTitle: string;
  content: string;
  score: number;
}

interface CachedChunk {
  id: string;
  docId: string;
  docTitle: string;
  content: string;
  embedding: number[];
}

interface CacheEntry {
  chunks: CachedChunk[];
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Teto de bases em cache. Cada vetor são 1536 floats (~12KB por chunk em
 * memória), então uma base de 2.000 trechos custa ~24MB — sem teto, um tenant
 * grande derrubaria o processo.
 */
const MAX_CACHED_BASES = 8;
/** Acima disso não cacheia: lê do banco a cada busca em vez de estourar a RAM. */
const MAX_CHUNKS_CACHED_PER_BASE = 4000;

const cache = new Map<string, CacheEntry>();

const keyOf = (accountId: string, baseId: string) => `${accountId}:${baseId}`;

/** Chamado no fim de todo reindex — sem isso a busca serve trecho apagado. */
export function invalidateBase(accountId: string, baseId: string): void {
  cache.delete(keyOf(accountId, baseId));
}

export function invalidateAccount(accountId: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(`${accountId}:`)) cache.delete(k);
  }
}

/** Só pra teste — o cache é global de módulo e vazaria entre casos. */
export function __clearIndexCache(): void {
  cache.clear();
}

async function loadChunks(accountId: string, baseId: string): Promise<CachedChunk[]> {
  const now = Date.now();
  const key = keyOf(accountId, baseId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.chunks;

  const rows = await prisma.knowledgeChunk.findMany({
    // FILTRO DUPLO: baseId sozinho bastaria pra correção da query, mas accountId
    // aqui é o que garante que um baseId vazado/adivinhado de outro tenant não
    // devolva conteúdo. Multi-tenancy não pode depender de join.
    where: { accountId, baseId },
    select: {
      id: true,
      docId: true,
      content: true,
      embedding: true,
      doc: { select: { title: true } },
    },
    orderBy: { ordem: 'asc' },
  });

  const chunks: CachedChunk[] = [];
  for (const r of rows) {
    const embedding = r.embedding as unknown;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      logger.warn('[knowledge-index] chunk sem embedding válido — ignorado', { chunkId: r.id });
      continue;
    }
    chunks.push({
      id: r.id,
      docId: r.docId,
      docTitle: r.doc?.title ?? '',
      content: r.content,
      embedding: embedding as number[],
    });
  }

  if (chunks.length <= MAX_CHUNKS_CACHED_PER_BASE) {
    if (cache.size >= MAX_CACHED_BASES) {
      // Evicção simples: a entrada mais antiga sai. Com 8 bases, LRU real não
      // paga o custo de manter contadores de acesso.
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, { chunks, expiresAt: now + CACHE_TTL_MS });
  }

  return chunks;
}

/**
 * Top-K trechos mais próximos da pergunta.
 *
 * `minScore` corta o ruído: sem ele a busca SEMPRE devolve K trechos, mesmo
 * quando a base não tem nada a ver com a pergunta — e o agente responde com
 * confiança usando contexto irrelevante, que é o pior modo de falha do RAG.
 */
export async function search(
  accountId: string,
  baseId: string,
  query: string,
  topK = 6,
  minScore = 0.2
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];

  const chunks = await loadChunks(accountId, baseId);
  if (chunks.length === 0) return [];

  const { vectors } = await embed(accountId, [q]);
  const queryVector = vectors[0];
  if (!queryVector) return [];

  return chunks
    .map((c) => ({
      chunkId: c.id,
      docId: c.docId,
      docTitle: c.docTitle,
      content: c.content,
      score: cosineSimilarity(queryVector, c.embedding),
    }))
    .filter((h) => h.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Monta o bloco de contexto que entra no system prompt do agente.
 * Cada trecho vai rotulado com o documento de origem — é o que permite o
 * agente citar a fonte e o admin auditar de onde veio a resposta.
 */
export function formatHitsForPrompt(hits: SearchHit[]): string {
  if (hits.length === 0) return '';
  const blocks = hits.map(
    (h, i) => `[${i + 1}] (fonte: ${h.docTitle || 'sem título'})\n${h.content}`
  );
  return (
    'BASE DE CONHECIMENTO — trechos relevantes para esta mensagem.\n' +
    'Use apenas o que estiver aqui como fato sobre o negócio; se a resposta não estiver ' +
    'nestes trechos, diga que vai verificar em vez de inventar.\n\n' +
    blocks.join('\n\n---\n\n')
  );
}
