/**
 * Integration tests for integration-lookup.controller.ts
 *
 * Cobre os 2 endpoints de discovery em /api/integrations/* —
 *   GET /teams
 *   GET /users?role=&teamId=&available=
 *
 * Foco: auth, scopes, multi-tenant, filtros, hardening (NUNCA expor
 * passwordHash, refreshToken, permissions ou outros campos sensíveis).
 *
 * Não há mock de Evolution aqui — endpoints são puramente Prisma.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

import { prismaTest } from '../test/setup';
import {
  createTestAccount,
  createTestApiKey,
  apiKeyHeader,
} from '../test/helpers';
import { createTestApp } from '../test/app';

const app = createTestApp();

// ─── Local helpers ────────────────────────────────────────────────────────

async function createTeam(accountId: string, name: string) {
  return prismaTest.team.create({
    data: { accountId, name },
  });
}

async function createAgent(
  accountId: string,
  options?: {
    nome?: string;
    email?: string;
    role?: 'agent' | 'admin';
    status?: 'active' | 'inactive' | 'suspended';
  }
) {
  return prismaTest.user.create({
    data: {
      accountId,
      nome: options?.nome ?? 'Agente Teste',
      email: (options?.email ?? `agent-${randomUUID().slice(0, 8)}@t.com`).toLowerCase(),
      passwordHash: 'super-secret-hash-nao-pode-vazar',
      role: options?.role ?? 'agent',
      status: options?.status ?? 'active',
      permissions: ['leads', 'kanban'],
    },
  });
}

async function addToTeam(teamId: string, userId: string) {
  return prismaTest.teamMember.create({
    data: { teamId, userId, role: 'member' },
  });
}

async function setAvailability(
  userId: string,
  status: 'online' | 'away' | 'busy' | 'offline'
) {
  return prismaTest.agentAvailability.upsert({
    where: { userId },
    update: { status },
    create: { userId, status },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('IntegrationLookupController', () => {
  // ============================================
  // GET /api/integrations/teams
  // ============================================
  describe('GET /api/integrations/teams', () => {
    it('sem api-key: 401', async () => {
      const res = await request(app).get('/api/integrations/teams');
      expect(res.status).toBe(401);
    });

    it('com scope insuficiente (kanban:read): 403', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:read']);

      const res = await request(app)
        .get('/api/integrations/teams')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('API_KEY_SCOPE_DENIED');
    });

    it('happy path: 200 + retorna times da conta com agentsCount', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:read']);

      const teamA = await createTeam(account.id, 'Vendas');
      const teamB = await createTeam(account.id, 'Suporte');

      const u1 = await createAgent(account.id);
      const u2 = await createAgent(account.id);
      await addToTeam(teamA.id, u1.id);
      await addToTeam(teamA.id, u2.id);
      await addToTeam(teamB.id, u1.id);

      const res = await request(app)
        .get('/api/integrations/teams')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(2);

      const byName = new Map<string, any>(res.body.data.map((t: any) => [t.name, t]));
      expect(byName.get('Vendas')).toMatchObject({
        id: teamA.id,
        name: 'Vendas',
        slug: 'vendas',
        agentsCount: 2,
      });
      expect(byName.get('Suporte')).toMatchObject({
        id: teamB.id,
        name: 'Suporte',
        slug: 'suporte',
        agentsCount: 1,
      });
    });

    it('multi-tenant: só retorna times da accountId da chave', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });
      const { plaintextKey } = await createTestApiKey(accA.account.id, ['chat:read']);

      await createTeam(accA.account.id, 'A-Team');
      await createTeam(accB.account.id, 'B-Team');
      await createTeam(accB.account.id, 'B-Team-2');

      const res = await request(app)
        .get('/api/integrations/teams')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('A-Team');
      // garante que nenhum nome de outra conta vazou
      const names = res.body.data.map((t: any) => t.name);
      expect(names).not.toContain('B-Team');
      expect(names).not.toContain('B-Team-2');
    });

    it('conta sem times: 200 + array vazio', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:read']);

      const res = await request(app)
        .get('/api/integrations/teams')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // ============================================
  // GET /api/integrations/users
  // ============================================
  describe('GET /api/integrations/users', () => {
    it('sem api-key: 401', async () => {
      const res = await request(app).get('/api/integrations/users');
      expect(res.status).toBe(401);
    });

    it('com scope insuficiente: 403', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:read']);

      const res = await request(app)
        .get('/api/integrations/users')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(403);
    });

    it('role=agent: retorna apenas agents (admin excluído)', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:read']);

      // createTestAccount já criou um admin. Criamos 2 agents e 1 admin.
      await createAgent(account.id, { nome: 'Agent 1', role: 'agent' });
      await createAgent(account.id, { nome: 'Agent 2', role: 'agent' });
      await createAgent(account.id, { nome: 'Outro Admin', role: 'admin' });

      const res = await request(app)
        .get('/api/integrations/users?role=agent')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      for (const u of res.body.data) {
        expect(u.role).toBe('agent');
      }
    });

    it('teamId: filtra apenas membros do time', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:read']);

      const team = await createTeam(account.id, 'Vendas');
      const otherTeam = await createTeam(account.id, 'Suporte');

      const inTeam1 = await createAgent(account.id, { nome: 'In Team 1' });
      const inTeam2 = await createAgent(account.id, { nome: 'In Team 2' });
      const outOfTeam = await createAgent(account.id, { nome: 'Sozinho' });
      const inOther = await createAgent(account.id, { nome: 'No outro' });

      await addToTeam(team.id, inTeam1.id);
      await addToTeam(team.id, inTeam2.id);
      await addToTeam(otherTeam.id, inOther.id);

      const res = await request(app)
        .get(`/api/integrations/users?teamId=${team.id}`)
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      const ids = (res.body.data as any[]).map((u) => u.id).sort();
      expect(ids).toEqual([inTeam1.id, inTeam2.id].sort());
      expect(ids).not.toContain(outOfTeam.id);
      expect(ids).not.toContain(inOther.id);
    });

    it('teamId de outra conta: 200 + array vazio (cross-tenant guard)', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });
      const { plaintextKey } = await createTestApiKey(accA.account.id, ['chat:read']);

      const teamB = await createTeam(accB.account.id, 'B-Team');
      await createAgent(accA.account.id, { nome: 'Não filtra por team alheio' });

      const res = await request(app)
        .get(`/api/integrations/users?teamId=${teamB.id}`)
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('available=true: filtra por AgentAvailability.status=online', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:read']);

      const u1 = await createAgent(account.id, { nome: 'Online' });
      const u2 = await createAgent(account.id, { nome: 'Away' });
      const u3 = await createAgent(account.id, { nome: 'Sem Status' });

      await setAvailability(u1.id, 'online');
      await setAvailability(u2.id, 'away');
      // u3 sem availability registrada

      const res = await request(app)
        .get('/api/integrations/users?role=agent&available=true')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      const ids = (res.body.data as any[]).map((u) => u.id);
      expect(ids).toEqual([u1.id]);
    });

    it('NUNCA expõe campos sensíveis (passwordHash, refreshTokens, permissions)', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:read']);

      await createAgent(account.id, { nome: 'Snitch' });

      const res = await request(app)
        .get('/api/integrations/users')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);

      for (const u of res.body.data) {
        // shape esperado
        expect(u).toHaveProperty('id');
        expect(u).toHaveProperty('nome');
        expect(u).toHaveProperty('email');
        expect(u).toHaveProperty('role');
        expect(u).toHaveProperty('teamIds');
        expect(u).toHaveProperty('status');
        expect(u).toHaveProperty('lastSeenAt');

        // sensíveis: NÃO podem estar presentes
        expect(u).not.toHaveProperty('passwordHash');
        expect(u).not.toHaveProperty('password_hash');
        expect(u).not.toHaveProperty('refreshTokens');
        expect(u).not.toHaveProperty('refresh_tokens');
        expect(u).not.toHaveProperty('permissions');
        expect(u).not.toHaveProperty('accountId');
        expect(u).not.toHaveProperty('account_id');
      }

      // sanity: serializing inteiro também não pode mencionar o hash
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('super-secret-hash-nao-pode-vazar');
    });

    it('multi-tenant: só retorna users da accountId da chave', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });
      const { plaintextKey } = await createTestApiKey(accA.account.id, ['chat:read']);

      await createAgent(accA.account.id, { nome: 'A-Agent' });
      await createAgent(accB.account.id, { nome: 'B-Agent' });
      await createAgent(accB.account.id, { nome: 'B-Agent-2' });

      const res = await request(app)
        .get('/api/integrations/users?role=agent')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      const names = (res.body.data as any[]).map((u) => u.nome);
      expect(names).toContain('A-Agent');
      expect(names).not.toContain('B-Agent');
      expect(names).not.toContain('B-Agent-2');
    });
  });
});
