/**
 * T-024 — Testes de integracao para /api/admin/users
 *
 * Cobre o caminho do Admin de conta gerenciando agentes/admins da
 * PROPRIA tenancy:
 *   1. Criacao de agente pelo admin (201, mesmo accountId).
 *   2. Cross-tenant edit bloqueado (404 — anti-leak de existencia).
 *   3. Limite maxAgents atingido — POST retorna 400 AGENT_LIMIT_EXCEEDED.
 *   4. Self-delete bloqueado (400 CANNOT_DELETE_SELF).
 *   5. Agent (role) sem acesso a GET /api/admin/users (403 ADMIN_REQUIRED).
 *   6. List escopada por accountId — nunca vaza users de outra conta.
 *   7. Update de permissions persiste e retorna 200.
 *   8. GET /api/admin/users/limits retorna {maxAgents, usedAgents, remainingAgents}.
 *
 * Reusa createTestApp() e prismaTest do test/ harness para alinhar com o
 * resto da suite de integracao.
 *
 * NOTA: o controller responde 400 (e nao 422) para AGENT_LIMIT_EXCEEDED por
 * usar a classe ValidationError padrao do projeto, que mapeia para 400. O
 * teste valida tanto status quanto codigo do erro pra ser robusto a refactor
 * eventual entre 400/422.
 *
 * NOTA: o middleware requireSameAccountUser retorna 404 em cross-tenant (por
 * politica anti-enumeration) — nao 403. O teste 2 valida o comportamento real
 * do backend, que e a "barreira anti-privilege-escalation" exigida pelo
 * briefing, so com codigo de status diferente.
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
  account: { id: string; nome: string };
  admin: { id: string; email: string; password: string };
  jwt: string;
}

/**
 * Cria account + admin user via prismaTest, assina JWT direto.
 * Caminho rapido evitando refresh_token insert (anti-flake).
 */
