/**
 * ETAPA A — requireModulo.
 *
 * O que está em jogo: uma conta sem o módulo contratado não pode usar as
 * rotas dele, mas a resposta tem que ser distinguível de "sem permissão"
 * (o front redireciona num caso e pede ao admin no outro), e o super admin
 * nunca pode ficar trancado fora do que ele mesmo administra.
 *
 * Sem Postgres: o middleware só lê req.user/req.account, que o authenticate
 * monta. O mock do prisma existe só pra o import do módulo não abrir conexão.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Response, NextFunction } from 'express';

const prismaMock = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
vi.mock('../config/database', () => ({ prisma: prismaMock }));

import { requireModulo } from './auth.middleware';
import { AuthenticatedRequest } from '../types';

const ACC = 'acc-1';

function reqCom(over: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    user: {
      id: 'u-1',
      email: 'a@b.com',
      role: 'admin',
      accountId: ACC,
      permissions: [],
      nome: 'Admin',
      status: 'active',
    },
    account: {
      id: ACC,
      nome: 'Conta',
      status: 'active',
      timezone: 'America/Sao_Paulo',
      modulos: ['extracao', 'disparos'],
    },
    ...over,
  } as AuthenticatedRequest;
}

function roda(req: AuthenticatedRequest, modulo: Parameters<typeof requireModulo>[0]) {
  const next = vi.fn() as unknown as NextFunction;
  requireModulo(modulo)(req, {} as Response, next);
  const chamadas = (next as unknown as ReturnType<typeof vi.fn>).mock.calls;
  expect(chamadas).toHaveLength(1);
  return chamadas[0][0] as undefined | (Error & { statusCode?: number; code?: string; details?: unknown });
}

describe('requireModulo', () => {
  it('conta com o módulo ligado passa (next sem erro)', () => {
    expect(roda(reqCom(), 'extracao')).toBeUndefined();
  });

  it('conta sem o módulo → 403 com código MODULO_DESLIGADO (não PERMISSION_DENIED)', () => {
    const erro = roda(reqCom(), 'emails');
    expect(erro).toBeInstanceOf(Error);
    expect(erro!.statusCode).toBe(403);
    expect(erro!.code).toBe('MODULO_DESLIGADO');
    // O front usa o details pra saber QUAL módulo faltou.
    expect(erro!.details).toEqual({ modulo: 'emails' });
  });

  it('conta com lista vazia (nunca configurada) é tratada como tudo desligado', () => {
    const erro = roda(reqCom({ account: { ...reqCom().account!, modulos: [] } }), 'extracao');
    expect(erro!.code).toBe('MODULO_DESLIGADO');
  });

  it('super_admin passa mesmo sem conta e mesmo com o módulo desligado', () => {
    const semConta = reqCom({ account: undefined });
    semConta.user!.role = 'super_admin';
    semConta.user!.accountId = null;
    expect(roda(semConta, 'emails')).toBeUndefined();

    const comContaDesligada = reqCom();
    comContaDesligada.user!.role = 'super_admin';
    expect(roda(comContaDesligada, 'emails')).toBeUndefined();
  });

  it('sem req.user → 401 (middleware antes do authenticate é erro de montagem)', () => {
    const erro = roda(reqCom({ user: undefined }), 'extracao');
    expect(erro!.statusCode).toBe(401);
  });

  it('usuário autenticado mas sem conta (não super admin) → 401', () => {
    const erro = roda(reqCom({ account: undefined }), 'extracao');
    expect(erro!.statusCode).toBe(401);
  });
});
