/**
 * ETAPA B — etapas fixas do funil (Fechado / Perdido) no tag.service.
 *
 * Fixa não se apaga (409), não troca de papel, não sai do fim do funil; etapa
 * nova entra antes delas; funil novo já nasce com as duas.
 *
 * Sem Postgres: prisma mockado no padrão de account.service.modulos.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => {
  const tag = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  };
  const leadTag = { count: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() };
  const tagHistory = { create: vi.fn() };
  const funnel = { create: vi.fn() };
  const tx = { tag, leadTag, tagHistory, funnel };
  return {
    tag,
    leadTag,
    tagHistory,
    funnel,
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (t: typeof tx) => Promise<unknown>)(tx);
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };
});

vi.mock('../config/database', () => ({ prisma: prismaMock }));
vi.mock('./event.service', () => ({ eventService: { create: vi.fn(async () => undefined) } }));
vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { tagService, funnelService, criarEtapasFixas, MENSAGEM_ETAPA_FIXA } from './tag.service';

/**
 * As tags "criadas" ficam na memória pra `findFirst` responder como o banco
 * responderia (papel já existe? maior ordem? slug ocupado?). Sem isso, o
 * mock devolve null pra tudo e a segunda fixa nasce com ordem 0.
 */
function bancoDeTagsEmMemoria(iniciais: Array<Record<string, unknown>> = []) {
  const tags: Array<Record<string, unknown>> = [...iniciais];
  prismaMock.tag.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const criada = { id: `tag-${data.slug}`, ...data };
    tags.push(criada);
    return criada;
  });
  prismaMock.tag.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.papel) return tags.find((t) => t.papel === where.papel && t.funnelId === where.funnelId) ?? null;
    if (where.slug) return tags.find((t) => t.slug === where.slug) ?? null;
    if (where.type === 'stage') {
      const doFunil = tags.filter((t) => t.funnelId === where.funnelId);
      if (doFunil.length === 0) return null;
      return { ordem: Math.max(...doFunil.map((t) => t.ordem as number)) };
    }
    return null;
  });
  return tags;
}

const ACC = 'acc-1';
const FUNIL = 'funil-1';

const etapa = (over: Record<string, unknown> = {}) => ({
  id: 'tag-x',
  accountId: ACC,
  funnelId: FUNIL,
  name: 'Etapa',
  slug: 'etapa',
  type: 'stage',
  color: '#6366F1',
  ordem: 0,
  ativo: true,
  papel: null,
  funnel: { id: FUNIL, name: 'Funil' },
  _count: { leadTags: 0 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.tag.findFirst.mockResolvedValue(null);
  prismaMock.tag.findMany.mockResolvedValue([]);
  prismaMock.tag.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.tag.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `tag-${data.slug}`,
    ...data,
  }));
  prismaMock.tag.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
    ...etapa({ id: where.id }),
    ...data,
  }));
  prismaMock.leadTag.count.mockResolvedValue(0);
});

describe('delete — etapa fixa', () => {
  it('recusa apagar etapa com papel, mesmo com force (409 "Esta etapa é fixa do funil")', async () => {
    prismaMock.tag.findFirst.mockResolvedValue(etapa({ id: 'tag-fechado', papel: 'fechamento', name: 'Fechado' }));

    const tentativa = tagService.delete('tag-fechado', ACC, 'user-1', { force: true });
    await expect(tentativa).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT', message: MENSAGEM_ETAPA_FIXA });
    expect(prismaMock.tag.delete).not.toHaveBeenCalled();
    expect(prismaMock.leadTag.deleteMany).not.toHaveBeenCalled();
  });

  it('etapa comum sem leads continua apagável', async () => {
    prismaMock.tag.findFirst.mockResolvedValue(etapa({ id: 'tag-comum' }));

    await tagService.delete('tag-comum', ACC, 'user-1');
    expect(prismaMock.tag.delete).toHaveBeenCalledWith({ where: { id: 'tag-comum' } });
  });
});

describe('update — papel é imutável', () => {
  it('renomear e colorir a fixa funciona; papel não vai pro banco', async () => {
    prismaMock.tag.findFirst.mockResolvedValue(etapa({ id: 'tag-fechado', papel: 'fechamento' }));

    await tagService.update(
      'tag-fechado',
      { name: 'Ganhou', color: '#000000', papel: 'perda' } as never,
      ACC,
      'user-1'
    );

    const { where, data } = prismaMock.tag.update.mock.calls[0][0];
    expect(where).toEqual({ id: 'tag-fechado' });
    expect(data).toEqual({ name: 'Ganhou', color: '#000000' });
    expect(data).not.toHaveProperty('papel');
  });
});