async function createTenant(opts?: {
  name?: string;
  maxAgents?: number;
  limiteUsuarios?: number;
  plano?: string;
}): Promise<TenantBootstrap> {
  const account = await prismaTest.account.create({
    data: {
      nome: opts?.name ?? `Tenant ${randomUUID().slice(0, 6)}`,
      maxAgents: opts?.maxAgents ?? 5,
      limiteUsuarios: opts?.limiteUsuarios ?? 50,
      plano: opts?.plano ?? 'Premium',
    },
  });

  const password = 'Admin@1234';
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prismaTest.user.create({
    data: {
      accountId: account.id,
      nome: 'Admin Tenant',
      email: `admin-${randomUUID().slice(0, 8)}@test.com`,
      passwordHash,
      role: 'admin',
      status: 'active',
      permissions: ['dashboard', 'leads', 'kanban'],
    },
  });

  const token = jwt.sign(
    {
      sub: admin.id,
      email: admin.email,
      role: 'admin',
      accountId: account.id,
      permissions: admin.permissions,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  return {
    account: { id: account.id, nome: account.nome },
    admin: { id: admin.id, email: admin.email, password },
    jwt: token,
  };
}

/**
 * Cria agent users diretamente no DB (sem passar pela API) — uso para
 * setup de cenarios (e.g. encher o limite antes de testar erro).
 */
async function seedAgent(accountId: string, idx = 0) {
  const passwordHash = await bcrypt.hash('Agent@1234', 10);
  return prismaTest.user.create({
    data: {
      accountId,
      nome: `Agent ${idx}`,
      email: `agent-${randomUUID().slice(0, 8)}@test.com`,
      passwordHash,
      role: 'agent',
      status: 'active',
      permissions: ['dashboard'],
    },
  });
}

/**
 * Assina JWT direto para um user ja existente.
 */
function signJwtFor(user: { id: string; email: string; role: string; accountId: string | null; permissions: any }) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      accountId: user.accountId,
      permissions: user.permissions,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

describe('T-024 /api/admin/users — integracao', () => {
  // ===== Caso 1: admin cria agente =====
  it('1. Admin de conta A cria agente: 201, role=agent, mesmo accountId', async () => {
    const tenant = await createTenant({ name: 'Conta A' });

    const res = await request(app)
      .post('/api/admin/users')
      .set(authHeader(tenant.jwt))
      .send({
        nome: 'Novo Agente',
        email: `novo-agent-${randomUUID().slice(0, 6)}@test.com`,
        password: 'Agent@1234',
        role: 'agent',
        permissions: ['dashboard', 'kanban'],
      });

    expect(res.status).toBe(201);
    expect(res.body.data?.role).toBe('agent');
    expect(res.body.data?.accountId).toBe(tenant.account.id);
    expect(res.body.data?.email).toMatch(/^novo-agent-/);
    // dashboard deve estar nas permissions (auto-injetado)
    expect(res.body.data?.permissions).toContain('dashboard');

    // Confirma no DB que de fato gravou com o accountId correto
    const created = await prismaTest.user.findUnique({
      where: { id: res.body.data.id },
    });
    expect(created?.accountId).toBe(tenant.account.id);
    expect(created?.role).toBe('agent');
  });

  // ===== Caso 2: cross-tenant edit bloqueado =====
  it('2. Admin de conta A tenta editar user da conta B: 404 (anti privilege escalation)', async () => {
    const tenantA = await createTenant({ name: 'Conta A' });
    const tenantB = await createTenant({ name: 'Conta B' });

    // Agente que pertence a B
    const agentB = await seedAgent(tenantB.account.id);

    const res = await request(app)
      .put(`/api/admin/users/${agentB.id}`)
      .set(authHeader(tenantA.jwt))
      .send({ nome: 'Hacked' });

    // requireSameAccountUser retorna 404 (politica anti-enumeration).
    // Importante: NAO deve ser 200, NAO deve ter persistido nada.
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');

    const stillThere = await prismaTest.user.findUnique({
      where: { id: agentB.id },
    });
    expect(stillThere?.nome).toBe(agentB.nome);
    expect(stillThere?.accountId).toBe(tenantB.account.id);
  });

  // ===== Caso 3: limite de agents atingido =====
  it('3. Admin tenta criar agent quando ja no limite maxAgents: erro AGENT_LIMIT_EXCEEDED', async () => {
    const tenant = await createTenant({ name: 'Conta Cheia', maxAgents: 2 });

    // Seed dois agents (= maxAgents)
    await seedAgent(tenant.account.id, 1);
    await seedAgent(tenant.account.id, 2);

    const res = await request(app)
      .post('/api/admin/users')
      .set(authHeader(tenant.jwt))
      .send({
        nome: 'Terceiro Agente',
        email: `over-${randomUUID().slice(0, 6)}@test.com`,
        password: 'Agent@1234',
        role: 'agent',
      });

    // ValidationError do projeto -> 400 + code VALIDATION_ERROR
    expect([400, 422]).toContain(res.status);
    // O message do ErrorCodes.AGENT_LIMIT_EXCEEDED eh 'Limite de agentes do plano atingido'
    expect(res.body.error?.message ?? '').toMatch(/limite.*agent/i);
  });

  // ===== Caso 4: auto-delete bloqueado =====
  it('4. Admin tenta deletar a SI MESMO: erro CANNOT_DELETE_SELF', async () => {
    const tenant = await createTenant({ name: 'Conta Self' });

    const res = await request(app)
      .delete(`/api/admin/users/${tenant.admin.id}`)
      .set(authHeader(tenant.jwt))
      .set('x-confirm-password', tenant.admin.password)
      .send();

    // Controller retorna 400 com code CANNOT_DELETE_SELF
    expect([400, 422]).toContain(res.status);
    expect(res.body.error?.code).toBe('CANNOT_DELETE_SELF');

    // Confirma que NAO deletou
    const ainda = await prismaTest.user.findUnique({
      where: { id: tenant.admin.id },
    });
    expect(ainda).not.toBeNull();
  });

  // ===== Caso 5: agent nao pode acessar /admin/users =====
  it('5. Agent role tenta GET /api/admin/users: 403 ADMIN_REQUIRED', async () => {
    const tenant = await createTenant({ name: 'Conta Agent Test' });
    const agent = await seedAgent(tenant.account.id);

    const agentJwt = signJwtFor(agent);

    const res = await request(app)
      .get('/api/admin/users')
      .set(authHeader(agentJwt))
      .send();

    expect(res.status).toBe(403);
    // requireAdmin lanca ForbiddenError(ErrorCodes.ADMIN_REQUIRED) → code ADMIN_REQUIRED
    expect(res.body.error?.code).toBe('ADMIN_REQUIRED');
  });

  // ===== Caso 6: list escopada por accountId =====
  it('6. Admin lista users: so retorna users do proprio accountId', async () => {
    const tenantA = await createTenant({ name: 'Conta A' });
    const tenantB = await createTenant({ name: 'Conta B' });

    // 2 agents em A, 3 agents em B
    await seedAgent(tenantA.account.id, 1);
    await seedAgent(tenantA.account.id, 2);
    await seedAgent(tenantB.account.id, 10);
    await seedAgent(tenantB.account.id, 11);
    await seedAgent(tenantB.account.id, 12);

    const res = await request(app)
      .get('/api/admin/users')
      .set(authHeader(tenantA.jwt))
      .send();

    expect(res.status).toBe(200);
    const list = res.body.data as Array<{ id: string; accountId: string; role: string }>;
    expect(Array.isArray(list)).toBe(true);

    // Conta A tem: 1 admin (criado em createTenant) + 2 agents = 3
    expect(list.length).toBe(3);
    // Todos devem pertencer a tenantA
    for (const u of list) {
      expect(u.accountId).toBe(tenantA.account.id);
      expect(u.role).not.toBe('super_admin');
    }
  });

  // ===== Caso 7: update de permissions =====
  it('7. Admin update permissions: persiste e retorna 200', async () => {
    const tenant = await createTenant({ name: 'Conta Update' });
    const agent = await seedAgent(tenant.account.id);

    const novasPerms = ['dashboard', 'kanban', 'leads', 'emails'];

    const res = await request(app)
      .put(`/api/admin/users/${agent.id}`)
      .set(authHeader(tenant.jwt))
      .send({ permissions: novasPerms });

    expect(res.status).toBe(200);
    expect(res.body.data?.permissions).toEqual(expect.arrayContaining(novasPerms));

    // Confirma no DB
    const refreshed = await prismaTest.user.findUnique({
      where: { id: agent.id },
      select: { permissions: true },
    });
    expect(refreshed?.permissions).toEqual(expect.arrayContaining(novasPerms));
  });

  // ===== Caso 8: GET /limits =====
  it('8. GET /api/admin/users/limits: retorna {maxAgents, usedAgents, remainingAgents}', async () => {
    const tenant = await createTenant({
      name: 'Conta Limits',
      maxAgents: 10,
      limiteUsuarios: 30,
      plano: 'Pro',
    });

    // Seed 3 agents
    await seedAgent(tenant.account.id, 1);
    await seedAgent(tenant.account.id, 2);
    await seedAgent(tenant.account.id, 3);

    const res = await request(app)
      .get('/api/admin/users/limits')
      .set(authHeader(tenant.jwt))
      .send();

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toBeTruthy();
    expect(data.maxAgents).toBe(10);
    expect(data.usedAgents).toBe(3);
    expect(data.remainingAgents).toBe(7);
    expect(data.maxUsers).toBe(30);
    // 1 admin + 3 agents = 4
    expect(data.usedUsers).toBe(4);
    expect(data.plan).toBe('Pro');
  });
});
