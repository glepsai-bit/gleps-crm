/**
 * AREA T5 — calendar controller
 *
 * Cobre superRefine do createEventSchema:
 *  - endTime < startTime → 400
 *  - endTime == startTime → 400 (duracao zero)
 *  - startTime no passado sem allowPast → 400
 *  - startTime no passado com allowPast → 201
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
 * Mini-helper local: cria account + user admin e JWT direto (sem chamar
 * authService.login). authService.login dispara writes em eventService.create
 * que, ao serem repetidos em loop entre testes (5+ vezes na mesma suite com
 * pool=forks/singleFork), causam erros transientes de visibilidade entre o
 * prisma singleton e o prismaTest. Esta versao e suficiente p/ esses testes
 * porque a unica coisa que precisamos eh um JWT valido p/ os middlewares.
 */
async function makeAdminJwt() {
  const account = await prismaTest.account.create({ data: { nome: 'CalTest' } });
  const user = await prismaTest.user.create({
    data: {
      accountId: account.id,
      nome: 'Cal Admin',
      email: `cal-${randomUUID()}@t.com`,
      passwordHash: 'x',
      role: 'admin',
      status: 'active',
      permissions: ['agenda'],
    },
  });
  const token = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: 'admin',
      accountId: account.id,
      permissions: ['agenda'],
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' }
  );
  return { jwt: token, account, user };
}

describe('POST /api/calendar/events — validacoes superRefine', () => {
  it('endTime < startTime: 400 com mensagem "endTime deve ser maior que startTime"', async () => {
    const { jwt } = await makeAdminJwt();

    const start = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const end = new Date(Date.now() + 60 * 60_000).toISOString();

    const res = await request(app)
      .post('/api/calendar/events')
      .set(authHeader(jwt))
      .send({
        title: 'Reuniao invertida',
        startTime: start,
        endTime: end,
        type: 'meeting',
      });

    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).toMatch(/endTime/i);
  });

  it('endTime == startTime: 400 (duracao zero)', async () => {
    const { jwt } = await makeAdminJwt();

    const t = new Date(Date.now() + 60 * 60_000).toISOString();

    const res = await request(app)
      .post('/api/calendar/events')
      .set(authHeader(jwt))
      .send({
        title: 'Duracao zero',
        startTime: t,
        endTime: t,
        type: 'meeting',
      });

    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).toMatch(/endTime/i);
  });

  it('startTime no passado sem allowPast: 400', async () => {
    const { jwt } = await makeAdminJwt();

    const start = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const end = new Date(Date.now() - 60 * 60_000).toISOString();

    const res = await request(app)
      .post('/api/calendar/events')
      .set(authHeader(jwt))
      .send({
        title: 'Evento passado',
        startTime: start,
        endTime: end,
        type: 'meeting',
      });

    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).toMatch(/futuro|allowPast/i);
  });

  it('startTime no passado com allowPast=true: 201 (registro historico)', async () => {
    const { jwt } = await makeAdminJwt();

    const start = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const end = new Date(Date.now() - 60 * 60_000).toISOString();

    const res = await request(app)
      .post('/api/calendar/events')
      .set(authHeader(jwt))
      .send({
        title: 'Evento historico',
        startTime: start,
        endTime: end,
        type: 'meeting',
        allowPast: true,
      });

    expect(res.status).toBe(201);
    const body = res.body?.data ?? res.body;
    expect(body).toBeTruthy();
  });

  it('evento futuro valido: 201', async () => {
    const { jwt } = await makeAdminJwt();

    const start = new Date(Date.now() + 60 * 60_000).toISOString();
    const end = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

    const res = await request(app)
      .post('/api/calendar/events')
      .set(authHeader(jwt))
      .send({
        title: 'Reuniao futura',
        startTime: start,
        endTime: end,
        type: 'meeting',
      });

    expect(res.status).toBe(201);
  });
});
