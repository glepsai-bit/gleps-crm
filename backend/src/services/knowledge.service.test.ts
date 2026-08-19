/**
 * T-027 — worker de indexação da base de conhecimento.
 *
 * Foco no que não é óbvio: o claim atômico (que impede duas réplicas indexarem
 * o mesmo doc) e o resgate de documento órfão — sem ele, um restart no meio da
 * indexação deixa o documento girando "indexando" pra sempre, sem erro nenhum.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  knowledgeDoc: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
  },
  knowledgeChunk: { deleteMany: vi.fn(), createMany: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));

vi.mock('../config/database', () => ({ prisma: prismaMock }));
vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./ai/knowledge-index', () => ({ invalidateBase: vi.fn() }));

const embedMock = vi.hoisted(() => vi.fn());
vi.mock('./ai/embeddings', () => ({ embed: embedMock }));

import { knowledgeService } from './knowledge.service';

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.knowledgeDoc.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.knowledgeDoc.findMany.mockResolvedValue([]);
});

describe('processPendingDocs — resgate de documento órfão', () => {
  it('devolve à fila documentos travados em indexing há muito tempo', async () => {
    await knowledgeService.processPendingDocs();

    const chamada = prismaMock.knowledgeDoc.updateMany.mock.calls[0][0];
    expect(chamada.where.status).toBe('indexing');
    expect(chamada.data).toEqual({ status: 'pending' });
    // O corte por tempo é o que separa "morto" de "outra réplica trabalhando".
    expect(chamada.where.updatedAt.lt).toBeInstanceOf(Date);
    expect(Date.now() - chamada.where.updatedAt.lt.getTime()).toBeGreaterThan(10 * 60 * 1000);
  });

  it('o resgate roda ANTES de buscar pendentes — senão o órfão nunca é visto', async () => {
    await knowledgeService.processPendingDocs();

    const ordemResgate = prismaMock.knowledgeDoc.updateMany.mock.invocationCallOrder[0];
    const ordemBusca = prismaMock.knowledgeDoc.findMany.mock.invocationCallOrder[0];
    expect(ordemResgate).toBeLessThan(ordemBusca);
  });
});

describe('processPendingDocs — claim atômico', () => {
  it('pula o documento quando outra réplica reclamou primeiro', async () => {
    prismaMock.knowledgeDoc.findMany.mockResolvedValue([{ id: 'doc-1' }]);
    // 1ª chamada = resgate de órfãos; 2ª = tentativa de claim (0 = perdeu a corrida)
    prismaMock.knowledgeDoc.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    const r = await knowledgeService.processPendingDocs();

    expect(r).toEqual({ ok: 0, failed: 0 });
    expect(prismaMock.knowledgeDoc.findUnique).not.toHaveBeenCalled();
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('o claim é condicional a status=pending — é o que evita indexação dupla', async () => {
    prismaMock.knowledgeDoc.findMany.mockResolvedValue([{ id: 'doc-1' }]);
    prismaMock.knowledgeDoc.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prismaMock.knowledgeDoc.findUnique.mockResolvedValue(null); // encerra cedo

    await knowledgeService.processPendingDocs();

    const claim = prismaMock.knowledgeDoc.updateMany.mock.calls[1][0];
    expect(claim.where).toEqual({ id: 'doc-1', status: 'pending' });
    expect(claim.data).toEqual({ status: 'indexing' });
  });
});

describe('processPendingDocs — falha de indexação', () => {
  it('erro vira status failed com a mensagem, sem derrubar o tick', async () => {
    prismaMock.knowledgeDoc.findMany.mockResolvedValue([{ id: 'doc-1' }]);
    prismaMock.knowledgeDoc.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prismaMock.knowledgeDoc.findUnique.mockResolvedValue({
      id: 'doc-1',
      accountId: 'acc',
      baseId: 'base',
      content: 'Plano Essencial custa R$ 500 por mês.',
    });
    embedMock.mockRejectedValue(new Error('A base de conhecimento precisa de uma chave OpenAI'));

    const r = await knowledgeService.processPendingDocs();

    expect(r).toEqual({ ok: 0, failed: 1 });
    const marcado = prismaMock.knowledgeDoc.update.mock.calls.at(-1)![0];
    expect(marcado.data.status).toBe('failed');
    expect(marcado.data.error).toContain('chave OpenAI');
  });

  it('documento sem conteúdo indexável fecha como ready com 0 trechos', async () => {
    prismaMock.knowledgeDoc.findMany.mockResolvedValue([{ id: 'doc-1' }]);
    prismaMock.knowledgeDoc.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prismaMock.knowledgeDoc.findUnique.mockResolvedValue({
      id: 'doc-1',
      accountId: 'acc',
      baseId: 'base',
      content: '   ',
    });

    const r = await knowledgeService.processPendingDocs();

    expect(r).toEqual({ ok: 1, failed: 0 });
    expect(embedMock).not.toHaveBeenCalled();
    const marcado = prismaMock.knowledgeDoc.update.mock.calls.at(-1)![0];
    expect(marcado.data.status).toBe('ready');
    expect(marcado.data.chunkCount).toBe(0);
  });
});
