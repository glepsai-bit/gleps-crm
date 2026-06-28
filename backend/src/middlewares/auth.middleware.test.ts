/**
 * Testes do middleware authenticate.
 * Usamos a rota real GET /api/auth/me, que é a forma canônica de exercitar
 * o middleware sem precisar mockar express/res.locals.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createTestApp } from '../test/app';
import { createTestAccount } from '../test/helpers';

const app = createTestApp();

const JWT_SECRET = process.env.JWT_SECRET!; // setado pelo vitest.config env

describe('authenticate middleware (via GET /api/auth/me)', () => {
  it('request sem Authorization header: 401', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
  });

  it('request sem Bearer prefix: 401', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'qualquer-coisa-sem-bearer');

    expect(res.status).toBe(401);
  });

  it('request com JWT malformado: 401', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer isso.nao.eh.um.jwt');

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('TOKEN_INVALID');
  });

  it('request com JWT expirado: 401 + code TOKEN_EXPIRED', async () => {
    // Cria user só pra ter um sub válido (mesmo expirado, payload tem que parse).
    const { user } = await createTestAccount();

    const expiredToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: 'admin',
        accountId: null,
        permissions: [],
      },
      JWT_SECRET,
      { expiresIn: '-1h' }, // já expirou 1h atrás
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('TOKEN_EXPIRED');
  });

  it('request com JWT assinado com secret errado: 401', async () => {
    const { user } = await createTestAccount();

    const badToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: 'admin',
        accountId: null,
        permissions: [],
      },
      'secret-completamente-errado-aaaaaaaaaaaaaaaa',
      { expiresIn: '1h' },
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${badToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('TOKEN_INVALID');
  });

  it('request com JWT válido: next() chamado (200) e retorna user', async () => {
    const { jwt: token, user } = await createTestAccount();

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // shape pode ser { data: { user: {...} } } — só validar email presente
    expect(JSON.stringify(res.body)).toContain(user.email);
  });

  it('request com JWT válido mas user removido do DB: 401', async () => {
    const { jwt: token } = await createTestAccount();

    // beforeEach (próximo teste) limpa users, mas pra esse caso forçamos
    // deletar o user manualmente:
    const { prismaTest } = await import('../test/setup');
    await prismaTest.refreshToken.deleteMany({});
    await prismaTest.user.deleteMany({});

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('USER_NOT_FOUND');
  });
});
