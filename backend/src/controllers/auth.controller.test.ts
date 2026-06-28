/**
 * Testes do auth.controller — focados em validação Zod do POST /api/auth/login.
 *
 * NOTA sobre rate limiter (authLimiter, 10 tentativas/15min):
 *   O limiter está montado direto no server.ts via `app.use('/api/auth/login', authLimiter)`
 *   e NÃO faz parte de `routes/auth.routes.ts`. O createTestApp() não monta esse limiter,
 *   então não é possível testar o 429 deste arquivo sem replicar a config no testApp
 *   (o que mudaria comportamento global do limiter). Além disso, com pool singleFork
 *   o estado do limiter seria persistido entre tests e poluiria outras suites.
 *   Decisão: documentar e pular esse caso aqui. Issue separada caso queiramos cobrir.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../test/app';
import { createTestAccount } from '../test/helpers';

const app = createTestApp();

describe('POST /api/auth/login — validação de input', () => {
  it('login válido retorna 200 + token', async () => {
    const { user, password } = await createTestAccount();

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password });

    expect(res.status).toBe(200);
    expect(res.body.data?.token).toBeTruthy();
    expect(res.body.data?.refreshToken).toBeTruthy();
  });

  it('login com senha errada retorna 401', async () => {
    const { user } = await createTestAccount();

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'errada-1234' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('INVALID_CREDENTIALS');
  });

  it('POST /api/auth/login com email de 2KB: 400 (max 254)', async () => {
    // 2KB de "a" + sufixo válido — passa do limite de 254 chars
    const longEmail = 'a'.repeat(2000) + '@example.com';

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: longEmail, password: 'qualquer123' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/auth/login sem body: 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/auth/login com email malformado: 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nao-eh-email', password: 'qualquer123' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/auth/login com password curta (<6 chars): 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'foo@bar.com', password: '123' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it.skip('POST /api/auth/login com senha errada 11 vezes: 429 (authLimiter)', async () => {
    // SKIPPED: o authLimiter não está montado no createTestApp().
    // Ele vive em server.ts antes do mount /api e não é exportado.
    // Replicar aqui causaria efeito colateral em outras suítes (pool singleFork).
    // Manter como TODO: extrair authLimiter para módulo dedicado e montar em testApp.
  });
});
