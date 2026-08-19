/**
 * T-027 Fase 1 — busca semântica: ranking, corte de ruído e ISOLAMENTO POR CONTA.
 *
 * O teste de isolamento é o mais importante do módulo: um vazamento aqui
 * entrega o conhecimento do negócio de um tenant pro atendimento de outro.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  knowledgeChunk: { findMany: vi.fn() },
}));

vi.mock('../../config/database', () => ({ prisma: prismaMock }));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Só `embed` é mockado — o cosseno real precisa rodar, é ele que está sob teste.
const embedMock = vi.hoisted(() => vi.fn());
vi.mock('./embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./embeddings')>();
  return { ...actual, embed: embedMock };
});

import { search, invalidateBase, __clearIndexCache, formatHitsForPrompt } from './knowledge-index';

const ACCOUNT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BASE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

/** Vetores 2D bastam pro cosseno; a dimensão real não muda a matemática. */
const chunk = (id: string, content: string, embedding: number[], docTitle = 'Doc') => ({
  id,
  docId: `doc-${id}`,
  content,
  embedding,
  doc: { title: docTitle },
});

beforeEach(() => {
  vi.clearAllMocks();
  __clearIndexCache();
});

describe('search', () => {
  it('ordena por proximidade e respeita o topK', async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([
      chunk('longe', 'assunto sem relação', [0, 1]),
      chunk('perto', 'exatamente o assunto', [1, 0]),
      chunk('meio', 'parcialmente relacionado', [0.7, 0.7]),
    ]);
    embedMock.mockResolvedValue({ vectors: [[1, 0]], tokens: 3, usdEstimate: 0 });

    const hits = await search(ACCOUNT_A, BASE, 'o assunto', 2);

    expect(hits.map((h) => h.chunkId)).toEqual(['perto', 'meio']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].docTitle).toBe('Doc');
  });

  it('corta trechos abaixo do score mínimo em vez de devolver ruído', async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([
      chunk('ortogonal', 'nada a ver', [0, 1]),
    ]);
    embedMock.mockResolvedValue({ vectors: [[1, 0]], tokens: 3, usdEstimate: 0 });

    // cosseno = 0 → abaixo do minScore padrão (0.2)
    expect(await search(ACCOUNT_A, BASE, 'pergunta', 6)).toEqual([]);
  });

  it('filtra por accountId E baseId — multi-tenancy não depende de join', async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([]);
    embedMock.mockResolvedValue({ vectors: [[1, 0]], tokens: 1, usdEstimate: 0 });

    await search(ACCOUNT_A, BASE, 'pergunta');

    expect(prismaMock.knowledgeChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { accountId: ACCOUNT_A, baseId: BASE } })
    );
  });

  it('cache não vaza entre contas com o mesmo baseId', async () => {
    prismaMock.knowledgeChunk.findMany.mockImplementation(
      async ({ where }: { where: { accountId: string } }) =>
        where.accountId === ACCOUNT_A
          ? [chunk('segredo-a', 'preço da conta A', [1, 0])]
          : [chunk('segredo-b', 'preço da conta B', [1, 0])]
    );
    embedMock.mockResolvedValue({ vectors: [[1, 0]], tokens: 1, usdEstimate: 0 });

    const hitsA = await search(ACCOUNT_A, BASE, 'preço');
    const hitsB = await search(ACCOUNT_B, BASE, 'preço');

    expect(hitsA[0].content).toContain('conta A');
    expect(hitsB[0].content).toContain('conta B');
    expect(prismaMock.knowledgeChunk.findMany).toHaveBeenCalledTimes(2);
  });

  it('segunda busca na mesma base usa o cache (1 query só)', async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([chunk('c1', 'texto', [1, 0])]);
    embedMock.mockResolvedValue({ vectors: [[1, 0]], tokens: 1, usdEstimate: 0 });

    await search(ACCOUNT_A, BASE, 'um');
    await search(ACCOUNT_A, BASE, 'dois');

    expect(prismaMock.knowledgeChunk.findMany).toHaveBeenCalledTimes(1);
    // O embedding da PERGUNTA é sempre recalculado — só os chunks são cacheados.
    expect(embedMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateBase força releitura — sem isso a busca serviria trecho apagado', async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([chunk('c1', 'texto', [1, 0])]);
    embedMock.mockResolvedValue({ vectors: [[1, 0]], tokens: 1, usdEstimate: 0 });

    await search(ACCOUNT_A, BASE, 'um');
    invalidateBase(ACCOUNT_A, BASE);
    await search(ACCOUNT_A, BASE, 'dois');

    expect(prismaMock.knowledgeChunk.findMany).toHaveBeenCalledTimes(2);
  });

  it('base vazia não chama a API de embedding', async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([]);

    expect(await search(ACCOUNT_A, BASE, 'pergunta')).toEqual([]);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('pergunta em branco não chama banco nem API', async () => {
    expect(await search(ACCOUNT_A, BASE, '   ')).toEqual([]);
    expect(prismaMock.knowledgeChunk.findMany).not.toHaveBeenCalled();
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('chunk com embedding corrompido é ignorado, não derruba a busca', async () => {
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([
      { id: 'ruim', docId: 'd', content: 'x', embedding: null, doc: { title: 'D' } },
      chunk('bom', 'conteúdo válido', [1, 0]),
    ]);
    embedMock.mockResolvedValue({ vectors: [[1, 0]], tokens: 1, usdEstimate: 0 });

    const hits = await search(ACCOUNT_A, BASE, 'pergunta');
    expect(hits.map((h) => h.chunkId)).toEqual(['bom']);
  });
});

describe('formatHitsForPrompt', () => {
  it('sem trechos devolve string vazia — nada é injetado no prompt', () => {
    expect(formatHitsForPrompt([])).toBe('');
  });

  it('rotula cada trecho com o documento de origem', () => {
    const out = formatHitsForPrompt([
      { chunkId: '1', docId: 'd1', docTitle: 'Tabela de Preços', content: 'Plano X: R$ 500', score: 0.9 },
    ]);
    expect(out).toContain('Tabela de Preços');
    expect(out).toContain('Plano X: R$ 500');
    // A instrução anti-alucinação tem que ir junto do contexto.
    expect(out.toLowerCase()).toContain('inventar');
  });
});
