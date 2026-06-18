/**
 * T-020b — getMetrics nao devolve 502 pra super_admin sem accountId.
 *
 * Cenarios:
 *   1. user.accountId = null (super_admin sem conta selecionada) ->
 *      200 com payload zerado + message explicativa (nao 502).
 *   2. user.accountId real -> 200 com data preenchida (service mockado).
 *
 * Roda com `node --import tsx --test`. Sem deps novas.
 *
 * Testamos o controller diretamente com req/res mocks. Mockamos o
 * chatwoot-metrics.service pra cortar I/O real do Chatwoot — o teste
 * checa apenas o branch de roteamento (accountId presente vs ausente)
 * e o shape da resposta.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types';
import { chatwootMetricsService } from '../services/chatwoot-metrics.service';
import { chatwootController } from '../controllers/chatwoot.controller';

function makeReq(
  accountId: string | null,
  query: Record<string, string> = {}
): AuthenticatedRequest {
  return {
    user: {
      id: 'user-1',
      email: 'super@admin.com',
      role: accountId ? 'admin' : 'super_admin',
      accountId,
      permissions: [],
      nome: 'Tester',
      status: 'active',
    },
    query,
    body: {},
  } as any;
}

function makeRes() {
  let statusCode: number | null = null;
  let body: any = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: any) {
      body = payload;
      // Se status nunca foi chamado, default = 200 (comportamento do Express).
      if (statusCode === null) statusCode = 200;
      return this;
    },
  } as any as Response;
  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
}

test('T-020b: super_admin sem accountId -> 200 com payload zerado + message (nao 502)', async () => {
  const req = makeReq(null, { dateFrom: '2026-01-01', dateTo: '2026-01-31' });
  const captured = makeRes();
  let nextErr: unknown = null;
  const next: NextFunction = (err) => {
    nextErr = err;
  };

  await chatwootController.getMetrics(req, captured.res, next);

  assert.equal(nextErr, null, 'next NAO deve receber erro');
  assert.equal(captured.statusCode, 200, 'statusCode esperado: 200 (nao 502)');
  assert.equal(captured.body?.success, true, 'success=true');
  assert.equal(captured.body?.data?.totalConversations, 0, 'totalConversations zerado');
  assert.equal(captured.body?.data?.activeAgents, 0, 'activeAgents zerado');
  assert.equal(captured.body?.data?.backlog?.ate15min, 0, 'backlog.ate15min zerado');
  assert.equal(captured.body?.data?.backlog?.de15a60min, 0, 'backlog.de15a60min zerado');
  assert.equal(captured.body?.data?.backlog?.acima60min, 0, 'backlog.acima60min zerado');
  assert.equal(
    captured.body?.data?.backlog?.naoAtribuidas?.ate15min,
    0,
    'backlog.naoAtribuidas.ate15min zerado'
  );
  assert.equal(captured.body?.data?.atendimento?.total, 0, 'atendimento.total zerado');
  assert.equal(captured.body?.data?.atendimento?.ia, 0, 'atendimento.ia zerado');
  assert.equal(captured.body?.data?.atendimento?.humano, 0, 'atendimento.humano zerado');
  assert.ok(
    typeof captured.body?.data?.message === 'string' &&
      captured.body.data.message.toLowerCase().includes('super admin'),
    'message deve mencionar super admin (hint pra selecionar conta)'
  );
});

test('T-020b: user com accountId real -> 200 com dados do service (mockado)', async () => {
  const fakeMetrics = {
    totalConversations: 42,
    activeAgents: 3,
    backlog: {
      ate15min: 5,
      de15a60min: 2,
      acima60min: 1,
      naoAtribuidas: { ate15min: 0, de15a60min: 0, acima60min: 0 },
    },
    atendimento: { total: 42, ia: 30, humano: 12 },
  };

  const computeMock = mock.method(
    chatwootMetricsService,
    'computeMetrics',
    async () => fakeMetrics as any
  );

  try {
    const req = makeReq('acc-real-uuid', { dateFrom: '2026-01-01', dateTo: '2026-01-31' });
    const captured = makeRes();
    let nextErr: unknown = null;
    const next: NextFunction = (err) => {
      nextErr = err;
    };

    await chatwootController.getMetrics(req, captured.res, next);

    assert.equal(nextErr, null, 'next NAO deve receber erro');
    assert.equal(captured.statusCode, 200, 'statusCode esperado: 200');
    assert.equal(captured.body?.success, true, 'success=true');
    assert.equal(captured.body?.data?.totalConversations, 42, 'usa valor do service');
    assert.equal(captured.body?.data?.atendimento?.ia, 30, 'usa atendimento.ia do service');
    assert.equal(computeMock.mock.callCount(), 1, 'computeMetrics chamado 1x');
    const firstCall = computeMock.mock.calls[0];
    assert.equal(firstCall.arguments[0], 'acc-real-uuid', 'service recebe accountId real');
  } finally {
    computeMock.mock.restore();
  }
});
