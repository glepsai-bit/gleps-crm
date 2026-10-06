/**
 * ETAPA A — aceite de ponta a ponta (HTTP) dos módulos por conta.
 *
 * O teste unitário do requireModulo prova o middleware; este prova a MONTAGEM:
 * que ele está depois do authenticate em cada router, que as rotas públicas
 * (webhooks) ficaram de fora, e que o login/me entregam `account.modulos`.
 * Usa o Postgres de teste (precisa da migration 0068 aplicada nele).
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';

import { prismaTest } from '../test/setup';
import { authHeader, createTestAccount } from '../test/helpers';
import { createTestApp } from '../test/app';
import { MODULOS_OPCIONAIS } from '../config/modulos';

const app = createTestApp();

async function contaComJwt(modulos: string[], role: 'admin' | 'super_admin' = 'admin') {
  const account = await prismaTest.account.create({
    data: { nome: `Conta ${randomUUID().slice(0, 6)}`, modulos },
  });
  const user = await prismaTest.user.create({
    data: {
      accountId: account.id,
      nome: 'Admin',
      email: `mod-${randomUUID().slice(0, 8)}@t.com`,
      passwordHash: await bcrypt.hash('x', 4),
      role,
      status: 'active',
      permissions: [],
    },
  });
  const token = jwt.sign(
    { sub: user.id, email: user.email, role, accountId: account.id, permissions: [] },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' }
  );
  return { account, user, token };
}

// Uma rota GET de cada módulo do mapa (routes/index.ts).
const ROTA_POR_MODULO: Record<string, string> = {
  extracao: '/api/prospecting/searches',
  disparos: '/api/whatsapp-templates',
  emails: '/api/email/cadences',
  discador: '/api/voice/sip-credentials',
  vendas: '/api/sales',
  aquecimento: '/api/warmup/pools',
};

describe('módulos por conta — montagem nas rotas', () => {
  it('conta sem nenhum módulo toma 403 MODULO_DESLIGADO em cada rota do mapa', async () => {
    const { token } = await contaComJwt([]);

    for (const [modulo, rota] of Object.entries(ROTA_POR_MODULO)) {
      const res = await request(app).get(rota).set(authHeader(token));
      expect({ modulo, rota, status: res.status, code: res.body?.error?.code }).toEqual({
        modulo,
        rota,
        status: 403,
        code: 'MODULO_DESLIGADO',
      });
      expect(res.body.error.details).toEqual({ modulo });
    }
  });

  it('/dispatch e /whatsapp/campaigns (mesmo router) respondem MODULO_DESLIGADO sem "disparos"', async () => {
    const { token } = await contaComJwt(['extracao']);
    for (const rota of ['/api/dispatch/batches', '/api/whatsapp/campaigns/batches']) {
      const res = await request(app).get(rota).set(authHeader(token));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('MODULO_DESLIGADO');
    }
  });

  it('/finance e /email/audiences seguem vendas e emails', async () => {
    const { token } = await contaComJwt(['vendas']);
    const fin = await request(app).get('/api/finance/kpis').set(authHeader(token));
    expect(fin.body?.error?.code).not.toBe('MODULO_DESLIGADO');

    const aud = await request(app).get('/api/email/audiences').set(authHeader(token));
    expect(aud.status).toBe(403);
    expect(aud.body.error.code).toBe('MODULO_DESLIGADO');
  });

  it('conta com o módulo ligado NÃO recebe MODULO_DESLIGADO (o que vier depois é da rota)', async () => {
    const { token } = await contaComJwt([...MODULOS_OPCIONAIS]);

    for (const [, rota] of Object.entries(ROTA_POR_MODULO)) {
      const res = await request(app).get(rota).set(authHeader(token));
      expect(res.status).not.toBe(401);
      expect(res.body?.error?.code).not.toBe('MODULO_DESLIGADO');
    }
  });

  it('super admin não é bloqueado mesmo com a conta sem módulos', async () => {
    const { token } = await contaComJwt([], 'super_admin');
    const res = await request(app).get(ROTA_POR_MODULO.emails).set(authHeader(token));
    expect(res.status).not.toBe(403);
    expect(res.body?.error?.code).not.toBe('MODULO_DESLIGADO');
  });

  it('webhook público de e-mail continua fora do bloqueio (sem token, sem conta)', async () => {
    const res = await request(app).post('/api/email/inbound/webhook').send({});
    expect(res.status).not.toBe(401);
    expect(res.body?.error?.code).not.toBe('MODULO_DESLIGADO');
  });

  it('rota de núcleo (/tags) não exige módulo', async () => {
    const { token } = await contaComJwt([]);
    const res = await request(app).get('/api/tags').set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

describe('módulos por conta — login e /auth/me', () => {
  it('login devolve account.modulos e /auth/me também', async () => {
    const { user, password } = await createTestAccount();

    const login = await request(app).post('/api/auth/login').send({ email: user.email, password });
    expect(login.status).toBe(200);
    expect(login.body.data.account.modulos).toEqual([...MODULOS_OPCIONAIS]);

    const me = await request(app).get('/api/auth/me').set(authHeader(login.body.data.token));
    expect(me.status).toBe(200);
    expect(me.body.data.account.modulos).toEqual([...MODULOS_OPCIONAIS]);
  });
});

describe('módulos por conta — super admin administra', () => {
  it('POST /accounts nasce com o padrão; PUT troca; GET devolve', async () => {
    const { token } = await contaComJwt([], 'super_admin');

    const criada = await request(app)
      .post('/api/accounts')
      .set(authHeader(token))
      .send({ nome: 'Cliente Novo' });
    expect(criada.status).toBe(201);
    expect(criada.body.data.modulos).toEqual(['extracao', 'disparos']);

    const id = criada.body.data.id as string;
    const trocada = await request(app)
      .put(`/api/accounts/${id}`)
      .set(authHeader(token))
      .send({ modulos: ['emails'] });
    expect(trocada.status).toBe(200);
    expect(trocada.body.data.modulos).toEqual(['emails']);

    const lida = await request(app).get(`/api/accounts/${id}`).set(authHeader(token));
    expect(lida.body.data.modulos).toEqual(['emails']);

    const invalida = await request(app)
      .put(`/api/accounts/${id}`)
      .set(authHeader(token))
      .send({ modulos: ['emails', 'relatorios'] });
    expect(invalida.status).toBe(400);
  });
});
