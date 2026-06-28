/**
 * Integration tests para warmup.controller.ts (T-023 Phase 2B)
 *
 * Cobertura:
 *   - Auth & RBAC (sem JWT -> 401, agent -> 403, admin -> 200/201)
 *   - Multi-tenant (cross-tenant -> 404)
 *   - Pools CRUD (create, list, patch, delete)
 *   - Numbers CRUD (create com phone invalido, duplicado -> 409)
 *   - Lifecycle (start: warming+currentDay=1, pause, resume)
 *   - Stats: retorna ultimos N WarmupDailyStats
 *
 * Cada teste cria seu proprio estado via helpers — setup.ts trunca tudo
 * (incluindo tabelas warmup_*) no beforeEach.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';

import { prismaTest } from '../test/setup';
import { createTestAccount, authHeader } from '../test/helpers';
import { createTestApp } from '../test/app';

const app = createTestApp();

/**
 * Helper: cria um user agent (role='agent') na mesma account e retorna JWT.
 * Usado para testar que agent recebe 403 nas rotas warmup (admin only).
 */
async function createAgentJwt(accountId: string): Promise<string> {
  const passwordHash = await bcrypt.hash('Test@1234', 4);
  const user = await prismaTest.user.create({
    data: {
      accountId,
      nome: 'Agent Teste',
      email: `agent-${randomUUID().slice(0, 8)}@test.com`,
      passwordHash,
      role: 'agent',
      status: 'active',
      permissions: ['dashboard'],
    },
  });
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: 'agent',
      accountId,
      permissions: ['dashboard'],
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' }
  );
}

/**
 * Helper: cria um pool diretamente no DB e retorna o registro.
 */
async function createPool(
  accountId: string,
  overrides?: { name?: string; strategy?: string; isPublic?: boolean }
) {
  return prismaTest.warmupPool.create({
    data: {
      accountId,
      name: overrides?.name ?? `Pool ${randomUUID().slice(0, 6)}`,
      strategy: overrides?.strategy ?? 'moderate',
      isPublic: overrides?.isPublic ?? false,
    },
  });
}

/**
 * Helper: cria um WarmupNumber direto no DB.
 */
async function createNumber(
  poolId: string,
  accountId: string,
  overrides?: { phoneE164?: string; status?: string }
) {
  return prismaTest.warmupNumber.create({
    data: {
      poolId,
      accountId,
      evolutionInstance: 'test-instance',
      phoneE164: overrides?.phoneE164 ?? `+55${Math.floor(1e10 + Math.random() * 9e10)}`,
      status: overrides?.status ?? 'cold',
    },
  });
}