describe('create — etapa nova entra antes das fixas', () => {
  it('ocupa a posição da primeira fixa e empurra as fixas uma casa', async () => {
    // 1ª chamada: maior ordem do funil (Perdido = 4); 2ª: primeira fixa (Fechado = 3);
    // 3ª: slug livre.
    prismaMock.tag.findFirst
      .mockResolvedValueOnce({ ordem: 4 })
      .mockResolvedValueOnce({ ordem: 3 })
      .mockResolvedValueOnce(null);

    const criada = await tagService.create(
      { accountId: ACC, funnelId: FUNIL, name: 'Proposta', type: 'stage' },
      'user-1'
    );

    expect(prismaMock.tag.updateMany).toHaveBeenCalledWith({
      where: { funnelId: FUNIL, type: 'stage', ordem: { gte: 3 } },
      data: { ordem: { increment: 1 } },
    });
    expect(criada.ordem).toBe(3);
    expect(criada.papel).toBeUndefined();
  });

  it('funil sem fixas: entra no fim, como antes', async () => {
    prismaMock.tag.findFirst
      .mockResolvedValueOnce({ ordem: 1 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const criada = await tagService.create(
      { accountId: ACC, funnelId: FUNIL, name: 'Proposta', type: 'stage' },
      'user-1'
    );

    expect(prismaMock.tag.updateMany).not.toHaveBeenCalled();
    expect(criada.ordem).toBe(2);
  });
});

describe('reorderBulk — fixas ficam no fim', () => {
  it('reordenação completa manda Fechado e Perdido pro fim, nessa ordem', async () => {
    prismaMock.tag.findMany
      .mockResolvedValueOnce([
        { id: 'perdido', ordem: 0, papel: 'perda' },
        { id: 'novo', ordem: 1, papel: null },
        { id: 'fechado', ordem: 2, papel: 'fechamento' },
        { id: 'contato', ordem: 3, papel: null },
      ])
      .mockResolvedValueOnce([]); // list() do retorno

    await tagService.reorderBulk(['perdido', 'novo', 'fechado', 'contato'], ACC, 'user-1');

    const ordens = prismaMock.tag.updateMany.mock.calls.map((c) => [c[0].where.id, c[0].data.ordem]);
    expect(ordens).toEqual([
      ['novo', 0],
      ['contato', 1],
      ['fechado', 2],
      ['perdido', 3],
    ]);
  });

  it('swap envolvendo uma fixa é recusado', async () => {
    prismaMock.tag.findMany.mockResolvedValueOnce([
      { id: 'novo', ordem: 0, papel: null },
      { id: 'fechado', ordem: 1, papel: 'fechamento' },
    ]);

    await expect(tagService.reorderBulk(['novo', 'fechado'], ACC, 'user-1')).rejects.toMatchObject({
      statusCode: 400,
      message: MENSAGEM_ETAPA_FIXA,
    });
    expect(prismaMock.tag.updateMany).not.toHaveBeenCalled();
  });
});

describe('criarEtapasFixas / funil novo', () => {
  it('funil novo nasce com Fechado (#F0A532) e Perdido (#E5484D) no fim', async () => {
    prismaMock.funnel.create.mockResolvedValue({ id: 'funil-2', accountId: ACC, slug: 'vendas' });
    bancoDeTagsEmMemoria();

    await funnelService.create(ACC, 'Vendas', 'user-1');

    const criadas = prismaMock.tag.create.mock.calls.map((c) => c[0].data);
    expect(criadas).toEqual([
      expect.objectContaining({ funnelId: 'funil-2', name: 'Fechado', slug: 'fechado', color: '#F0A532', papel: 'fechamento', ordem: 0, type: 'stage' }),
      expect.objectContaining({ funnelId: 'funil-2', name: 'Perdido', slug: 'perdido', color: '#E5484D', papel: 'perda', ordem: 1, type: 'stage' }),
    ]);
  });

  it('não duplica o que já existe e desvia o slug ocupado por outro funil da conta', async () => {
    bancoDeTagsEmMemoria([
      // Funil 1 da conta já tem as duas (ocupam os slugs 'fechado' e 'perdido').
      { id: 'f1-fechado', funnelId: 'funil-1', slug: 'fechado', papel: 'fechamento', ordem: 3 },
      { id: 'f1-perdido', funnelId: 'funil-1', slug: 'perdido', papel: 'perda', ordem: 4 },
      // Funil 3 já tem Fechado (com slug próprio) e uma etapa livre.
      { id: 'f3-novo', funnelId: 'funil-3', slug: 'novo-f3', papel: null, ordem: 0 },
      { id: 'f3-fechado', funnelId: 'funil-3', slug: 'fechado-segundo', papel: 'fechamento', ordem: 5 },
    ]);

    const criadas = await criarEtapasFixas(prismaMock as never, ACC, 'funil-3', 'segundo');

    expect(criadas).toHaveLength(1);
    expect(prismaMock.tag.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.tag.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ papel: 'perda', slug: 'perdido-segundo', ordem: 6 })
    );
  });
});
