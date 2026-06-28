/**
 * AREA T3 — Seguranca / contact.controller (validacao + search seguro).
 *
 * Cobre:
 *  - Schema zod: nome obrigatorio e nao-vazio (trim).
 *  - Unique constraint (accountId, telefone) — 1x 201 + 1x 409 via errorHandler.
 *  - Busca segura: escapeLike rejeita wildcards SQL `%` e `_`
 *    (sem escape, qualquer busca por `%` retornaria TODOS os contatos).
 *  - Limite de tamanho de telefone (VarChar(50) no DB).
 *
 * NOTA infra (FLAKY KNOWN): o `beforeEach` da infra (setup.ts) faz TRUNCATE
 * CASCADE via `prismaTest`, mas o singleton `prisma` (usado pelos services
 * em routes/controllers) tem seu proprio pool de conexoes. Em runs onde
 * conexoes do singleton ainda seguram locks/transactions de testes anteriores,
 * o TRUNCATE colide e produz FK violation ou snapshot stale.
 *
 * Esse problema ja foi documentado em multi-tenant.test.ts e tambem afeta
 * sla.controller.test.ts. Workaround padrao (insuficiente):
 *  - JWT assinado direto evita refresh_tokens insert via login().
 *  - Helpers via `prismaTest` conforme contrato da infra.
 *
 * Tests sao escritos para o caso "verde" — em runs flakey, re-rodar.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { prismaTest } from '../test/setup';
import { authHeader } from '../test/helpers';
import { createTestApp } from '../test/app';

const app = createTestApp();

const JWT_SECRET =
  process.env.JWT_SECRET ?? 'test-jwt-secret-minimo-32-chars-aaaaaaaa';

/**
 * Cria account + admin via prismaTest e assina JWT direto.
 * Evita o caminho login()/refresh_token que ja causou flake em outras suites.
 */
async function createTenant(name = 'Tenant Test') {
  const account = await prismaTest.account.create({ data: { nome: name } });
  const passwordHash = await bcrypt.hash('Test@1234', 10);
  const user = await prismaTest.user.create({
    data: {
      accountId: account.id,
      nome: 'Admin Test',
      email: `admin-${randomUUID().slice(0, 8)}@test.com`,
      passwordHash,
      role: 'admin',
      status: 'active',
      permissions: ['dashboard', 'leads', 'kanban', 'emails', 'whatsapp_templates'],
    },
  });

  const token = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: 'admin',
      accountId: account.id,
      permissions: user.permissions,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  return { account, user, jwt: token };
}

describe('contact.controller / POST /api/contacts — validacao', () => {
  it('rejeita body vazio: 400 nome obrigatorio', async () => {
    const { jwt } = await createTenant();
    const res = await request(app)
      .post('/api/contacts')
      .set(authHeader(jwt))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    const raw = JSON.stringify(res.body);
    expect(raw).toContain('nome');
  });

  it('rejeita nome=" " (so espaco em branco — trim().min(1))', async () => {
    const { jwt } = await createTenant();
    const res = await request(app)
      .post('/api/contacts')
      .set(authHeader(jwt))
      .send({ nome: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('aceita nome valido: 201', async () => {
    const { jwt } = await createTenant();
    const res = await request(app)
      .post('/api/contacts')
      .set(authHeader(jwt))
      .send({ nome: 'Maria Silva' });
    expect(res.status).toBe(201);
    expect(res.body.data?.nome).toBe('Maria Silva');
    expect(res.body.data?.id).toBeTruthy();
  });

  it('rejeita 2x mesmo telefone na mesma conta: 1x 201 + 1x 409', async () => {
    const { jwt } = await createTenant();
    const telefone = '5534999998888';

    const res1 = await request(app)
      .post('/api/contacts')
      .set(authHeader(jwt))
      .send({ nome: 'Contato 1', telefone });
    expect(res1.status).toBe(201);

    const res2 = await request(app)
      .post('/api/contacts')
      .set(authHeader(jwt))
      .send({ nome: 'Contato 2', telefone });
    // errorHandler converte P2002 (unique violation no DB) em 409 CONFLICT.
    expect(res2.status).toBe(409);
    expect(res2.body.error?.code).toBe('CONFLICT');
  });

  it('rejeita telefone com tamanho absurdo (1000 digitos)', async () => {
    const { jwt } = await createTenant();
    const telefonelongo = '1'.repeat(1000);
    const res = await request(app)
      .post('/api/contacts')
      .set(authHeader(jwt))
      .send({ nome: 'Contato Longo', telefone: telefonelongo });
    // DB tem VarChar(50) — INSERT rejeitado pelo Prisma/Postgres antes de
    // gravar. Aceita qualquer 4xx/5xx; o que importa e' que NAO foi 201.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(201);
  });
});

describe('contact.controller / GET /api/contacts — busca segura (escapeLike)', () => {
  it("search='%' retorna [] (escape de wildcard, nao matcha tudo)", async () => {
    const { account, jwt } = await createTenant();
    await prismaTest.contact.createMany({
      data: [
        { accountId: account.id, nome: 'Alice Costa' },
        { accountId: account.id, nome: 'Bruno Lima' },
        { accountId: account.id, nome: 'Carla Souza' },
      ],
    });

    const res = await request(app)
      .get('/api/contacts')
      .query({ search: '%' })
      .set(authHeader(jwt));
    expect(res.status).toBe(200);
    // Se escapeLike NAO funcionasse, `%` viraria wildcard SQL e retornaria os 3.
    // Como funciona, busca literal por `%` -> nenhum match.
    expect(res.body.data).toEqual([]);
  });

  it("search='_' retorna [] (escape de wildcard single-char)", async () => {
    const { account, jwt } = await createTenant();
    await prismaTest.contact.createMany({
      data: [
        { accountId: account.id, nome: 'Ana' },
        { accountId: account.id, nome: 'Bob' },
        { accountId: account.id, nome: 'Eve' },
      ],
    });

    const res = await request(app)
      .get('/api/contacts')
      .query({ search: '_' })
      .set(authHeader(jwt));
    expect(res.status).toBe(200);
    // Sem escape, `_` matcharia qualquer 1 char — todos os 3 nomes (3 letras).
    // Com escape, busca literal por `_` -> nenhum match.
    expect(res.body.data).toEqual([]);
  });

  it("search='Joao' matcha contato real com esse nome", async () => {
    const { account, jwt } = await createTenant();
    await prismaTest.contact.createMany({
      data: [
        { accountId: account.id, nome: 'Joao da Silva' },
        { accountId: account.id, nome: 'Maria Souza' },
      ],
    });

    const res = await request(app)
      .get('/api/contacts')
      .query({ search: 'Joao' })
      .set(authHeader(jwt));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].nome).toBe('Joao da Silva');
  });
});
