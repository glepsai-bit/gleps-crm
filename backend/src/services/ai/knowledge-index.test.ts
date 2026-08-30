/**
 * T-027 Fase 1 — busca semântica: ranking, corte de ruído e ISOLAMENTO POR CONTA.
 *
 * O teste de isolamento é o mais importante do módulo: um vazamento aqui
 * entrega o conhecimento do negócio de um tenant pro atendimento de outro.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  knowledgeChunk: { findMany: vi.fn() },
  knowledgeBase: { findFirst: vi.fn() },
  knowledgeDoc: { findMany: vi.fn() },
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

import {
  search,
  invalidateBase,
  __clearIndexCache,
  formatHitsForPrompt,
  loadOverview,
  formatBaseIndex,
  formatBusinessContext,
} from './knowledge-index';

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
  /**
   * T-032 — este bloco ASSERTAVA o defeito. Antes a função devolvia string
   * vazia sem trechos, e o chamador não empurrava bloco nenhum. Só que a
   * instrução "se não estiver aqui, diga que vai verificar" morava DENTRO do
   * bloco: a trava contra invenção sumia exatamente quando era mais necessária,
   * porque a base não tinha o que responder. O contrato agora é o oposto —
   * silêncio da busca vira instrução explícita.
   */
  it('sem trechos AINDA instrui a não inventar — o silêncio era o furo', () => {
    const out = formatHitsForPrompt([]);
    expect(out).toContain('nenhum trecho relevante');
    expect(out).toContain('nunca invente preço, prazo ou política');
  });

  it('sem trechos avisa que pode ser a busca, não a ausência do dado', () => {
    // Sem isto o agente conclui "não existe" e encerra o assunto.
    expect(formatHitsForPrompt([])).toContain('não quer dizer que a informação não exista');
  });

  it('busca indisponível diz outra coisa — não chegou a procurar', () => {
    const out = formatHitsForPrompt([], 'busca_indisponivel');
    expect(out).toContain('indisponível nesta mensagem');
    expect(out).toContain('NÃO afirme preço');
    // Afirmar que não achou seria mentira: a consulta nem aconteceu.
    expect(out).not.toContain('nenhum trecho relevante');
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

/**
 * T-032 — o mapa da base.
 *
 * Contexto e índice vão em TODA mensagem do agente, então os tetos aqui não são
 * detalhe: sem eles, uma base grande dobra o custo de cada resposta e ninguém
 * percebe até a fatura. Teto sem teste é teto que para de valer no primeiro
 * refactor.
 */
describe('mapa da base — contexto e índice', () => {
  const overviewCru = (over: Record<string, unknown> = {}) => ({
    businessContext: null,
    docs: [],
    ...over,
  });

  beforeEach(() => {
    __clearIndexCache();
    prismaMock.knowledgeBase.findFirst.mockResolvedValue({ businessContext: null });
    prismaMock.knowledgeDoc.findMany.mockResolvedValue([]);
  });

  describe('loadOverview', () => {
    it('só lista documento PRONTO — anunciar o que ainda indexa manda buscar no vazio', async () => {
      await loadOverview(ACCOUNT_A, BASE);
      expect(prismaMock.knowledgeDoc.findMany.mock.calls[0][0].where).toMatchObject({
        baseId: BASE,
        accountId: ACCOUNT_A,
        status: 'ready',
      });
    });

    it('limita quantos documentos entram no índice — ele vai em toda mensagem', async () => {
      await loadOverview(ACCOUNT_A, BASE);
      const take = prismaMock.knowledgeDoc.findMany.mock.calls[0][0].take;
      expect(take).toBeGreaterThan(0);
      expect(take).toBeLessThanOrEqual(60);
    });

    it('filtra a base pela CONTA — mesma regra do search', async () => {
      await loadOverview(ACCOUNT_A, BASE);
      expect(prismaMock.knowledgeBase.findFirst.mock.calls[0][0].where).toMatchObject({
        id: BASE,
        accountId: ACCOUNT_A,
      });
    });

    it('cacheia: a segunda chamada não volta ao banco', async () => {
      await loadOverview(ACCOUNT_A, BASE);
      await loadOverview(ACCOUNT_A, BASE);
      expect(prismaMock.knowledgeDoc.findMany).toHaveBeenCalledTimes(1);
    });

    it('invalidateBase derruba o mapa junto dos trechos', async () => {
      await loadOverview(ACCOUNT_A, BASE);
      invalidateBase(ACCOUNT_A, BASE);
      await loadOverview(ACCOUNT_A, BASE);
      // Sem isto o índice anunciaria documento que acabou de sair da base.
      expect(prismaMock.knowledgeDoc.findMany).toHaveBeenCalledTimes(2);
    });

    it('conta diferente tem mapa próprio — não reusa o cache da vizinha', async () => {
      await loadOverview(ACCOUNT_A, BASE);
      await loadOverview(ACCOUNT_B, BASE);
      expect(prismaMock.knowledgeDoc.findMany).toHaveBeenCalledTimes(2);
      expect(prismaMock.knowledgeDoc.findMany.mock.calls[1][0].where.accountId).toBe(ACCOUNT_B);
    });
  });

  describe('formatBaseIndex', () => {
    it('lista título e o que cada documento cobre', () => {
      const out = formatBaseIndex(
        overviewCru({
          docs: [{ title: 'Preços', summary: 'valores dos 3 planos' }],
        })
      );
      expect(out).toContain('- Preços: valores dos 3 planos');
      expect(out).toContain('use a ferramenta de busca');
    });

    it('documento sem resumo entra só pelo título — não some do índice', () => {
      const out = formatBaseIndex(overviewCru({ docs: [{ title: 'Contrato', summary: null }] }));
      expect(out).toContain('- Contrato');
      expect(out).not.toContain('Contrato:');
    });

    it('base vazia não gera cabeçalho solto', () => {
      expect(formatBaseIndex(overviewCru({ docs: [] }))).toBe('');
    });
  });

  describe('formatBusinessContext', () => {
    it('sem contexto não gera bloco', () => {
      expect(formatBusinessContext(overviewCru())).toBe('');
    });

    it('trunca contexto gigante — o custo é por mensagem, para sempre', () => {
      const out = formatBusinessContext(overviewCru({ businessContext: 'x'.repeat(20_000) }));
      expect(out.length).toBeLessThan(5_000);
    });
  });
});
