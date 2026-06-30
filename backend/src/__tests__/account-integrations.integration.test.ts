/**
 * T-025 — Testes de integracao para /api/admin/integrations/ai
 *
 * Cobre o caminho do Admin de conta configurando chaves de IA self-service
 * (OpenAI + Anthropic), sem mexer em super_admin:
 *   1. GET retorna '***SET***' quando setado, null quando vazio.
 *   2. PATCH ignora sentinel '***SET***' (nao apaga valor real).
 *   3. PATCH com '' limpa o campo (set null).
 *   4. PATCH com null limpa o campo.
 *   5. PATCH grava nova chave em texto puro no DB (mas API responde mascarado).
 *   6. Admin da conta A nao toca conta B (isolamento tenant).
 *   7. Agent role bloqueado: 403 ADMIN_REQUIRED.
 *   8. POST test/openai com chave invalida retorna ok:false.
 *   9. POST test sem chave configurada retorna ok:false com mensagem clara.
 *  10. POST test/:provider invalido retorna 400 VALIDATION_ERROR.
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

interface TenantBootstrap {
  account: { id: string };
  admin: { id: string; email: string };
  agentJwt: string;
  jwt: string;
}

async function createTenant(opts?: {
  openaiApiKey?: string | null;
  anthropicApiKey?: string | null;
}): Promise<TenantBootstrap> {
  const account = await prismaTest.account.create({
    data: {
      nome: `Tenant ${randomUUID().slice(0, 6)}`,
      openaiApiKey: opts?.openaiApiKey ?? null,
      anthropicApiKey: opts?.anthropicApiKey ?? null,
    },
  });

  const passwordHash = await bcrypt.hash('Admin@1234', 10);
  const admin = await prismaTest.user.create({
    data: {
      accountId: account.id,
      nome: 'Admin',
      email: `admin-${randomUUID().slice(0, 8)}@test.com`,
      passwordHash,
      role: 'admin',
      status: 'active',
      permissions: ['dashboard'],
    },
  });

  const agent = await prismaTest.user.create({
    data: {
      accountId: account.id,
      nome: 'Agent',
      email: `agent-${randomUUID().slice(0, 8)}@test.com`,
      passwordHash,
      role: 'agent',
      status: 'active',
      permissions: ['dashboard'],
    },
  });

  const sign = (u: { id: string; email: string; role: string; accountId: string | null; permissions: any }) =>
    jwt.sign(
      {
        sub: u.id,
        email: u.email,
        role: u.role,
        accountId: u.accountId,
        permissions: u.permissions,
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

  return {
    account: { id: account.id },
    admin: { id: admin.id, email: admin.email },
    jwt: sign(admin),
    agentJwt: sign(agent),
  };
}

describe('T-025 /api/admin/integrations/ai — integracao', () => {
  // ===== Caso 1: GET sentinel/null =====
  it('1. GET retorna ***SET*** quando setado e null quando vazio', async () => {
    const tenant = await createTenant({
      openaiApiKey: 'sk-real-openai-key-xxxxxxxxxxxxxxx',
      anthropicApiKey: null,
    });

    const res = await request(app)
      .get('/api/admin/integrations/ai')
      .set(authHeader(tenant.jwt));

    expect(res.status).toBe(200);
    expect(res.body.data.openaiApiKey).toBe('***SET***');
    expect(res.body.data.anthropicApiKey).toBeNull();
    // Resposta NUNCA pode conter valor real
    const flat = JSON.stringify(res.body);
    expect(flat).not.toContain('sk-real-openai-key-xxxxxxxxxxxxxxx');
  });

  // ===== Caso 2: PATCH ignora sentinel =====
  it('2. PATCH com ***SET*** nao apaga valor real existente', async () => {
    const realKey = 'sk-keep-me-please-1234567890';
    const tenant = await createTenant({ openaiApiKey: realKey });

    const res = await request(app)
      .patch('/api/admin/integrations/ai')
      .set(authHeader(tenant.jwt))
      .send({ openaiApiKey: '***SET***' });

    expect(res.status).toBe(200);
    expect(res.body.data.openaiApiKey).toBe('***SET***');

    // Confirma no DB que o valor REAL nao mudou
    const acc = await prismaTest.account.findUnique({
      where: { id: tenant.account.id },
      select: { openaiApiKey: true },
    });
    expect(acc?.openaiApiKey).toBe(realKey);
  });

  // ===== Caso 3: PATCH com string vazia limpa =====
  it('3. PATCH com string vazia limpa o campo', async () => {
    const tenant = await createTenant({ openaiApiKey: 'sk-will-be-cleared' });

    const res = await request(app)
      .patch('/api/admin/integrations/ai')
      .set(authHeader(tenant.jwt))
      .send({ openaiApiKey: '' });

    expect(res.status).toBe(200);
    expect(res.body.data.openaiApiKey).toBeNull();

    const acc = await prismaTest.account.findUnique({
      where: { id: tenant.account.id },
      select: { openaiApiKey: true },
    });
    expect(acc?.openaiApiKey).toBeNull();
  });

  // ===== Caso 4: PATCH com null limpa =====
  it('4. PATCH com null limpa o campo', async () => {
    const tenant = await createTenant({ anthropicApiKey: 'sk-ant-old' });

    const res = await request(app)
      .patch('/api/admin/integrations/ai')
      .set(authHeader(tenant.jwt))
      .send({ anthropicApiKey: null });

    expect(res.status).toBe(200);
    expect(res.body.data.anthropicApiKey).toBeNull();

    const acc = await prismaTest.account.findUnique({
      where: { id: tenant.account.id },
      select: { anthropicApiKey: true },
    });
    expect(acc?.anthropicApiKey).toBeNull();
  });

  // ===== Caso 5: PATCH grava nova chave =====
  it('5. PATCH com nova chave persiste no DB e API devolve mascarada', async () => {
    const tenant = await createTenant();
    const newKey = 'sk-novinha-em-folha-9999';

    const res = await request(app)
      .patch('/api/admin/integrations/ai')
      .set(authHeader(tenant.jwt))
      .send({ openaiApiKey: newKey, anthropicApiKey: 'sk-ant-novinha' });

    expect(res.status).toBe(200);
    expect(res.body.data.openaiApiKey).toBe('***SET***');
    expect(res.body.data.anthropicApiKey).toBe('***SET***');

    const acc = await prismaTest.account.findUnique({
      where: { id: tenant.account.id },
      select: { openaiApiKey: true, anthropicApiKey: true },
    });
    expect(acc?.openaiApiKey).toBe(newKey);
    expect(acc?.anthropicApiKey).toBe('sk-ant-novinha');
  });

  // ===== Caso 6: isolamento tenant =====
  it('6. Admin da conta A nao toca chaves da conta B', async () => {
    const keyB = 'sk-conta-B-intocavel';
    const tenantA = await createTenant();
    const tenantB = await createTenant({ openaiApiKey: keyB });

    // Admin A faz GET — so deve ver chaves de A
    const resGet = await request(app)
      .get('/api/admin/integrations/ai')
      .set(authHeader(tenantA.jwt));
    expect(resGet.status).toBe(200);
    expect(resGet.body.data.openaiApiKey).toBeNull();

    // Admin A faz PATCH — vai para a propria conta A, nao B
    await request(app)
      .patch('/api/admin/integrations/ai')
      .set(authHeader(tenantA.jwt))
      .send({ openaiApiKey: 'sk-conta-A-nova' });

    const accA = await prismaTest.account.findUnique({
      where: { id: tenantA.account.id },
      select: { openaiApiKey: true },
    });
    const accB = await prismaTest.account.findUnique({
      where: { id: tenantB.account.id },
      select: { openaiApiKey: true },
    });
    expect(accA?.openaiApiKey).toBe('sk-conta-A-nova');
    expect(accB?.openaiApiKey).toBe(keyB);
  });

  // ===== Caso 7: agent bloqueado =====
  it('7. Agent role tenta GET: 403 ADMIN_REQUIRED', async () => {
    const tenant = await createTenant();

    const res = await request(app)
      .get('/api/admin/integrations/ai')
      .set(authHeader(tenant.agentJwt));

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('ADMIN_REQUIRED');
  });

  // ===== Caso 8: test/openai chave invalida =====
  it(
    '8. POST test/openai com chave invalida no DB retorna ok:false',
    async () => {
      const tenant = await createTenant({
        openaiApiKey: 'sk-totally-fake-key-will-401',
      });

      const res = await request(app)
        .post('/api/admin/integrations/ai/test/openai')
        .set(authHeader(tenant.jwt));

      expect(res.status).toBe(200);
      expect(res.body.data.ok).toBe(false);
      expect(typeof res.body.data.message).toBe('string');
    },
    20_000
  );

  // ===== Caso 9: test sem chave =====
  it('9. POST test/openai sem chave configurada retorna ok:false', async () => {
    const tenant = await createTenant();

    const res = await request(app)
      .post('/api/admin/integrations/ai/test/openai')
      .set(authHeader(tenant.jwt));

    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.message).toMatch(/nao configurada/i);
  });

  // ===== Caso 10: provider invalido =====
  it('10. POST test/:provider invalido retorna 400 VALIDATION_ERROR', async () => {
    const tenant = await createTenant();

    const res = await request(app)
      .post('/api/admin/integrations/ai/test/gemini')
      .set(authHeader(tenant.jwt));

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });
});
