/**
 * ETAPA A — módulos por conta no account.service e no account.controller.
 *
 * Conta nova nasce só com captação; o super admin substitui a lista inteira
 * pelo PUT. Chave desconhecida ou repetida é recusada, nunca "limpa" em
 * silêncio — um erro de digitação do super admin tem que aparecer.
 *
 * Sem Postgres: prisma mockado no padrão de ai-agent.multiagent.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response, NextFunction } from 'express';

const prismaMock = vi.hoisted(() => {
  const account = {
    create: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
  };
  const funnel = { create: vi.fn() };
  // ETAPA B — a conta nova cria Fechado/Perdido no mesmo tx (criarEtapasFixas).
  const tag = { findFirst: vi.fn(), create: vi.fn() };
  const tx = { account, funnel, tag };
  return {
    account,
    funnel,
    tag,
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
});

vi.mock('../config/database', () => ({ prisma: prismaMock }));
vi.mock('./event.service', () => ({ eventService: { create: vi.fn(async () => undefined) } }));
vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { accountService, validarModulos } from './account.service';
import { accountController } from '../controllers/account.controller';
import { MODULOS_PADRAO_CONTA_NOVA, MODULOS_OPCIONAIS } from '../config/modulos';
import { AuthenticatedRequest } from '../types';

const contaDoBanco = (over: Record<string, unknown> = {}) => ({
  id: 'acc-1',
  nome: 'Conta',
  status: 'active',
  timezone: 'America/Sao_Paulo',
  plano: null,
  limiteUsuarios: 10,
  modulos: ['extracao', 'disparos'],
  _count: { users: 1, contacts: 0, sales: 0, products: 0, tags: 0 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.account.findUnique.mockResolvedValue(contaDoBanco());
  prismaMock.account.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...contaDoBanco(),
    ...data,
  }));
  prismaMock.account.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...contaDoBanco(),
    ...data,
  }));
  prismaMock.funnel.create.mockResolvedValue({ id: 'funil-1', slug: 'principal' });
  // Tags criadas ficam na memória pra findFirst (maior ordem / papel já
  // existe) responder como o banco — senão as duas fixas nascem com ordem 0.
  const tags: Array<Record<string, unknown>> = [];
  prismaMock.tag.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.papel) return tags.find((t) => t.papel === where.papel) ?? null;
    if (where.slug) return null;
    if (where.type === 'stage' && tags.length > 0) return { ordem: Math.max(...tags.map((t) => t.ordem as number)) };
    return null;
  });
  prismaMock.tag.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const criada = { id: `tag-${data.slug}`, ...data };
    tags.push(criada);
    return criada;
  });
});

describe('accountService.create — etapas fixas (ETAPA B)', () => {
  it('conta nova nasce com Fechado e Perdido no funil padrão', async () => {
    await accountService.create({ nome: 'Nova' }, 'super-1');

    const criadas = prismaMock.tag.create.mock.calls.map((c) => c[0].data);
    expect(criadas.map((t) => [t.name, t.papel, t.slug, t.ordem])).toEqual([
      ['Fechado', 'fechamento', 'fechado', 0],
      ['Perdido', 'perda', 'perdido', 1],
    ]);
    expect(criadas.every((t) => t.funnelId === 'funil-1' && t.type === 'stage')).toBe(true);
  });
});

describe('accountService.create — módulos padrão', () => {
  it('conta nova nasce com MODULOS_PADRAO_CONTA_NOVA (extracao + disparos), nada mais', async () => {
    const criada = await accountService.create({ nome: 'Nova' }, 'super-1');

    const data = prismaMock.account.create.mock.calls[0][0].data;
    expect(data.modulos).toEqual(MODULOS_PADRAO_CONTA_NOVA);
    expect(data.modulos).toEqual(['extracao', 'disparos']);
    expect(criada.modulos).toEqual(['extracao', 'disparos']);
  });

  it('o padrão é uma cópia: mexer no retorno não contamina a constante', async () => {
    const criada = await accountService.create({ nome: 'Nova' });
    (criada.modulos as string[]).push('emails');
    expect(MODULOS_PADRAO_CONTA_NOVA).toEqual(['extracao', 'disparos']);
  });
});

describe('accountService.update — modulos', () => {
  it('aceita lista válida e grava a lista inteira (substitui, não mescla)', async () => {
    const atualizada = await accountService.update('acc-1', { modulos: ['emails', 'vendas'] }, 'super-1');

    const data = prismaMock.account.update.mock.calls[0][0].data;
    expect(data.modulos).toEqual(['emails', 'vendas']);
    expect(atualizada.modulos).toEqual(['emails', 'vendas']);
  });

  it('lista vazia é válida: desliga tudo', async () => {
    await accountService.update('acc-1', { modulos: [] });
    expect(prismaMock.account.update.mock.calls[0][0].data.modulos).toEqual([]);
  });

  it('sem o campo no input, não toca em modulos', async () => {
    await accountService.update('acc-1', { nome: 'Renomeada' });
    expect(prismaMock.account.update.mock.calls[0][0].data.modulos).toBeUndefined();
  });

  it('recusa chave inválida com 400 e não chama o banco', async () => {
    await expect(
      accountService.update('acc-1', { modulos: ['emails', 'financeiro'] })
    ).rejects.toMatchObject({ statusCode: 400, details: { invalidas: ['financeiro'] } });
    expect(prismaMock.account.update).not.toHaveBeenCalled();
  });

  it('recusa chave repetida', async () => {
    await expect(
      accountService.update('acc-1', { modulos: ['emails', 'emails'] })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.account.update).not.toHaveBeenCalled();
  });

  it('a resposta inclui modulos (getById devolve o campo do banco)', async () => {
    const conta = await accountService.getById('acc-1');
    expect(conta.modulos).toEqual(['extracao', 'disparos']);
  });
});

describe('validarModulos', () => {
  it('aceita todas as chaves conhecidas de uma vez', () => {
    expect(validarModulos([...MODULOS_OPCIONAIS])).toEqual([...MODULOS_OPCIONAIS]);
  });

  it('recusa o que não for lista', () => {
    expect(() => validarModulos('emails')).toThrow();
    expect(() => validarModulos(null)).toThrow();
  });
});

describe('PUT /accounts/:id — zod do controller', () => {
  function chama(body: Record<string, unknown>) {
    const req = { params: { id: 'acc-1' }, body, user: { id: 'super-1' } } as unknown as AuthenticatedRequest;
    const json = vi.fn();
    const res = { json, status: vi.fn(() => ({ json })) } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    return accountController.update(req, res, next).then(() => ({
      json,
      next: next as unknown as ReturnType<typeof vi.fn>,
    }));
  }

  it('chave desconhecida cai no next com ZodError (vira 400 no errorHandler)', async () => {
    const { json, next } = await chama({ modulos: ['extracao', 'inexistente'] });
    expect(json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]?.name).toBe('ZodError');
    expect(prismaMock.account.update).not.toHaveBeenCalled();
  });

  it('chave repetida também é recusada pelo zod', async () => {
    const { next } = await chama({ modulos: ['vendas', 'vendas'] });
    expect(next.mock.calls[0][0]?.name).toBe('ZodError');
    expect(prismaMock.account.update).not.toHaveBeenCalled();
  });

  it('lista válida chega ao service e a resposta traz modulos', async () => {
    const { json, next } = await chama({ modulos: ['aquecimento'] });
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ data: expect.objectContaining({ modulos: ['aquecimento'] }) });
  });
});
