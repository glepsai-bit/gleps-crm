/**
 * ETAPA G (P0-6) — nenhuma resposta da API traz segredo da conta em texto puro.
 *
 * Contra o Postgres de teste, pela API: `GET /accounts`, `GET /accounts/:id`,
 * `GET /accounts/:id/stats`, `POST /accounts`, `PUT /accounts/:id`,
 * `POST /accounts/:id/pause|activate`, `POST /auth/login` e `GET /auth/me`.
 * E o PUT que devolve o valor mascarado NÃO sobrescreve a chave real.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { prismaTest } from '../test/setup';
import { authHeader } from '../test/helpers';
import { createTestApp } from '../test/app';

const app = createTestApp();

const SEGREDOS = {
  openaiApiKey: 'sk-openai-ABCD1234',
  anthropicApiKey: 'sk-ant-WXYZ5678',
  evolutionApiKey: 'evo-key-9999',
  evolutionWebhookSecret: 'segredo-webhook-muito-longo-16',
  sendgridApiKey: 'SG.abcdef.0001',
  googleClientSecret: 'gcs-secret-7777',
  twilioAccountSid: 'AC1234567890abcdef',
  twilioAuthToken: 'tw-token-4321',
  twilioApiKeySecret: 'tw-api-secret-5555',
  sipPassword: 'sip-pass-2468',
} as const;

const VALORES_SECRETOS = Object.values(SEGREDOS);

function semNenhumSegredo(corpo: unknown) {
  const json = JSON.stringify(corpo);
  for (const v of VALORES_SECRETOS) expect(json, `vazou ${v}`).not.toContain(v);
}

async function superAdmin() {
  const user = await prismaTest.user.create({
    data: {
      accountId: null,
      nome: 'Super',
      email: `super-${randomUUID().slice(0, 8)}@gleps.com`,
      passwordHash: bcrypt.hashSync('x', 4),
      role: 'super_admin',
      status: 'active',
      permissions: [],
    },
  });
  return jwt.sign(
    { sub: user.id, email: user.email, role: 'super_admin', accountId: null, permissions: [] },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' }
  );
}

async function contaComSegredos() {
  const account = await prismaTest.account.create({
    data: { nome: 'Conta Cheia de Segredos', ...SEGREDOS, googleClientId: 'cliente-publico', sipUsername: 'ramal1' },
  });
  const senha = 'Senha@1234';
  const admin = await prismaTest.user.create({
    data: {
      accountId: account.id,
      nome: 'Admin',
      email: `admin-${randomUUID().slice(0, 8)}@t.com`,
      passwordHash: bcrypt.hashSync(senha, 4),
      role: 'admin',
      status: 'active',
      permissions: ['dashboard'],
    },
  });
  return { account, admin, senha };
}

describe('leituras de conta (super admin) saem mascaradas', () => {
  it('GET /accounts, GET /accounts/:id e GET /accounts/:id/stats: •••• + 4 últimos, flags de chave, nada em texto puro', async () => {
    const token = await superAdmin();
    const { account } = await contaComSegredos();

    const lista = await request(app).get('/api/accounts').set(authHeader(token));
    expect(lista.status).toBe(200);
    const daLista = lista.body.data.find((a: { id: string }) => a.id === account.id);
    expect(daLista).toMatchObject({
      openaiApiKey: '••••1234',
      anthropicApiKey: '••••5678',
      evolutionApiKey: '••••9999',
      evolutionWebhookSecret: '••••o-16',
      sendgridApiKey: '••••0001',
      googleClientSecret: '••••7777',
      googleClientId: 'cliente-publico',
      twilioAccountSid: '••••cdef',
      twilioAuthToken: '••••4321',
      twilioApiKeySecret: '••••5555',
      sipPassword: '••••2468',
      sipUsername: 'ramal1',
      temChaveOpenai: true,
      temChaveAnthropic: true,
    });
    semNenhumSegredo(lista.body);

    const um = await request(app).get(`/api/accounts/${account.id}`).set(authHeader(token));
    expect(um.status).toBe(200);
    expect(um.body.data).toMatchObject({ openaiApiKey: '••••1234', sipPassword: '••••2468', temChaveOpenai: true, usersCount: 1 });
    semNenhumSegredo(um.body);

    const stats = await request(app).get(`/api/accounts/${account.id}/stats`).set(authHeader(token));
    expect(stats.status).toBe(200);
    expect(stats.body.data.account.openaiApiKey).toBe('••••1234');
    semNenhumSegredo(stats.body);
  });

  it('conta sem chave: campos null e flags false', async () => {
    const token = await superAdmin();
    const vazia = await prismaTest.account.create({ data: { nome: 'Vazia' } });
    const um = await request(app).get(`/api/accounts/${vazia.id}`).set(authHeader(token));
    expect(um.body.data).toMatchObject({ openaiApiKey: null, anthropicApiKey: null, temChaveOpenai: false, temChaveAnthropic: false });
  });

  it('POST /accounts, pause e activate também voltam mascarados', async () => {
    const token = await superAdmin();
    const criada = await request(app)
      .post('/api/accounts')
      .set(authHeader(token))
      .send({ nome: 'Nova Conta', evolutionApiKey: 'evo-nova-chave-1111', evolutionWebhookSecret: 'webhook-secret-da-nova-conta' });
    expect(criada.status).toBe(201);
    expect(criada.body.data).toMatchObject({ evolutionApiKey: '••••1111', evolutionWebhookSecret: '••••onta', temChaveOpenai: false });
    expect(JSON.stringify(criada.body)).not.toContain('evo-nova-chave');
    expect((await prismaTest.account.findUnique({ where: { id: criada.body.data.id } }))?.evolutionApiKey).toBe('evo-nova-chave-1111');

    const { account } = await contaComSegredos();
    const pausada = await request(app).post(`/api/accounts/${account.id}/pause`).set(authHeader(token)).send({ reason: 'teste' });
    expect(pausada.status).toBe(200);
    expect(pausada.body.data).toMatchObject({ status: 'paused', openaiApiKey: '••••1234' });
    semNenhumSegredo(pausada.body);
    const ativada = await request(app).post(`/api/accounts/${account.id}/activate`).set(authHeader(token));
    expect(ativada.body.data).toMatchObject({ status: 'active', sipPassword: '••••2468' });
    semNenhumSegredo(ativada.body);
  });
});

describe('PUT /accounts/:id com valor mascarado', () => {
  it('ignora o que veio mascarado (••••xxxx e ***SET***), grava o que veio real, aceita null para limpar', async () => {
    const token = await superAdmin();
    const { account } = await contaComSegredos();

    // 1. O formulário devolveu tudo como leu: nada muda, nem o webhook secret de 8 chars passa pelo min(16).
    const eco = await request(app)
      .put(`/api/accounts/${account.id}`)
      .set(authHeader(token))
      .send({
        nome: 'Renomeada',
        openaiApiKey: '••••1234',
        anthropicApiKey: '••••5678',
        evolutionApiKey: '••••9999',
        evolutionWebhookSecret: '••••o-16',
        sendgridApiKey: '***SET***',
        googleClientSecret: '••••7777',
      });
    expect(eco.status, JSON.stringify(eco.body)).toBe(200);
    expect(eco.body.data).toMatchObject({ nome: 'Renomeada', openaiApiKey: '••••1234', temChaveOpenai: true });
    semNenhumSegredo(eco.body);
    const depois = await prismaTest.account.findUnique({ where: { id: account.id } });
    expect(depois).toMatchObject({ nome: 'Renomeada', ...SEGREDOS });

    // 2. Valor real novo grava; a resposta vem mascarada com os 4 últimos novos.
    const nova = await request(app)
      .put(`/api/accounts/${account.id}`)
      .set(authHeader(token))
      .send({ openaiApiKey: 'sk-nova-chave-9999', sendgridApiKey: '••••0001' });
    expect(nova.status).toBe(200);
    expect(nova.body.data.openaiApiKey).toBe('••••9999');
    expect(JSON.stringify(nova.body)).not.toContain('sk-nova-chave');
    const depois2 = await prismaTest.account.findUnique({ where: { id: account.id } });
    expect(depois2?.openaiApiKey).toBe('sk-nova-chave-9999');
    expect(depois2?.sendgridApiKey).toBe(SEGREDOS.sendgridApiKey);

    // 3. null limpa de verdade.
    const limpa = await request(app).put(`/api/accounts/${account.id}`).set(authHeader(token)).send({ openaiApiKey: null });
    expect(limpa.status).toBe(200);
    expect(limpa.body.data).toMatchObject({ openaiApiKey: null, temChaveOpenai: false });
    expect((await prismaTest.account.findUnique({ where: { id: account.id } }))?.openaiApiKey).toBeNull();
  });
});

describe('login e /auth/me do admin da conta', () => {
  it('não trazem nenhum segredo (nem o campo)', async () => {
    const { admin, senha } = await contaComSegredos();
    const login = await request(app).post('/api/auth/login').send({ email: admin.email, password: senha });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    semNenhumSegredo(login.body);
    expect(login.body.data.account).not.toHaveProperty('openaiApiKey');

    const me = await request(app).get('/api/auth/me').set(authHeader(login.body.data.token));
    expect(me.status).toBe(200);
    semNenhumSegredo(me.body);
    expect(me.body.data.account).not.toHaveProperty('openaiApiKey');
    expect(me.body.data.account).not.toHaveProperty('sipPassword');
  });
});
