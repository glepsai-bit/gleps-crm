/**
 * AREA T5 — sla controller
 *
 * Cobre superRefine do createPolicySchema: resolutionMin >= firstResponseMin.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

import { prismaTest } from '../test/setup';
import { authHeader } from '../test/helpers';
import { createTestApp } from '../test/app';

const app = createTestApp();

/**
 * Local helper: cria admin + JWT direto, sem chamar authService.login
 * (evita writes encadeados que causam flakiness em loop de 5+ testes).
 */
async function makeAdminJwt() {
  const account = await prismaTest.account.create({ data: { nome: 'SLATest' } });
  const user = await prismaTest.user.create({
    data: {
      accountId: account.id,
      nome: 'SLA Admin',
      email: `sla-${randomUUID()}@t.com`,
      passwordHash: 'x',
      role: 'admin',
      status: 'active',
      permissions: [],
    },
  });
  const token = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: 'admin',
      accountId: account.id,
      permissions: [],
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' }
  );
  return { jwt: token, account, user };
}

describe('POST /api/sla-policies — validacao resolutionMin >= firstResponseMin', () => {
  it('resolutionMin=10, firstResponseMin=120: 400 com mensagem coerente', async () => {
    const { jwt } = await makeAdminJwt();

    const res = await request(app)
      .post('/api/sla-policies')
      .set(authHeader(jwt))
      .send({
        name: 'Policy invertida',
        firstResponseMin: 120,
        resolutionMin: 10,
      });

    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).toMatch(/resolutionMin/i);
    expect(body).toMatch(/firstResponseMin/i);
  });

  it('resolutionMin=120, firstResponseMin=10: 201 (config valida)', async () => {
    const { jwt } = await makeAdminJwt();

    const res = await request(app)
      .post('/api/sla-policies')
      .set(authHeader(jwt))
      .send({
        name: 'Policy valida',
        firstResponseMin: 10,
        resolutionMin: 120,
      });

    expect(res.status).toBe(201);
    const data = res.body?.data ?? res.body;
    expect(data.firstResponseMin).toBe(10);
    expect(data.resolutionMin).toBe(120);
  });

  it('resolutionMin == firstResponseMin: 201 (borda permitida — >= passa)', async () => {
    const { jwt } = await makeAdminJwt();

    const res = await request(app)
      .post('/api/sla-policies')
      .set(authHeader(jwt))
      .send({
        name: 'Policy borda',
        firstResponseMin: 60,
        resolutionMin: 60,
      });

    expect(res.status).toBe(201);
  });

  it('valores negativos: 400 (positive)', async () => {
    const { jwt } = await makeAdminJwt();

    const res = await request(app)
      .post('/api/sla-policies')
      .set(authHeader(jwt))
      .send({
        name: 'Policy negativa',
        firstResponseMin: -1,
        resolutionMin: 10,
      });

    expect(res.status).toBe(400);
  });
});
