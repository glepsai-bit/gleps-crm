/**
 * Integration tests for integration-kanban.controller.ts
 *
 * Cobre todos os caminhos HTTP do endpoint /api/integrations/kanban:
 *  - GET /stages (auth, scopes, payload)
 *  - POST /leads/:leadId/stage (auth, scopes, validação, resolver por id/name,
 *    cross-tenant, idempotência, reason)
 *
 * Estilo: cada teste cria seu proprio estado via helpers (account, api key,
 * funnel + stages, contact). beforeEach do setup.ts limpa o DB.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prismaTest } from '../test/setup';
import {
  createTestAccount,
  createTestApiKey,
  createTestFunnelWithStages,
  createTestContact,
  apiKeyHeader,
} from '../test/helpers';
import { createTestApp } from '../test/app';

const app = createTestApp();

describe('IntegrationKanbanController', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // GET /stages
  // ───────────────────────────────────────────────────────────────────────────

  describe('GET /api/integrations/kanban/stages', () => {
    it('sem api-key: 401', async () => {
      const res = await request(app).get('/api/integrations/kanban/stages');
      expect(res.status).toBe(401);
    });

    it('com api-key inválida (random): 401', async () => {
      const res = await request(app)
        .get('/api/integrations/kanban/stages')
        .set(apiKeyHeader('glk_random_invalid_key_value'));
      expect(res.status).toBe(401);
    });

    it('com scope insuficiente (contacts:read): 403', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['contacts:read']);

      const res = await request(app)
        .get('/api/integrations/kanban/stages')
        .set(apiKeyHeader(plaintextKey));

      // contacts:read NÃO está na whitelist de stages — espera 403
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('API_KEY_SCOPE_DENIED');
    });

    it('com scope kanban:read: 200, retorna stages do funil default', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:read']);
      const { funnel, tags } = await createTestFunnelWithStages(account.id, [
        'Novo',
        'Em Contato',
        'Fechado',
      ]);

      const res = await request(app)
        .get('/api/integrations/kanban/stages')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(3);
      expect(res.body.funnel.id).toBe(funnel.id);
      // Stages ordenadas por ordem ASC (helper cria com ordem sequencial)
      const ids = res.body.data.map((s: any) => s.id);
      expect(ids).toEqual(tags.map((t) => t.id));
      // Shape do item
      expect(res.body.data[0]).toMatchObject({
        id: tags[0].id,
        name: 'Novo',
        kind: 'stage',
      });
    });

    it('com scope leads:read (alias semantico): 200', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['leads:read']);
      await createTestFunnelWithStages(account.id, ['Novo']);

      const res = await request(app)
        .get('/api/integrations/kanban/stages')
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // POST /leads/:leadId/stage
  // ───────────────────────────────────────────────────────────────────────────

  describe('POST /api/integrations/kanban/leads/:leadId/stage', () => {
    const validLeadId = '11111111-1111-1111-1111-111111111111';

    it('sem api-key: 401', async () => {
      const res = await request(app)
        .post(`/api/integrations/kanban/leads/${validLeadId}/stage`)
        .send({ stageName: 'X' });
      expect(res.status).toBe(401);
    });

    it('com scope insuficiente (kanban:read): 403', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:read']);

      const res = await request(app)
        .post(`/api/integrations/kanban/leads/${validLeadId}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({ stageName: 'X' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('API_KEY_SCOPE_DENIED');
    });

    it('leadId UUID invalido: 400', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:write']);

      const res = await request(app)
        .post('/api/integrations/kanban/leads/not-a-uuid/stage')
        .set(apiKeyHeader(plaintextKey))
        .send({ stageName: 'Novo' });

      expect(res.status).toBe(400);
    });

    it('body vazio (sem stageId nem stageName): 400', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:write']);

      const res = await request(app)
        .post(`/api/integrations/kanban/leads/${validLeadId}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({});

      expect(res.status).toBe(400);
    });

    it('stageId + stageName ambos: 400 (mutex)', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:write']);
      const { tags } = await createTestFunnelWithStages(account.id, ['Novo']);

      const res = await request(app)
        .post(`/api/integrations/kanban/leads/${validLeadId}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({ stageId: tags[0].id, stageName: 'Novo' });

      expect(res.status).toBe(400);
    });

    it('lead inexistente (UUID valido mas sem registro): 404', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:write']);
      const { tags } = await createTestFunnelWithStages(account.id, ['Novo']);

      const res = await request(app)
        .post(`/api/integrations/kanban/leads/${validLeadId}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({ stageId: tags[0].id });

      expect(res.status).toBe(404);
    });

    it('move OK com stageId: 200, transition.from null + to = nova stage', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey, id: apiKeyId } = await createTestApiKey(account.id, [
        'kanban:write',
      ]);
      const { tags } = await createTestFunnelWithStages(account.id, ['Novo', 'Em Contato']);
      const contact = await createTestContact(account.id);

      const res = await request(app)
        .post(`/api/integrations/kanban/leads/${contact.id}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({ stageId: tags[0].id });

      expect(res.status).toBe(200);
      expect(res.body.lead.id).toBe(contact.id);
      expect(res.body.lead.stageId).toBe(tags[0].id);
      expect(res.body.transition.from).toBeNull();
      expect(res.body.transition.to.id).toBe(tags[0].id);
      expect(res.body.transition.noop).toBe(false);

      // Audit: TagHistory criado com actorType=external + actorId=apiKeyId
      const history = await prismaTest.tagHistory.findFirst({
        where: { contactId: contact.id, action: 'added' },
      });
      expect(history).toBeTruthy();
      expect(history!.actorType).toBe('external');
      expect(history!.actorId).toBe(apiKeyId);
    });

    it('stageName case-insensitive: ok', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:write']);
      const { tags } = await createTestFunnelWithStages(account.id, ['Aluno Ativo']);
      const contact = await createTestContact(account.id);

      const res = await request(app)
        .post(`/api/integrations/kanban/leads/${contact.id}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({ stageName: 'aluno ativo' });

      expect(res.status).toBe(200);
      expect(res.body.lead.stageId).toBe(tags[0].id);
    });

    it('stageName com padding + whitespace interno multiplo ("  Aluno  Ativo  "): ok', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:write']);
      const { tags } = await createTestFunnelWithStages(account.id, ['Aluno Ativo']);
      const contact = await createTestContact(account.id);

      const res = await request(app)
        .post(`/api/integrations/kanban/leads/${contact.id}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({ stageName: '  Aluno  Ativo  ' });

      expect(res.status).toBe(200);
      expect(res.body.lead.stageId).toBe(tags[0].id);
    });

    it('stageName que nao existe: 404', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:write']);
      await createTestFunnelWithStages(account.id, ['Novo']);
      const contact = await createTestContact(account.id);

      const res = await request(app)
        .post(`/api/integrations/kanban/leads/${contact.id}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({ stageName: 'NaoExiste' });

      expect(res.status).toBe(404);
    });

    it('cross-tenant: leadId pertence a OUTRA account -> 404', async () => {
      const accA = await createTestAccount({ accountName: 'Acc A' });
      const accB = await createTestAccount({ accountName: 'Acc B' });
      const { plaintextKey } = await createTestApiKey(accA.account.id, ['kanban:write']);
      const { tags: tagsA } = await createTestFunnelWithStages(accA.account.id, ['Novo']);
      // Contact pertence à Account B (não à A, dona da api key)
      const contactB = await createTestContact(accB.account.id);

      const res = await request(app)
        .post(`/api/integrations/kanban/leads/${contactB.id}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({ stageId: tagsA[0].id });

      expect(res.status).toBe(404);
    });

    it('idempotente: mover para a MESMA stage atual -> 200, noop:true, sem nova entrada TagHistory.added', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:write']);
      const { tags } = await createTestFunnelWithStages(account.id, ['Novo']);
      const contact = await createTestContact(account.id);

      // Primeira aplicação
      const r1 = await request(app)
        .post(`/api/integrations/kanban/leads/${contact.id}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({ stageId: tags[0].id });
      expect(r1.status).toBe(200);
      expect(r1.body.transition.noop).toBe(false);

      // Segunda aplicação no mesmo stage -> noop
      const r2 = await request(app)
        .post(`/api/integrations/kanban/leads/${contact.id}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({ stageId: tags[0].id });
      expect(r2.status).toBe(200);
      expect(r2.body.transition.noop).toBe(true);

      const added = await prismaTest.tagHistory.findMany({
        where: { contactId: contact.id, action: 'added' },
      });
      // Apenas 1 — a segunda chamada nao deve gerar novo audit
      expect(added.length).toBe(1);
    });

    it('com reason: persistido no TagHistory.reason', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:write']);
      const { tags } = await createTestFunnelWithStages(account.id, ['Novo']);
      const contact = await createTestContact(account.id);
      const reason = 'Migrado via n8n workflow id=abc123';

      const res = await request(app)
        .post(`/api/integrations/kanban/leads/${contact.id}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({ stageId: tags[0].id, reason });

      expect(res.status).toBe(200);
      expect(res.body.transition.reason).toBe(reason);

      const history = await prismaTest.tagHistory.findFirst({
        where: { contactId: contact.id, action: 'added' },
      });
      expect(history?.reason).toBe(reason);
    });

    it('com scope leads:write (alias semantico): 200', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['leads:write']);
      const { tags } = await createTestFunnelWithStages(account.id, ['Novo']);
      const contact = await createTestContact(account.id);

      const res = await request(app)
        .post(`/api/integrations/kanban/leads/${contact.id}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({ stageId: tags[0].id });

      expect(res.status).toBe(200);
    });

    it('aplicar tag operational pelo endpoint: 400 (apenas stage tags aceitas)', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:write']);
      // Cria stage para o funnel, mas vamos usar uma operational tag direta no banco
      const { funnel } = await createTestFunnelWithStages(account.id, ['Novo']);
      const operational = await prismaTest.tag.create({
        data: {
          accountId: account.id,
          funnelId: funnel.id,
          name: 'Quente',
          slug: 'quente',
          type: 'operational',
          ordem: 0,
        },
      });
      const contact = await createTestContact(account.id);

      const res = await request(app)
        .post(`/api/integrations/kanban/leads/${contact.id}/stage`)
        .set(apiKeyHeader(plaintextKey))
        .send({ stageId: operational.id });

      expect(res.status).toBe(400);
    });
  });
});
