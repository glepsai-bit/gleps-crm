/**
 * ETAPA B — o catálogo de produtos vira a lista de Serviços da Agenda.
 *
 * O zod do product.controller precisa aceitar serviço sem preço (valorPadrao
 * 0), sem metodosPagamento, com duracaoMinutos entre 5 e 600 (ou null pra
 * "não é serviço"). Service mockado: aqui só interessa a validação.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response, NextFunction } from 'express';

const productServiceMock = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../services/product.service', () => ({ productService: productServiceMock }));

import { productController } from './product.controller';
import { AuthenticatedRequest } from '../types';

const req = (body: Record<string, unknown>, params: Record<string, string> = {}) =>
  ({
    body,
    params,
    query: {},
    user: { id: 'user-1', accountId: 'acc-1', role: 'admin' },
  }) as unknown as AuthenticatedRequest;

const res = () => {
  const r: Partial<Response> = {};
  r.status = vi.fn().mockReturnValue(r);
  r.json = vi.fn().mockReturnValue(r);
  return r as Response;
};

beforeEach(() => {
  vi.clearAllMocks();
  productServiceMock.create.mockImplementation(async (input: Record<string, unknown>) => ({ id: 'prod-1', ...input }));
  productServiceMock.update.mockImplementation(async (_id: string, input: Record<string, unknown>) => ({ id: 'prod-1', ...input }));
});

describe('POST /products — serviço', () => {
  it('aceita { nome, valorPadrao: 0, duracaoMinutos: 30 } sem metodosPagamento', async () => {
    const next = vi.fn() as NextFunction;
    const r = res();

    await productController.create(req({ nome: 'Avaliação', valorPadrao: 0, duracaoMinutos: 30 }), r, next);

    expect(next).not.toHaveBeenCalled();
    expect(productServiceMock.create).toHaveBeenCalledWith(
      { nome: 'Avaliação', valorPadrao: 0, duracaoMinutos: 30, accountId: 'acc-1' },
      'user-1'
    );
    expect(r.status).toHaveBeenCalledWith(201);
  });

  it('duração fora de 5..600 ou não inteira é recusada', async () => {
    for (const duracaoMinutos of [3, 601, 30.5]) {
      const next = vi.fn() as NextFunction;
      await productController.create(req({ nome: 'Serviço', valorPadrao: 10, duracaoMinutos }), res(), next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(productServiceMock.create).not.toHaveBeenCalled();
    }
  });

  it('valor negativo é recusado', async () => {
    const next = vi.fn() as NextFunction;
    await productController.create(req({ nome: 'Serviço', valorPadrao: -1 }), res(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(productServiceMock.create).not.toHaveBeenCalled();
  });
});

describe('PUT /products/:id — serviço', () => {
  it('aceita só o que mudou: { nome } | { valorPadrao } | { ativo } | { duracaoMinutos: null }', async () => {
    for (const body of [{ nome: 'Novo nome' }, { valorPadrao: 0 }, { ativo: false }, { duracaoMinutos: null }]) {
      const next = vi.fn() as NextFunction;
      await productController.update(req(body, { id: 'prod-1' }), res(), next);
      expect(next).not.toHaveBeenCalled();
    }
    expect(productServiceMock.update).toHaveBeenCalledTimes(4);
    expect(productServiceMock.update.mock.calls[3][1]).toEqual({ duracaoMinutos: null });
  });
});
