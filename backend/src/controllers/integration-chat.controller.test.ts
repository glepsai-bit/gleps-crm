/**
 * Integration tests for integration-chat.controller.ts
 *
 * Cobre os 11 endpoints de /api/integrations/chat/* — auth, scopes,
 * cross-tenant, body validation, happy path, e regras de negócio
 * (senderType default ai_bot, ai_handled custom attr, transfer cria nota,
 * resolve email→userId, etc.).
 *
 * Pattern: cada teste cria seu estado isolado via helpers; o beforeEach
 * do setup.ts faz TRUNCATE CASCADE de todas as tabelas relevantes.
 *
 * Mock: evolutionService.sendText é mockado para NUNCA disparar WhatsApp
 * real (regra: só 5534993383017 é permitido em integração real, e mesmo
 * assim só fora de tests). Os testes apenas validam que a Message foi
 * persistida e o status final é coerente.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

// Mock evolution antes de importar a app (que importa controllers que
// importam evolutionService).
vi.mock('../services/evolution.service', () => ({
  evolutionService: {
    sendText: vi.fn(async () => ({ messageId: 'evo-test-msg' })),
    sendMedia: vi.fn(async () => ({ messageId: 'evo-test-media' })),
    sendAudio: vi.fn(async () => ({ messageId: 'evo-test-audio' })),
  },
}));

import { prismaTest } from '../test/setup';
import {
  createTestAccount,
  createTestApiKey,
  apiKeyHeader,
} from '../test/helpers';
import { createTestApp } from '../test/app';

const app = createTestApp();

// ─── Local helpers ────────────────────────────────────────────────────────

async function createInboxAndConversation(
  accountId: string,
  options?: { telefone?: string; status?: string }
) {
  const inbox = await prismaTest.inbox.create({
    data: {
      accountId,
      name: 'Inbox QA',
      channelType: 'whatsapp',
      evolutionInstance: `inst-${randomUUID().slice(0, 8)}`,
    },
  });
  const contact = await prismaTest.contact.create({
    data: {
      accountId,
      nome: 'Contato Chat',
      telefone: options?.telefone ?? `5534${Math.floor(Math.random() * 1e8)}`,
    },
  });
  const conversation = await prismaTest.conversation.create({
    data: {
      accountId,
      inboxId: inbox.id,
      contactId: contact.id,
      status: (options?.status as any) ?? 'open',
    },
  });
  return { inbox, contact, conversation };
}

async function createTeam(accountId: string, name: string) {
  return prismaTest.team.create({
    data: { accountId, name },
  });
}

async function createAgent(accountId: string, email?: string) {
  return prismaTest.user.create({
    data: {
      accountId,
      nome: 'Agente Teste',
      email: (email ?? `agent-${randomUUID().slice(0, 8)}@t.com`).toLowerCase(),
      passwordHash: 'x',
      role: 'agent',
      status: 'active',
      permissions: [],
    },
  });
}

const FAKE_UUID = '11111111-1111-1111-1111-111111111111';

// ─── Tests ────────────────────────────────────────────────────────────────

describe('IntegrationChatController', () => {
  // ============================================
  // GET /conversations/:id
  // ============================================
  describe('GET /api/integrations/chat/conversations/:id', () => {
    it('sem api-key: 401', async () => {
      const res = await request(app).get(
        `/api/integrations/chat/conversations/${FAKE_UUID}`
      );
      expect(res.status).toBe(401);
    });

    it('com scope insuficiente (kanban:read): 403', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['kanban:read']);

      const res = await request(app)
        .get(`/api/integrations/chat/conversations/${FAKE_UUID}`)
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('API_KEY_SCOPE_DENIED');
    });

    it('UUID inválido: 400', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:read']);

      const res = await request(app)
        .get(`/api/integrations/chat/conversations/not-a-uuid`)
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(400);
    });

    it('conversa inexistente: 404', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:read']);

      const res = await request(app)
        .get(`/api/integrations/chat/conversations/${FAKE_UUID}`)
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(404);
    });

    it('cross-tenant: conversa de outra account → 404', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });
      const { plaintextKey } = await createTestApiKey(accA.account.id, ['chat:read']);
      const { conversation } = await createInboxAndConversation(accB.account.id);

      const res = await request(app)
        .get(`/api/integrations/chat/conversations/${conversation.id}`)
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(404);
    });

    it('com scope chat:read: 200, retorna conversation + contact + messages', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:read']);
      const { conversation, contact } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .get(`/api/integrations/chat/conversations/${conversation.id}`)
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(conversation.id);
      expect(res.body.data.contact.id).toBe(contact.id);
      expect(Array.isArray(res.body.data.messages)).toBe(true);
      expect(res.body.data.customAttributes).toBeDefined();
    });
  });

  // ============================================
  // POST /conversations/:id/messages
  // ============================================
  describe('POST /conversations/:id/messages', () => {
    it('sem api-key: 401', async () => {
      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${FAKE_UUID}/messages`)
        .send({ content: 'oi' });
      expect(res.status).toBe(401);
    });

    it('com scope chat:read: 403', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:read']);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${FAKE_UUID}/messages`)
        .set(apiKeyHeader(plaintextKey))
        .send({ content: 'oi' });

      expect(res.status).toBe(403);
    });

    it('body sem content: 400', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/messages`)
        .set(apiKeyHeader(plaintextKey))
        .send({});

      expect(res.status).toBe(400);
    });

    it('happy path: 201 + senderType default ai_bot persistido no DB', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/messages`)
        .set(apiKeyHeader(plaintextKey))
        .send({ content: 'Resposta automática da IA' });

      expect(res.status).toBe(201);
      expect(res.body.data.senderType).toBe('ai_bot');

      const persisted = await prismaTest.message.findFirst({
        where: { conversationId: conversation.id },
      });
      expect(persisted?.senderType).toBe('ai_bot');
      expect(persisted?.content).toBe('Resposta automática da IA');
    });

    it('senderType override (integration): respeitado', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/messages`)
        .set(apiKeyHeader(plaintextKey))
        .send({ content: 'oi', senderType: 'integration' });

      expect(res.status).toBe(201);
      expect(res.body.data.senderType).toBe('integration');
    });

    it('ai_handled é setado em custom_attributes após envio ai_bot', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/messages`)
        .set(apiKeyHeader(plaintextKey))
        .send({ content: 'mensagem da IA' });

      const reloaded = await prismaTest.conversation.findUnique({
        where: { id: conversation.id },
      });
      const attrs = (reloaded?.customAttributes ?? {}) as Record<string, unknown>;
      expect(attrs.ai_handled).toBe(true);
    });

    it('cross-tenant: conversa de outra account → 404', async () => {
      const accA = await createTestAccount({ accountName: 'A' });
      const accB = await createTestAccount({ accountName: 'B' });
      const { plaintextKey } = await createTestApiKey(accA.account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(accB.account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/messages`)
        .set(apiKeyHeader(plaintextKey))
        .send({ content: 'oi' });

      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // POST /conversations/:id/notes
  // ============================================
  describe('POST /conversations/:id/notes', () => {
    it('sem api-key: 401', async () => {
      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${FAKE_UUID}/notes`)
        .send({ content: 'nota' });
      expect(res.status).toBe(401);
    });

    it('com scope insuficiente (chat:read): 403', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:read']);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${FAKE_UUID}/notes`)
        .set(apiKeyHeader(plaintextKey))
        .send({ content: 'nota' });

      expect(res.status).toBe(403);
    });

    it('happy path: nota interna criada com isPrivate=true e senderType=system', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/notes`)
        .set(apiKeyHeader(plaintextKey))
        .send({ content: 'IA classificou: leadqualificado' });

      expect(res.status).toBe(201);
      expect(res.body.data.isPrivate).toBe(true);
      expect(res.body.data.senderType).toBe('system');

      const persisted = await prismaTest.message.findFirst({
        where: { conversationId: conversation.id },
      });
      expect(persisted?.isPrivate).toBe(true);
      expect(persisted?.senderType).toBe('system');
    });
  });

  // ============================================
  // POST /conversations/:id/assign
  // ============================================
  describe('POST /conversations/:id/assign', () => {
    it('com userId UUID: 200 e conversation.assigneeId atualizado', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);
      const agent = await createAgent(account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/assign`)
        .set(apiKeyHeader(plaintextKey))
        .send({ userId: agent.id });

      expect(res.status).toBe(200);
      expect(res.body.data.assigneeId).toBe(agent.id);
    });

    it('com userEmail: resolve para o usuário correto', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);
      const email = `byemail-${randomUUID().slice(0, 8)}@t.com`;
      const agent = await createAgent(account.id, email);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/assign`)
        .set(apiKeyHeader(plaintextKey))
        .send({ userEmail: email });

      expect(res.status).toBe(200);
      expect(res.body.data.assigneeId).toBe(agent.id);
    });

    it('userEmail inexistente: 404', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/assign`)
        .set(apiKeyHeader(plaintextKey))
        .send({ userEmail: 'naoexiste@t.com' });

      expect(res.status).toBe(404);
    });

    it('body sem userId nem userEmail: 400', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/assign`)
        .set(apiKeyHeader(plaintextKey))
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // POST /conversations/:id/assign-team
  // ============================================
  describe('POST /conversations/:id/assign-team', () => {
    it('com teamId: 200 e teamId atualizado', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);
      const team = await createTeam(account.id, 'Suporte');

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/assign-team`)
        .set(apiKeyHeader(plaintextKey))
        .send({ teamId: team.id });

      expect(res.status).toBe(200);
      expect(res.body.data.teamId).toBe(team.id);
    });

    it('com teamSlug (busca por nome case-insensitive): 200', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);
      const team = await createTeam(account.id, 'Vendas');

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/assign-team`)
        .set(apiKeyHeader(plaintextKey))
        .send({ teamSlug: 'vendas' });

      expect(res.status).toBe(200);
      expect(res.body.data.teamId).toBe(team.id);
    });

    it('teamSlug inexistente: 404', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/assign-team`)
        .set(apiKeyHeader(plaintextKey))
        .send({ teamSlug: 'time-inexistente' });

      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // POST /conversations/:id/transfer
  // ============================================
  describe('POST /conversations/:id/transfer', () => {
    it('toUserId: cria nota interna automática + faz assign', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);
      const agent = await createAgent(account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/transfer`)
        .set(apiKeyHeader(plaintextKey))
        .send({ toUserId: agent.id, reason: 'IA escalou pra humano' });

      expect(res.status).toBe(200);
      expect(res.body.data.assigneeId).toBe(agent.id);

      // Nota privada criada
      const notes = await prismaTest.message.findMany({
        where: { conversationId: conversation.id, isPrivate: true },
      });
      expect(notes.length).toBeGreaterThanOrEqual(1);
      const noteContent = notes[0].content ?? '';
      expect(noteContent).toMatch(/IA escalou pra humano/);
    });

    it('toTeamId: faz assignToTeam', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);
      const team = await createTeam(account.id, 'Financeiro');

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/transfer`)
        .set(apiKeyHeader(plaintextKey))
        .send({ toTeamId: team.id, reason: 'Cliente quer falar de cobrança' });

      expect(res.status).toBe(200);
      expect(res.body.data.teamId).toBe(team.id);
    });

    it('toUserId E toTeamId juntos: 400 (mutex)', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);
      const team = await createTeam(account.id, 'X');

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/transfer`)
        .set(apiKeyHeader(plaintextKey))
        .send({ toUserId: FAKE_UUID, toTeamId: team.id });

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // POST /conversations/:id/resolve
  // ============================================
  describe('POST /conversations/:id/resolve', () => {
    it('happy path (resolvedBy default ai): status=resolved + ai_handled=true', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/resolve`)
        .set(apiKeyHeader(plaintextKey))
        // SLA v2: outcome agora eh obrigatorio
        .send({ outcome: 'resolved' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('resolved');
      expect(res.body.data.resolvedBy).toBe('ai');

      const reloaded = await prismaTest.conversation.findUnique({
        where: { id: conversation.id },
      });
      const attrs = (reloaded?.customAttributes ?? {}) as Record<string, unknown>;
      expect(attrs.ai_handled).toBe(true);
    });

    it('com reason: grava nota interna do motivo', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/resolve`)
        .set(apiKeyHeader(plaintextKey))
        .send({ outcome: 'resolved', reason: 'Cliente confirmou o boleto pago' });

      expect(res.status).toBe(200);

      const notes = await prismaTest.message.findMany({
        where: { conversationId: conversation.id, isPrivate: true },
      });
      const hasReasonNote = notes.some((n) =>
        (n.content ?? '').includes('boleto pago')
      );
      expect(hasReasonNote).toBe(true);
    });
  });

  // ============================================
  // POST /conversations/:id/reopen
  // ============================================
  describe('POST /conversations/:id/reopen', () => {
    it('happy path: resolved → open', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id, {
        status: 'resolved',
      });
      // Garante que resolvedAt está setado (reopen limpa)
      await prismaTest.conversation.update({
        where: { id: conversation.id },
        data: { resolvedAt: new Date(), resolvedBy: 'human' },
      });

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/reopen`)
        .set(apiKeyHeader(plaintextKey))
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('open');
      expect(res.body.data.resolvedAt).toBeNull();
    });
  });

  // ============================================
  // PATCH /conversations/:id/custom-attributes
  // ============================================
  describe('PATCH /conversations/:id/custom-attributes', () => {
    it('aceita { attrs }: merge profundo', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .patch(
          `/api/integrations/chat/conversations/${conversation.id}/custom-attributes`
        )
        .set(apiKeyHeader(plaintextKey))
        .send({ attrs: { plano: 'gold', cidade: 'Uberlândia' } });

      expect(res.status).toBe(200);
      expect(res.body.data.customAttributes.plano).toBe('gold');
      expect(res.body.data.customAttributes.cidade).toBe('Uberlândia');
    });

    it('aceita { customAttributes } (shape camelCase também): 200', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .patch(
          `/api/integrations/chat/conversations/${conversation.id}/custom-attributes`
        )
        .set(apiKeyHeader(plaintextKey))
        .send({ customAttributes: { foo: 'bar' } });

      expect(res.status).toBe(200);
      expect(res.body.data.customAttributes.foo).toBe('bar');
    });

    it('body vazio: 400', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .patch(
          `/api/integrations/chat/conversations/${conversation.id}/custom-attributes`
        )
        .set(apiKeyHeader(plaintextKey))
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // PATCH /conversations/:id/priority
  // ============================================
  describe('PATCH /conversations/:id/priority', () => {
    it('priority válido (urgent): 200', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .patch(`/api/integrations/chat/conversations/${conversation.id}/priority`)
        .set(apiKeyHeader(plaintextKey))
        .send({ priority: 'urgent' });

      expect(res.status).toBe(200);
      expect(res.body.data.priority).toBe('urgent');
    });

    it('priority inválido (foo): 400', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .patch(`/api/integrations/chat/conversations/${conversation.id}/priority`)
        .set(apiKeyHeader(plaintextKey))
        .send({ priority: 'foo' });

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // POST /conversations/:id/labels
  // ============================================
  describe('POST /conversations/:id/labels', () => {
    it('com label (string): cria tag on-the-fly e associa', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);
      // Funil é exigido pelo resolveOrCreateTagByLabel
      await prismaTest.funnel.create({
        data: { accountId: account.id, name: 'F', slug: 'f', isDefault: true },
      });

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/labels`)
        .set(apiKeyHeader(plaintextKey))
        .send({ label: 'aguardando-pagamento' });

      expect(res.status).toBe(200);
      const tag = await prismaTest.tag.findFirst({
        where: { accountId: account.id, slug: 'aguardando-pagamento' },
      });
      expect(tag).toBeTruthy();
    });

    it('com tagId UUID válido: associa', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);
      const funnel = await prismaTest.funnel.create({
        data: { accountId: account.id, name: 'F', slug: 'f', isDefault: true },
      });
      const tag = await prismaTest.tag.create({
        data: {
          accountId: account.id,
          funnelId: funnel.id,
          name: 'Quente',
          slug: 'quente',
          type: 'operational',
          ordem: 0,
        },
      });

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/labels`)
        .set(apiKeyHeader(plaintextKey))
        .send({ tagId: tag.id });

      expect(res.status).toBe(200);
      const link = await prismaTest.conversationLabel.findFirst({
        where: { conversationId: conversation.id, tagId: tag.id },
      });
      expect(link).toBeTruthy();
    });
  });

  // ============================================
  // DELETE /conversations/:id/labels/:labelId
  // ============================================
  describe('DELETE /conversations/:id/labels/:labelId', () => {
    it('remove label associada: 200 { ok: true }', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);
      const funnel = await prismaTest.funnel.create({
        data: { accountId: account.id, name: 'F', slug: 'f', isDefault: true },
      });
      const tag = await prismaTest.tag.create({
        data: {
          accountId: account.id,
          funnelId: funnel.id,
          name: 'X',
          slug: 'x',
          type: 'operational',
          ordem: 0,
        },
      });
      await prismaTest.conversationLabel.create({
        data: { conversationId: conversation.id, tagId: tag.id },
      });

      const res = await request(app)
        .delete(
          `/api/integrations/chat/conversations/${conversation.id}/labels/${tag.id}`
        )
        .set(apiKeyHeader(plaintextKey));

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const remaining = await prismaTest.conversationLabel.findFirst({
        where: { conversationId: conversation.id, tagId: tag.id },
      });
      expect(remaining).toBeNull();
    });
  });

  // ============================================
  // POST /conversations/:id/snooze
  // ============================================
  describe('POST /conversations/:id/snooze', () => {
    it('com snoozedUntil futuro: 200 + status=snoozed', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/snooze`)
        .set(apiKeyHeader(plaintextKey))
        .send({ snoozedUntil: future });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('snoozed');
    });

    it('com hours (number): converte pra Date no futuro', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/snooze`)
        .set(apiKeyHeader(plaintextKey))
        .send({ hours: 2 });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('snoozed');
      expect(res.body.data.snoozedUntil).toBeTruthy();
    });

    it('body vazio: 400', async () => {
      const { account } = await createTestAccount();
      const { plaintextKey } = await createTestApiKey(account.id, ['chat:write']);
      const { conversation } = await createInboxAndConversation(account.id);

      const res = await request(app)
        .post(`/api/integrations/chat/conversations/${conversation.id}/snooze`)
        .set(apiKeyHeader(plaintextKey))
        .send({});

      expect(res.status).toBe(400);
    });
  });
});
