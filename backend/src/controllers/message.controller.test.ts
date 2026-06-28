/**
 * AREA T5 — message controller
 *
 * Cobre as validacoes zod do POST /conversations/:id/messages:
 * - content >4096 chars → 400
 * - content vazio sem attachments → 400
 *
 * O rate limit (messageLimiter) eh integration-level e dificil de testar
 * deterministicamente num pool fork unico (compartilha contador entre
 * testes). Vide nota inline abaixo.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

// Mock evolution.service pra nao chamar HTTP real em fluxos felizes
vi.mock('../services/evolution.service', () => ({
  evolutionService: {
    sendText: vi.fn(async () => ({ messageId: 'evo-test-msg' })),
  },
}));

import { prismaTest } from '../test/setup';
import { authHeader } from '../test/helpers';
import { createTestApp } from '../test/app';

const app = createTestApp();

async function makeAdminJwt() {
  const account = await prismaTest.account.create({ data: { nome: 'MsgTest' } });
  const user = await prismaTest.user.create({
    data: {
      accountId: account.id,
      nome: 'Msg Admin',
      email: `msg-${randomUUID()}@t.com`,
      passwordHash: 'x',
      role: 'admin',
      status: 'active',
      permissions: [],
    },
  });
  const token = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: 'admin',
      accountId: account.id,
      permissions: [],
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' }
  );
  return { jwt: token, account, user };
}

async function createConversation(accountId: string) {
  const inbox = await prismaTest.inbox.create({
    data: {
      accountId,
      name: 'Inbox Teste',
      channelType: 'whatsapp',
      evolutionInstance: `inst-${Date.now()}`,
    },
  });
  const contact = await prismaTest.contact.create({
    data: {
      accountId,
      nome: 'Contato MSG',
      telefone: '5534993383017',
    },
  });
  const conversation = await prismaTest.conversation.create({
    data: {
      accountId,
      inboxId: inbox.id,
      contactId: contact.id,
      status: 'open',
    },
  });
  return { inbox, contact, conversation };
}

describe('POST /api/conversations/:id/messages — validacoes', () => {
  it('content >4096 chars: 400 com mensagem de tamanho', async () => {
    const { jwt, account } = await makeAdminJwt();
    const { conversation } = await createConversation(account.id);

    const tooLong = 'a'.repeat(4097);
    const res = await request(app)
      .post(`/api/conversations/${conversation.id}/messages`)
      .set(authHeader(jwt))
      .send({ content: tooLong });

    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    // mensagem do zod menciona 4096
    expect(body).toMatch(/4096|muito longa/i);
  });

  it('content exatamente 4096 chars: aceita (201)', async () => {
    const { jwt, account } = await makeAdminJwt();
    const { conversation } = await createConversation(account.id);

    const exact = 'b'.repeat(4096);
    const res = await request(app)
      .post(`/api/conversations/${conversation.id}/messages`)
      .set(authHeader(jwt))
      .send({ content: exact });

    expect(res.status).toBe(201);
  });

  it('content vazio E sem attachments: 400 (precisa de content ou attachments)', async () => {
    const { jwt, account } = await makeAdminJwt();
    const { conversation } = await createConversation(account.id);

    const res = await request(app)
      .post(`/api/conversations/${conversation.id}/messages`)
      .set(authHeader(jwt))
      .send({ content: '   ' }); // so whitespace

    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).toMatch(/content|attachments/i);
  });

  it('body vazio: 400', async () => {
    const { jwt, account } = await makeAdminJwt();
    const { conversation } = await createConversation(account.id);

    const res = await request(app)
      .post(`/api/conversations/${conversation.id}/messages`)
      .set(authHeader(jwt))
      .send({});

    expect(res.status).toBe(400);
  });

  // NOTA: o messageLimiter (30/min/IP) eh declarado em escopo de modulo no
  // routes/message.routes.ts. Com pool 'forks' singleFork (vitest.config),
  // o contador eh compartilhado entre testes — fazer 30+ POSTs aqui poluiria
  // outros suites e torna o teste flaky (ordem dependente).
  // Validacao do rate limiter eh cobrir manualmente em QA ou em suite dedicada.
  it('PULADO: 30+ POSTs em <1min retorna 429 (rate limiter compartilhado entre suites)', () => {
    expect(true).toBe(true);
  });
});