describe('WarmupController — Pools', () => {
  // ─── Auth & RBAC ──────────────────────────────────────────────────────────

  describe('POST /api/warmup/pools — auth', () => {
    it('sem JWT: 401', async () => {
      const res = await request(app)
        .post('/api/warmup/pools')
        .send({ name: 'P1' });
      expect(res.status).toBe(401);
    });

    it('com JWT de agent (sem admin role): 403', async () => {
      const { account } = await createTestAccount();
      const agentJwt = await createAgentJwt(account.id);

      const res = await request(app)
        .post('/api/warmup/pools')
        .set(authHeader(agentJwt))
        .send({ name: 'P1' });

      expect(res.status).toBe(403);
    });

    it('com admin: 201 + retorna pool com strategy default moderate', async () => {
      const { jwt } = await createTestAccount();

      const res = await request(app)
        .post('/api/warmup/pools')
        .set(authHeader(jwt))
        .send({ name: 'Pool Aquecimento' });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        name: 'Pool Aquecimento',
        strategy: 'moderate',
        isPublic: false,
        isActive: true,
      });
      expect(res.body.data.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('com admin + strategy aggressive: 201 mantem strategy', async () => {
      const { jwt } = await createTestAccount();

      const res = await request(app)
        .post('/api/warmup/pools')
        .set(authHeader(jwt))
        .send({ name: 'P agressivo', strategy: 'aggressive' });

      expect(res.status).toBe(201);
      expect(res.body.data.strategy).toBe('aggressive');
    });

    it('name vazio: 400', async () => {
      const { jwt } = await createTestAccount();

      const res = await request(app)
        .post('/api/warmup/pools')
        .set(authHeader(jwt))
        .send({ name: '' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/warmup/pools', () => {
    it('lista apenas pools da accountId (nao vaza de outra account)', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });

      await createPool(accA.account.id, { name: 'A1' });
      await createPool(accA.account.id, { name: 'A2' });
      await createPool(accB.account.id, { name: 'B1' });

      const res = await request(app)
        .get('/api/warmup/pools')
        .set(authHeader(accA.jwt));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      const names = res.body.data.map((p: { name: string }) => p.name).sort();
      expect(names).toEqual(['A1', 'A2']);
    });
  });

  describe('PATCH /api/warmup/pools/:id', () => {
    it('cross-tenant: 404 (pool de outra account)', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });
      const poolB = await createPool(accB.account.id);

      const res = await request(app)
        .patch(`/api/warmup/pools/${poolB.id}`)
        .set(authHeader(accA.jwt))
        .send({ name: 'hacked' });

      expect(res.status).toBe(404);
    });

    it('admin proprio: 200 + altera name', async () => {
      const { account, jwt } = await createTestAccount();
      const pool = await createPool(account.id, { name: 'Old' });

      const res = await request(app)
        .patch(`/api/warmup/pools/${pool.id}`)
        .set(authHeader(jwt))
        .send({ name: 'New Name', isActive: false });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('New Name');
      expect(res.body.data.isActive).toBe(false);
    });
  });

  describe('DELETE /api/warmup/pools/:id', () => {
    it('cross-tenant: 404', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });
      const poolB = await createPool(accB.account.id);

      const res = await request(app)
        .delete(`/api/warmup/pools/${poolB.id}`)
        .set(authHeader(accA.jwt));

      expect(res.status).toBe(404);

      // pool ainda existe
      const stillThere = await prismaTest.warmupPool.findUnique({
        where: { id: poolB.id },
      });
      expect(stillThere).toBeTruthy();
    });

    it('admin proprio: 204 + cascade nos numbers', async () => {
      const { account, jwt } = await createTestAccount();
      const pool = await createPool(account.id);
      const num = await createNumber(pool.id, account.id);

      const res = await request(app)
        .delete(`/api/warmup/pools/${pool.id}`)
        .set(authHeader(jwt));

      expect(res.status).toBe(204);

      const poolGone = await prismaTest.warmupPool.findUnique({
        where: { id: pool.id },
      });
      expect(poolGone).toBeNull();

      const numberGone = await prismaTest.warmupNumber.findUnique({
        where: { id: num.id },
      });
      expect(numberGone).toBeNull();
    });
  });
});

