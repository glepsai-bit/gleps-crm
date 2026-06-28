/**
 * Smoke test — valida que a infra de teste funciona:
 *  - DB de teste responde
 *  - prismaTest conecta
 *  - beforeEach TRUNCATE limpa as tabelas
 *  - helpers criam account + user com JWT real
 *  - supertest sobe app + bate em endpoint protegido
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prismaTest } from './setup';
import { createTestAccount, authHeader } from './helpers';
import { createTestApp } from './app';

const app = createTestApp();

describe('smoke — infra de teste', () => {
  it('DB de teste responde', async () => {
    const r = await prismaTest.$queryRaw<{ ok: number }[]>`SELECT 1 as ok`;
    expect(r[0].ok).toBe(1);
  });

  it('beforeEach limpa accounts', async () => {
    const count = await prismaTest.account.count();
    expect(count).toBe(0);
  });

  it('createTestAccount cria account+user+jwt valido', async () => {
    const { account, user, jwt } = await createTestAccount();
    expect(account.id).toBeTruthy();
    expect(user.email).toContain('@test.com');
    expect(jwt).toBeTruthy();
    expect(jwt.split('.').length).toBe(3); // JWT tem 3 partes
  });

  it('GET /api/health responde 200', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /api/auth/me sem auth -> 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me com JWT valido -> 200', async () => {
    const { jwt, user } = await createTestAccount();
    const res = await request(app).get('/api/auth/me').set(authHeader(jwt));
    expect(res.status).toBe(200);
    // O shape pode ser { data: {user: {...}} } ou { user: {...} } — apenas validar
    // que tem algum campo com o email correto, sem assumir shape exato.
    const raw = JSON.stringify(res.body);
    expect(raw).toContain(user.email);
  });
});
