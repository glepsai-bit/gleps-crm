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

/**
 * O mapa da base: quem é o negócio e o que cada documento cobre.
 *
 * Vive no MESMO cache dos trechos, com a mesma invalidação. Se tivesse cache
 * próprio, um reindex derrubaria os trechos e deixaria o índice velho —
 * o agente seria orientado a buscar um assunto que acabou de sair da base.
 */
export interface BaseOverview {
  /** Texto livre sobre o negócio, escrito pelo usuário. */
  businessContext: string | null;
  /** Um item por documento pronto: título + o que cobre. */
  docs: { title: string; summary: string | null }[];
}

interface OverviewEntry {
  overview: BaseOverview;
  expiresAt: number;
}

const overviewCache = new Map<string, OverviewEntry>();

const CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Teto de bases em cache. Cada vetor são 1536 floats (~12KB por chunk em
 * memória), então uma base de 2.000 trechos custa ~24MB — sem teto, um tenant
 * grande derrubaria o processo.
 */
const MAX_CACHED_BASES = 8;
/** Acima disso não cacheia: lê do banco a cada busca em vez de estourar a RAM. */
const MAX_CHUNKS_CACHED_PER_BASE = 4000;
/**
 * Teto de documentos listados no índice. O índice vai em TODA mensagem: uma
 * base com 400 documentos viraria um bloco de milhares de tokens por resposta,
 * e o índice deixaria de ser barato — que é a única razão de ele existir.
 */
const MAX_DOCS_NO_INDICE = 60;
/** Teto do contexto do negócio, pelo mesmo motivo: ele vai em toda mensagem. */
const MAX_CHARS_CONTEXTO = 4000;

const cache = new Map<string, CacheEntry>();

const keyOf = (accountId: string, baseId: string) => `${accountId}:${baseId}`;

/** Chamado no fim de todo reindex — sem isso a busca serve trecho apagado. */
export function invalidateBase(accountId: string, baseId: string): void {
  cache.delete(keyOf(accountId, baseId));
  overviewCache.delete(keyOf(accountId, baseId));
}

export function invalidateAccount(accountId: string): void {
  for (const k of overviewCache.keys()) {
    if (k.startsWith(`${accountId}:`)) overviewCache.delete(k);
  }
  for (const k of cache.keys()) {
    if (k.startsWith(`${accountId}:`)) cache.delete(k);
  }
}

/** Só pra teste — o cache é global de módulo e vazaria entre casos. */
export function __clearIndexCache(): void {
  cache.clear();
  overviewCache.clear();
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
/** Por que a busca não trouxe nada. Muda o que o agente deve dizer ao lead. */
export type MotivoSemTrechos = 'nada_relevante' | 'busca_indisponivel';

/**
 * O bloco da base para o prompt.
 *
 * DEFEITO QUE ISTO CORRIGE: antes esta função devolvia string vazia quando não
 * havia trechos, e o chamador não empurrava bloco nenhum. Só que a instrução
 * "se não estiver aqui, diga que vai verificar" morava DENTRO do bloco — ou
 * seja, a trava contra invenção existia exatamente quando era menos necessária
 * (a base respondeu) e sumia exatamente quando era mais (a base não tinha
 * nada). Agora o silêncio da busca vira instrução explícita.
 */
export function formatHitsForPrompt(
  hits: SearchHit[],
  motivo: MotivoSemTrechos = 'nada_relevante'
): string {
  if (hits.length === 0) {
    return motivo === 'busca_indisponivel'
      ? 'BASE DE CONHECIMENTO — indisponível nesta mensagem.\n' +
          'Não foi possível consultar o material do negócio agora. NÃO afirme preço, ' +
          'prazo, política ou condição de memória: diga que vai confirmar e retorna.'
      : 'BASE DE CONHECIMENTO — nenhum trecho relevante para esta mensagem.\n' +
          'Isso não quer dizer que a informação não exista: pode ser que a busca não ' +
          'tenha casado. Se o assunto aparece no índice acima, use a ferramenta de ' +
          'busca com outras palavras. Se não achar, diga que vai confirmar — nunca ' +
          'invente preço, prazo ou política.';
  }
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

/**
 * Carrega o mapa da base — contexto do negócio + o que cada documento cobre.
 *
 * Só documentos `ready` entram: anunciar no índice um assunto que ainda está
 * indexando faria o agente buscar e não achar, que é pior que não saber que o
 * assunto existe.
 */
export async function loadOverview(accountId: string, baseId: string): Promise<BaseOverview> {
  const key = keyOf(accountId, baseId);
  const hit = overviewCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.overview;

  // Filtro duplo por conta em ambas as consultas — mesma regra do `search`.
  const [base, docs] = await Promise.all([
    prisma.knowledgeBase.findFirst({
      where: { id: baseId, accountId },
      select: { businessContext: true },
    }),
    prisma.knowledgeDoc.findMany({
      where: { baseId, accountId, status: 'ready' },
      select: { title: true, summary: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_DOCS_NO_INDICE,
    }),
  ]);

  const overview: BaseOverview = {
    businessContext: base?.businessContext?.trim() || null,
    docs: docs.map((d) => ({ title: d.title, summary: d.summary })),
  };

  overviewCache.set(key, { overview, expiresAt: Date.now() + CACHE_TTL_MS });
  return overview;
}

/**
 * SOBRE O NEGÓCIO — sempre no prompt, nunca recuperado por similaridade.
 *
 * É a identidade da empresa: vale em toda resposta, não só quando o lead
 * pergunta "o que vocês fazem?". Depender da busca para isso deixaria as
 * outras cinquenta respostas escritas sem saber para quem o agente trabalha.
 */
export function formatBusinessContext(overview: BaseOverview): string {
  if (!overview.businessContext) return '';
  return 'SOBRE O NEGÓCIO\n\n' + overview.businessContext.slice(0, MAX_CHARS_CONTEXTO);
}

/**
 * O QUE A BASE COBRE — o índice.
 *
 * Sem ele o agente tem lanterna e nenhum mapa: recebe trechos escolhidos por
 * cosseno e não sabe se o assunto existe. Aí não distingue "isso não está na
 * base" de "eu busquei com as palavras erradas", e diz que vai confirmar sobre
 * coisa que está lá. Custa ~200 tokens e transforma busca cega em dirigida.
 */
export function formatBaseIndex(overview: BaseOverview): string {
  if (overview.docs.length === 0) return '';
  const linhas = overview.docs.map((d) =>
    d.summary?.trim() ? `- ${d.title}: ${d.summary.trim()}` : `- ${d.title}`
  );
  return (
    'O QUE A BASE DE CONHECIMENTO COBRE\n' +
    'Índice do material disponível. Se o lead perguntar sobre algo desta lista e os ' +
    'trechos abaixo não responderem, use a ferramenta de busca com outras palavras ' +
    'antes de dizer que vai confirmar.\n\n' +
    linhas.join('\n')
  );
}