describe('WarmupController — Numbers', () => {
  describe('POST /api/warmup/numbers — validacao', () => {
    it('sem poolId valido (UUID malformado): 400', async () => {
      const { jwt } = await createTestAccount();

      const res = await request(app)
        .post('/api/warmup/numbers')
        .set(authHeader(jwt))
        .send({
          poolId: 'not-a-uuid',
          evolutionInstance: 'inst1',
          phoneE164: '+5534993383017',
        });

      expect(res.status).toBe(400);
    });

    it('com poolId valido mas inexistente: 404', async () => {
      const { jwt } = await createTestAccount();

      const res = await request(app)
        .post('/api/warmup/numbers')
        .set(authHeader(jwt))
        .send({
          poolId: '11111111-1111-1111-1111-111111111111',
          evolutionInstance: 'inst1',
          phoneE164: '+5534993383017',
        });

      expect(res.status).toBe(404);
    });

    it('com phoneE164 invalido (sem digitos): 400', async () => {
      const { account, jwt } = await createTestAccount();
      const pool = await createPool(account.id);

      const res = await request(app)
        .post('/api/warmup/numbers')
        .set(authHeader(jwt))
        .send({
          poolId: pool.id,
          evolutionInstance: 'inst1',
          phoneE164: 'abc',
        });

      expect(res.status).toBe(400);
    });

    it('com phoneE164 valido: 201 + status cold', async () => {
      const { account, jwt } = await createTestAccount();
      const pool = await createPool(account.id);

      const res = await request(app)
        .post('/api/warmup/numbers')
        .set(authHeader(jwt))
        .send({
          poolId: pool.id,
          evolutionInstance: 'inst1',
          phoneE164: '+5534993383017',
          displayName: 'Teste',
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        poolId: pool.id,
        status: 'cold',
        currentDay: 0,
        qualityScore: 100,
        displayName: 'Teste',
        phoneE164: '+5534993383017',
      });
    });

    it('duplicado (mesmo phone + mesma account): 409 unique', async () => {
      const { account, jwt } = await createTestAccount();
      const pool = await createPool(account.id);

      const body = {
        poolId: pool.id,
        evolutionInstance: 'inst1',
        phoneE164: '+5534993383017',
      };

      const r1 = await request(app)
        .post('/api/warmup/numbers')
        .set(authHeader(jwt))
        .send(body);
      expect(r1.status).toBe(201);

      const r2 = await request(app)
        .post('/api/warmup/numbers')
        .set(authHeader(jwt))
        .send(body);
      expect(r2.status).toBe(409);
    });
  });

  describe('POST /api/warmup/numbers/:id/start', () => {
    it('status=warming + currentDay=1 + dailyEnvioPlan gerado', async () => {
      const { account, jwt } = await createTestAccount();
      const pool = await createPool(account.id, { strategy: 'moderate' });
      const num = await createNumber(pool.id, account.id);

      const res = await request(app)
        .post(`/api/warmup/numbers/${num.id}/start`)
        .set(authHeader(jwt));

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('warming');
      expect(res.body.data.currentDay).toBe(1);
      expect(res.body.data.startedAt).toBeTruthy();
      expect(Array.isArray(res.body.data.dailyEnvioPlan)).toBe(true);
      // Moderate D1 = 10
      expect(res.body.data.dailyEnvioPlan[0]).toBe(10);
      // D7 = 40
      expect(res.body.data.dailyEnvioPlan[6]).toBe(40);
    });

    it('cross-tenant: 404', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });
      const poolB = await createPool(accB.account.id);
      const numB = await createNumber(poolB.id, accB.account.id);

      const res = await request(app)
        .post(`/api/warmup/numbers/${numB.id}/start`)
        .set(authHeader(accA.jwt));

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/warmup/numbers/:id/pause', () => {
    it('status=paused + persiste reason', async () => {
      const { account, jwt } = await createTestAccount();
      const pool = await createPool(account.id);
      const num = await createNumber(pool.id, account.id, { status: 'warming' });

      const res = await request(app)
        .post(`/api/warmup/numbers/${num.id}/pause`)
        .set(authHeader(jwt))
        .send({ reason: 'manutencao chip' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('paused');
      expect(res.body.data.pausedReason).toBe('manutencao chip');
    });
  });

  describe('POST /api/warmup/numbers/:id/resume', () => {
    it('status=warming + limpa pausedReason', async () => {
      const { account, jwt } = await createTestAccount();
      const pool = await createPool(account.id);
      // Cria number ja paused
      const num = await prismaTest.warmupNumber.create({
        data: {
          poolId: pool.id,
          accountId: account.id,
          evolutionInstance: 'inst1',
          phoneE164: '+5534993383018',
          status: 'paused',
          pausedReason: 'manual',
        },
      });

      const res = await request(app)
        .post(`/api/warmup/numbers/${num.id}/resume`)
        .set(authHeader(jwt));

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('warming');

      const persisted = await prismaTest.warmupNumber.findUnique({
        where: { id: num.id },
      });
      expect(persisted?.pausedReason).toBeNull();
    });
  });

  describe('GET /api/warmup/numbers/:id/stats', () => {
    it('retorna array de WarmupDailyStats (ate 30 dias)', async () => {
      const { account, jwt } = await createTestAccount();
      const pool = await createPool(account.id);
      const num = await createNumber(pool.id, account.id);

      // Cria 3 dias de stats
      for (let i = 0; i < 3; i++) {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCDate(d.getUTCDate() - i);
        await prismaTest.warmupDailyStats.create({
          data: {
            numberId: num.id,
            date: d,
            protocolDay: i + 1,
            plannedSends: 10,
            actualSends: 8,
            actualReceives: 6,
            failedSends: 0,
            qualityEnd: 100,
            statusEnd: 'warming',
          },
        });
      }

      const res = await request(app)
        .get(`/api/warmup/numbers/${num.id}/stats`)
        .set(authHeader(jwt));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(3);
      expect(res.body.data[0]).toMatchObject({
        numberId: num.id,
        plannedSends: 10,
        actualSends: 8,
      });
    });

    it('cross-tenant: 404', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });
      const poolB = await createPool(accB.account.id);
      const numB = await createNumber(poolB.id, accB.account.id);

      const res = await request(app)
        .get(`/api/warmup/numbers/${numB.id}/stats`)
        .set(authHeader(accA.jwt));

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/warmup/numbers/:id', () => {
    it('admin proprio: 204', async () => {
      const { account, jwt } = await createTestAccount();
      const pool = await createPool(account.id);
      const num = await createNumber(pool.id, account.id);

      const res = await request(app)
        .delete(`/api/warmup/numbers/${num.id}`)
        .set(authHeader(jwt));

      expect(res.status).toBe(204);

      const gone = await prismaTest.warmupNumber.findUnique({
        where: { id: num.id },
      });
      expect(gone).toBeNull();
    });
  });
});
