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
import { requireRole } from '../middlewares/auth.middleware';
import { AppError } from '../utils/errors';
import type { AuthenticatedRequest } from '../types';

function makeReq(role: 'agent' | 'admin' | 'super_admin'): AuthenticatedRequest {
  return {
    user: {
      id: 'user-1',
      email: 'x@y.com',
      role: role as any,
      accountId: 'acc-1',
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
