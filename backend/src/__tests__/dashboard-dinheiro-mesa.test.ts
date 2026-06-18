/**
 * T-017 — gate server-side de GET /api/dashboard/dinheiro-mesa.
 *
 * Roda com `node --import tsx --test`. Sem dependencias novas.
 * Testa o middleware requireRole('admin','super_admin') que protege a rota
 * (registrado em src/routes/dashboard.routes.ts).
 *
 * Nao subimos servidor HTTP — invocamos o middleware diretamente com
 * req/res mock. O comportamento real em producao casa porque eh exatamente
 * o mesmo middleware exportado de auth.middleware.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Response, NextFunction } from 'express';
import { requireRole, requireAccountId } from '../middlewares/auth.middleware';
import { AppError } from '../utils/errors';
import type { AuthenticatedRequest } from '../types';

function makeReq(
  role: 'agent' | 'admin' | 'super_admin',
  accountId: string | null = 'acc-1'
): AuthenticatedRequest {
  return {
    user: {
      id: 'user-1',
      email: 'x@y.com',
      role: role as any,
      accountId,
      permissions: [],
      nome: 'Tester',
      status: 'active',
    },
  } as any;
}

function makeRes(): Response {
  return {} as any;
}

test('GET /api/dashboard/dinheiro-mesa com role=agent retorna 403', () => {
  const req = makeReq('agent');
  const res = makeRes();
  let captured: unknown = null;
  const next: NextFunction = (err) => {
    captured = err;
  };

  const mw = requireRole('admin', 'super_admin');
  mw(req, res, next);

  assert.ok(captured instanceof Error, 'next deve receber um Error');
  const err = captured as AppError;
  assert.equal(err.statusCode, 403, 'statusCode esperado: 403');
  assert.equal(err.code, 'PERMISSION_DENIED', 'code esperado: PERMISSION_DENIED');
});

test('GET /api/dashboard/dinheiro-mesa com role=admin retorna 200 (passa pelo gate)', () => {
  const req = makeReq('admin');
  const res = makeRes();
  let called = false;
  let capturedErr: unknown = null;
  const next: NextFunction = (err) => {
    if (err) {
      capturedErr = err;
    } else {
      called = true;
    }
  };

  const mw = requireRole('admin', 'super_admin');
  mw(req, res, next);

  assert.equal(capturedErr, null, 'next NAO deve receber erro');
  assert.equal(called, true, 'next() deve ser invocado limpo (proxima middleware/handler executa -> 200)');
});

test('GET /api/dashboard/dinheiro-mesa com role=super_admin tambem passa', () => {
  const req = makeReq('super_admin');
  const res = makeRes();
  let called = false;
  const next: NextFunction = (err) => {
    if (!err) called = true;
  };

  requireRole('admin', 'super_admin')(req, res, next);

  assert.equal(called, true, 'super_admin deve ver o KPI (administra o tenant)');
});

// ============================================================
// T-016: requireAccountId — bypass pra super_admin sem accountId
// ============================================================

function makeResWithStatus() {
  let statusCode: number | null = null;
  let body: any = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: any) {
      body = payload;
      return this;
    },
  } as any as Response;
  return {
    res,
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
}

test('T-016: super_admin sem accountId passa por requireAccountId (bypass)', () => {
  const req = makeReq('super_admin', null);
  const { res } = makeResWithStatus();
  let nextCalled = false;
  let nextErr: unknown = null;
  const next: NextFunction = (err) => {
    if (err) nextErr = err;
    else nextCalled = true;
  };

  requireAccountId(req, res, next);

  assert.equal(nextErr, null, 'next NAO deve receber erro pra super_admin sem conta');
  assert.equal(nextCalled, true, 'next() deve ser chamado limpo — bypass ativo');
});

test('T-016: admin sem accountId eh bloqueado com 400 ACCOUNT_REQUIRED', () => {
  const req = makeReq('admin', null);
  const captured = makeResWithStatus();
  let nextCalled = false;
  const next: NextFunction = (err) => {
    if (!err) nextCalled = true;
  };

  requireAccountId(req, captured.res, next);

  assert.equal(nextCalled, false, 'next() NAO deve ser chamado pra admin sem conta');
  assert.equal(captured.statusCode, 400, 'admin sem accountId deve receber 400');
  assert.equal(
    captured.body?.error?.code,
    'ACCOUNT_REQUIRED',
    'code esperado: ACCOUNT_REQUIRED'
  );
});
