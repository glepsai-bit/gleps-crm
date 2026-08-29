/**
 * Multi-tenant isolation tests (cross-tenant 404).
 *
 * Padrao: criar 2 contas (A e B), criar recurso na A com JWT-A, tentar
 * acessar/mutar com JWT-B e validar 404 (nao 403, nao 200, nao 500).
 *
 * NotFoundError em todos os services devolve 404 com code='NOT_FOUND' via
 * errorHandler — esse contrato eh o que protege multi-tenancy: o tenant B
 * NAO deve receber feedback de "o recurso existe mas voce nao tem acesso"
 * (403) e tampouco vazar dados (200). Tem que ser 404 limpo.
 *
 * IMPLEMENTACAO:
 * - Criamos 2 contas via PrismaClient singleton (config/database.ts) — o mesmo
 *   que controllers/middlewares usam. Se usarmos prismaTest (outra instancia),
 *   o pool do singleton pode carregar snapshot MVCC defasado apos TRUNCATE em
 *   beforeEach, gerando FK violations / USER_NOT_FOUND espurios.
 * - Assinamos JWT direto com env.JWT_SECRET, bypassando authService.login()
 *   (que cria refresh_token e tambem disputaria a janela MVCC).
 * - DATABASE_URL local injeta `connection_limit=1` para serializar as
 *   conexoes do pool e eliminar de vez a flakiness sem precisar mexer no
 *   vitest.config.ts compartilhado. Tem impacto so neste arquivo (executa
 *   antes do PrismaClient ser instanciado pelo first import abaixo).
 */

// CRITICAL: forca connection_limit=1 ANTES de qualquer import que instancie
// PrismaClient. Setando aqui (top do arquivo) garante que o singleton de
// config/database.ts (importado mais abaixo) ja nasce com pool de 1 conexao.
// Idempotente: so adiciona o parametro se ainda nao estiver presente.
{
  const url = process.env.DATABASE_URL;
  if (url && !/[?&]connection_limit=/.test(url)) {
    process.env.DATABASE_URL = url + (url.includes('?') ? '&' : '?') + 'connection_limit=1';
  }
}

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import * as crypto from 'crypto';
import { prismaTest } from '../test/setup';
import { prisma as prismaSingleton } from '../config/database';
import { authHeader, apiKeyHeader } from '../test/helpers';
import { createTestApp } from '../test/app';

const app = createTestApp();

const JWT_SECRET =
  process.env.JWT_SECRET ?? 'test-jwt-secret-minimo-32-chars-aaaaaaaa';

interface Tenant {
  account: { id: string; nome: string };
  user: { id: string; email: string; nome: string };
  jwt: string;
}

/**
 * Cria account + admin user direto via prismaTest, assina JWT manualmente.
 * Bypassa authService.login() (que usa singleton prisma e gera FK race).
 */
/**
 * Retry helper: tenta `fn` ate `attempts` vezes com pequeno backoff.
 * O DB de teste compartilha conexoes entre PrismaClient singleton (auth) e
 * prismaTest. Quando o TRUNCATE roda em beforeEach, a snapshot MVCC de uma
 * conexao pode ficar defasada por alguns ms, gerando FK violations em INSERTs
 * imediatos. Retry contorna a janela de visibilidade sem precisar mexer no
 * setup compartilhado.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 10,
  delayMs = 50,
  shouldRetry: (err: any) => boolean = (err) =>
    err?.code === 'P2003' ||
    /Foreign key constraint/i.test(String(err?.message ?? '')) ||
    /ainda nao visivel/.test(String(err?.message ?? ''))
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (!shouldRetry(err)) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function createTenant(name: string): Promise<Tenant> {
  const passwordHash = await bcrypt.hash('Test@1234', 10);
  const email = `${name.toLowerCase().replace(/\s+/g, '-')}-${randomUUID().slice(0, 8)}@test.com`;
  // CRITICAL: usar o PrismaClient singleton (config/database.ts) — o mesmo
  // que auth.middleware/controllers usam internamente. Se criarmos via
  // prismaTest (instancia separada), o singleton's pool pode carregar
  // snapshot MVCC defasado e auth.middleware nao acha o user (USER_NOT_FOUND
  // 401), nem os updates de email.service acham a cadencia (404 espurio).
  // Retry continua aqui pra cobrir a janela entre TRUNCATE (prismaTest) e
  // visibilidade no singleton.
  const { account, user } = await withRetry(() =>
    prismaSingleton.$transaction(async (tx) => {
      const account = await tx.account.create({ data: { nome: name } });
      const user = await tx.user.create({
        data: {
          accountId: account.id,
          nome: `Admin ${name}`,
          email,
          passwordHash,
          role: 'admin',
          status: 'active',
          permissions: [
            'dashboard',
            'leads',
            'kanban',
            'emails',
            'whatsapp_templates',
            'sales',
            'finance',
            'agenda',
          ],
        },
      });
      return { account, user };
    })
  );

  // Sanity check: confirma visibilidade do user E account no singleton (outras
  // conexoes do pool). Em dois PrismaClient compartilhando o DB, vimos
  // USER_NOT_FOUND e FK violations intermitentes apos commit — snapshot
  // defasado em alguma conexao. Pollamos ate ver ambos visiveis.
  // Polling de account em SEPARADO (varias conexoes podem ter snapshots
  // diferentes — uma pode ver user mas outra so o account).
  await withRetry(async () => {
    const [u, a] = await Promise.all([
      prismaSingleton.user.findUnique({ where: { id: user.id } }),
      prismaSingleton.account.findUnique({ where: { id: account.id } }),
    ]);
    if (!u || !a) throw new Error('User/Account ainda nao visivel apos commit');
  }, 30, 100);

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

  return {
    account: { id: account.id, nome: account.nome },
    user: { id: user.id, email: user.email, nome: user.nome },
    jwt: token,
  };
}

/**
 * Cria uma API key real direto via prismaTest (sem dependencia de login).
 */
async function createApiKeyForTenant(
  accountId: string,
  scopes: string[] = ['*']
): Promise<{ id: string; plaintextKey: string }> {
  const plaintextKey = 'glk_' + crypto.randomBytes(20).toString('hex');
  const prefix = plaintextKey.substring(0, 12);
  const hashedKey = crypto.createHash('sha256').update(plaintextKey).digest('hex');

  const record = await withRetry(() =>
    prismaSingleton.apiKey.create({
      data: {
        accountId,
        name: `test-key-${Date.now()}-${randomUUID().slice(0, 6)}`,
        keyPrefix: prefix,
        hashedKey,
        scopes,
      },
    })
  );

  return { id: record.id, plaintextKey };
}

// Helper local: cria um inbox direto via singleton (visivel pelos controllers).
async function createTestInbox(accountId: string, name = 'Inbox Teste') {
  return withRetry(() =>
    prismaSingleton.inbox.create({
      data: {
        accountId,
        name,
        channelType: 'whatsapp',
      },
    })
  );
}

// Wrapper para criar contact via singleton com retry em FK violation transitoria.
async function createContactRetry(accountId: string, nome = 'Lead Teste') {
  return withRetry(() =>
    prismaSingleton.contact.create({
      data: {
        accountId,
        nome,
      },
    })
  );
}

// Cria funil + stages via singleton — versao inline do helper.
async function createFunnelStagesRetry(accountId: string, stageNames: string[]) {
  const funnel = await withRetry(() =>
    prismaSingleton.funnel.create({
      data: {
        accountId,
        name: 'Funil Principal',
        slug: 'funil-principal',
        isDefault: true,
      },
    })
  );
  for (let i = 0; i < stageNames.length; i++) {
    const name = stageNames[i];
    await withRetry(() =>
      prismaSingleton.tag.create({
        data: {
          accountId,
          funnelId: funnel.id,
          name,
          slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          type: 'stage',
          ordem: i,
        },
      })
    );
  }
  return funnel;
}

describe('Multi-tenant isolation — cross-tenant 404', () => {
  // ============================================
  // CONTACTS
  // ============================================
  it('GET /api/contacts/:id — JWT-B nao ve contato da conta A (404)', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    // Cria contato na conta A via API
    const createRes = await request(app)
      .post('/api/contacts')
      .set(authHeader(A.jwt))
      .send({ nome: 'Lead da A', telefone: '5511999999999' });

    expect(createRes.status).toBe(201);
    const contactId = createRes.body.data.id;
    expect(contactId).toBeTruthy();

    // Tenta acessar com JWT-B
    const getRes = await request(app)
      .get(`/api/contacts/${contactId}`)
      .set(authHeader(B.jwt));

    expect(getRes.status).toBe(404);
    expect(getRes.body?.error?.code).toBe('NOT_FOUND');
  });

  // ============================================
  // SALES (precisa contato + produto na conta A)
  // ============================================
  it('GET /api/sales/:id — JWT-B nao ve venda da conta A (404)', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    const contactA = await createContactRetry(A.account.id);
    const productA = await withRetry(() =>
      prismaSingleton.product.create({
        data: {
          accountId: A.account.id,
          nome: 'Produto A',
          valorPadrao: 100.0,
          ativo: true,
        },
      })
    );

    const createRes = await request(app)
      .post('/api/sales')
      .set(authHeader(A.jwt))
      .send({
        contactId: contactA.id,
        metodoPagamento: 'pix',
        items: [{ productId: productA.id, quantidade: 1, valorUnitario: 100 }],
      });

    expect(createRes.status).toBe(201);
    const saleId = createRes.body.data.id;

    const getRes = await request(app)
      .get(`/api/sales/${saleId}`)
      .set(authHeader(B.jwt));

    expect(getRes.status).toBe(404);
    expect(getRes.body?.error?.code).toBe('NOT_FOUND');
  });

  // ============================================
  // CALENDAR EVENTS
  // ============================================
  it('GET /api/calendar/events/:id — JWT-B nao ve evento da conta A (404)', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    // Cria evento no futuro (1h a frente) pra passar validacao
    const startTime = new Date(Date.now() + 60 * 60 * 1000);
    const endTime = new Date(Date.now() + 2 * 60 * 60 * 1000);

    const createRes = await request(app)
      .post('/api/calendar/events')
      .set(authHeader(A.jwt))
      .send({
        title: 'Reuniao A',
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        type: 'meeting',
      });

    expect(createRes.status).toBe(201);
    const eventId = createRes.body.data.id;

    const getRes = await request(app)
      .get(`/api/calendar/events/${eventId}`)
      .set(authHeader(B.jwt));

    expect(getRes.status).toBe(404);
    expect(getRes.body?.error?.code).toBe('NOT_FOUND');
  });

  // ============================================
  // CONVERSATIONS
  // ============================================
  it('GET /api/conversations/:id — JWT-B nao ve conversa da conta A (404)', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    const inboxA = await createTestInbox(A.account.id);
    const conversationA = await withRetry(() =>
      prismaSingleton.conversation.create({
        data: {
          accountId: A.account.id,
          inboxId: inboxA.id,
          status: 'open',
          priority: 'medium',
        },
      })
    );

    const getRes = await request(app)
      .get(`/api/conversations/${conversationA.id}`)
      .set(authHeader(B.jwt));

    expect(getRes.status).toBe(404);
    expect(getRes.body?.error?.code).toBe('NOT_FOUND');
  });

  // ============================================
  // EMAIL CADENCES (BUG CRITICAL #3 — PUT cross-tenant)
  // ============================================
  it('PUT /api/email/cadences/:id — JWT-B nao atualiza cadencia da conta A (404) — BUG CRITICAL #3', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    const cadenceA = await withRetry(() =>
      prismaSingleton.emailCadence.create({
        data: {
          accountId: A.account.id,
          name: 'Cadencia A',
          sendAtTime: '09:00',
          startDate: new Date(),
        },
      })
    );

    const putRes = await request(app)
      .put(`/api/email/cadences/${cadenceA.id}`)
      .set(authHeader(B.jwt))
      .send({ name: 'Hackeada pela B' });

    expect(putRes.status).toBe(404);
    expect(putRes.body?.error?.code).toBe('NOT_FOUND');

    // Guarantee: a cadencia NAO foi alterada
    const stillA = await prismaTest.emailCadence.findUnique({
      where: { id: cadenceA.id },
    });
    expect(stillA?.name).toBe('Cadencia A');
    expect(stillA?.accountId).toBe(A.account.id);
  });

  it('DELETE /api/email/cadences/:id — JWT-B nao deleta cadencia da conta A (404)', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    const cadenceA = await withRetry(() =>
      prismaSingleton.emailCadence.create({
        data: {
          accountId: A.account.id,
          name: 'Cadencia A',
          sendAtTime: '09:00',
          startDate: new Date(),
        },
      })
    );

    const delRes = await request(app)
      .delete(`/api/email/cadences/${cadenceA.id}`)
      .set(authHeader(B.jwt));

    expect(delRes.status).toBe(404);
    expect(delRes.body?.error?.code).toBe('NOT_FOUND');

    // Guarantee: continua existindo
    const stillA = await prismaTest.emailCadence.findUnique({
      where: { id: cadenceA.id },
    });
    expect(stillA).not.toBeNull();
  });

  // ============================================
  // EMAIL TEMPLATES
  // ============================================
  it('PUT /api/email/templates/:id — JWT-B nao atualiza template da conta A (404)', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    const templateA = await withRetry(() =>
      prismaSingleton.emailTemplate.create({
        data: {
          accountId: A.account.id,
          name: 'Template A',
          subject: 'Assunto A',
          bodyHtml: '<p>Body A</p>',
        },
      })
    );

    const putRes = await request(app)
      .put(`/api/email/templates/${templateA.id}`)
      .set(authHeader(B.jwt))
      .send({ subject: 'Hackeado pela B' });

    expect(putRes.status).toBe(404);
    expect(putRes.body?.error?.code).toBe('NOT_FOUND');

    const stillA = await prismaTest.emailTemplate.findUnique({
      where: { id: templateA.id },
    });
    expect(stillA?.subject).toBe('Assunto A');
  });

  // ============================================
  // WHATSAPP TEMPLATES
  // ============================================
  it('DELETE /api/whatsapp-templates/:id — JWT-B nao deleta template da conta A (404)', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    const templateA = await withRetry(() =>
      prismaSingleton.whatsappTemplate.create({
        data: {
          accountId: A.account.id,
          name: 'Template WA A',
          content: 'Ola {nome}',
          category: 'custom',
          variables: ['nome'],
        },
      })
    );

    const delRes = await request(app)
      .delete(`/api/whatsapp-templates/${templateA.id}`)
      .set(authHeader(B.jwt));

    expect(delRes.status).toBe(404);
    expect(delRes.body?.error?.code).toBe('NOT_FOUND');

    const stillA = await prismaTest.whatsappTemplate.findUnique({
      where: { id: templateA.id },
    });
    expect(stillA).not.toBeNull();
  });

  // ============================================
  // AUDIENCES
  // ============================================
  it('PUT /api/email/audiences/:id — JWT-B nao atualiza audience da conta A (404)', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    const audienceA = await withRetry(() =>
      prismaSingleton.emailAudience.create({
        data: {
          accountId: A.account.id,
          name: 'Audience A',
          description: 'descA',
        },
      })
    );

    const putRes = await request(app)
      .put(`/api/email/audiences/${audienceA.id}`)
      .set(authHeader(B.jwt))
      .send({ name: 'Hackeada' });

    expect(putRes.status).toBe(404);
    expect(putRes.body?.error?.code).toBe('NOT_FOUND');

    const stillA = await prismaTest.emailAudience.findUnique({
      where: { id: audienceA.id },
    });
    expect(stillA?.name).toBe('Audience A');
  });

  // ============================================
  // WHATSAPP CAMPAIGN BATCHES
  // ============================================
  it('DELETE /api/whatsapp/campaigns/batches/:id — JWT-B nao cancela batch da conta A (404)', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    const batchA = await withRetry(() =>
      prismaSingleton.dispatchBatch.create({
        data: {
          accountId: A.account.id,
          status: 'scheduled',
          totalContacts: 0,
          scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
          source: 'manual_scheduled',
        },
      })
    );

    const delRes = await request(app)
      .delete(`/api/whatsapp/campaigns/batches/${batchA.id}`)
      .set(authHeader(B.jwt));

    expect(delRes.status).toBe(404);
    expect(delRes.body?.error?.code).toBe('NOT_FOUND');

    // Guarantee: batch NAO foi cancelado
    const stillA = await prismaTest.dispatchBatch.findUnique({
      where: { id: batchA.id },
    });
    expect(stillA?.status).toBe('scheduled');
  });

  // ============================================
  // INTEGRATIONS KANBAN (api-key da conta B em leadId da conta A)
  // ============================================
  it('POST /api/integrations/kanban/leads/:leadId/stage — api-key da B em lead da A (404)', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    // Lead pertence a conta A
    const leadA = await createContactRetry(A.account.id, 'Lead da A');

    // Stages tambem pertencem a conta A
    await createFunnelStagesRetry(A.account.id, ['Novo', 'Negociacao']);

    // API key pertence a conta B com scopes amplos
    const keyB = await createApiKeyForTenant(B.account.id, ['*']);

    // Conta B tenta mover lead da A pra qualquer stage
    const moveRes = await request(app)
      .post(`/api/integrations/kanban/leads/${leadA.id}/stage`)
      .set(apiKeyHeader(keyB.plaintextKey))
      .send({ stageName: 'Negociacao' });

    expect(moveRes.status).toBe(404);
    // O service joga NotFoundError('Lead') — devolve 404 com code NOT_FOUND
    expect(moveRes.body?.error?.code).toBe('NOT_FOUND');

    // Guarantee: nenhuma leadTag foi criada pro lead da A
    const tagsApplied = await prismaTest.leadTag.findMany({
      where: { contactId: leadA.id },
    });
    expect(tagsApplied.length).toBe(0);
  });

  // ============================================
  // TAGS — REORDER EM LOTE (escrita cross-tenant)
  //
  // Achado de auditoria: POST /api/tags/reorder recebia `tagIds` do corpo e
  // escrevia direto (`tag.update({ where: { id } })`), sem escopo por conta. O
  // accountId chegava no service e não era usado. Isso é pior que vazamento de
  // leitura: um admin qualquer reordenava o funil de OUTRO cliente. Os dois
  // caminhos do endpoint (troca de par e reordenação completa) tinham o furo.
  // ============================================
  it('POST /api/tags/reorder — B nao reordena (swap) as etapas da conta A', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    await createFunnelStagesRetry(A.account.id, ['Novo', 'Negociacao']);
    const [t1, t2] = await prismaTest.tag.findMany({
      where: { accountId: A.account.id, type: 'stage' },
      orderBy: { ordem: 'asc' },
    });

    const res = await request(app)
      .post('/api/tags/reorder')
      .set(authHeader(B.jwt))
      .send({ tagIds: [t1.id, t2.id] });

    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe('NOT_FOUND');

    // O que realmente importa: a ordem do funil da A ficou intacta.
    const depois = await prismaTest.tag.findMany({
      where: { id: { in: [t1.id, t2.id] } },
      select: { id: true, ordem: true },
    });
    expect(depois.find((t) => t.id === t1.id)?.ordem).toBe(t1.ordem);
    expect(depois.find((t) => t.id === t2.id)?.ordem).toBe(t2.ordem);
  });

  it('POST /api/tags/reorder — B nao reordena (lista) as etapas da conta A', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    // Três etapas: cai no caminho de reordenação completa, não no swap.
    await createFunnelStagesRetry(A.account.id, ['Novo', 'Negociacao', 'Fechado']);
    const antes = await prismaTest.tag.findMany({
      where: { accountId: A.account.id, type: 'stage' },
      orderBy: { ordem: 'asc' },
      select: { id: true, ordem: true },
    });

    const res = await request(app)
      .post('/api/tags/reorder')
      .set(authHeader(B.jwt))
      // Ordem invertida: se passasse, o funil da A viraria de cabeça pra baixo.
      .send({ tagIds: [...antes].reverse().map((t) => t.id) });

    expect(res.status).toBe(404);

    const depois = await prismaTest.tag.findMany({
      where: { accountId: A.account.id, type: 'stage' },
      orderBy: { ordem: 'asc' },
      select: { id: true, ordem: true },
    });
    expect(depois).toEqual(antes);
  });

  it('POST /api/tags/reorder — mistura de contas nao passa nem parcialmente', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    await createFunnelStagesRetry(A.account.id, ['Novo A', 'Fechado A']);
    await createFunnelStagesRetry(B.account.id, ['Novo B', 'Fechado B']);

    const tagsA = await prismaTest.tag.findMany({
      where: { accountId: A.account.id, type: 'stage' },
      orderBy: { ordem: 'asc' },
    });
    const tagsB = await prismaTest.tag.findMany({
      where: { accountId: B.account.id, type: 'stage' },
      orderBy: { ordem: 'asc' },
    });

    // Uma tag própria e uma alheia: a validação tem que reprovar o lote INTEIRO.
    // Reprovar só a alheia deixaria a escrita acontecer pela metade.
    const res = await request(app)
      .post('/api/tags/reorder')
      .set(authHeader(B.jwt))
      .send({ tagIds: [tagsB[1].id, tagsA[0].id] });

    expect(res.status).toBe(404);

    const bDepois = await prismaTest.tag.findMany({
      where: { accountId: B.account.id, type: 'stage' },
      orderBy: { ordem: 'asc' },
      select: { id: true, ordem: true },
    });
    expect(bDepois.map((t) => t.id)).toEqual(tagsB.map((t) => t.id));
    expect(bDepois.map((t) => t.ordem)).toEqual(tagsB.map((t) => t.ordem));
  });

  // Caso de controle: a correção acima trocou `update` por `updateMany` com
  // accountId. Sem este teste, um endurecimento de segurança poderia ter
  // quebrado a reordenação legítima sem ninguém perceber.
  it('POST /api/tags/reorder — a reordenacao da propria conta continua funcionando', async () => {
    const A = await createTenant('Conta A');

    await createFunnelStagesRetry(A.account.id, ['Novo', 'Negociacao', 'Fechado']);
    const antes = await prismaTest.tag.findMany({
      where: { accountId: A.account.id, type: 'stage' },
      orderBy: { ordem: 'asc' },
      select: { id: true, name: true },
    });

    // Swap de duas: Novo e Negociacao trocam de lugar.
    const swap = await request(app)
      .post('/api/tags/reorder')
      .set(authHeader(A.jwt))
      .send({ tagIds: [antes[0].id, antes[1].id] });
    expect(swap.status).toBe(200);

    const posSwap = await prismaTest.tag.findMany({
      where: { accountId: A.account.id, type: 'stage' },
      orderBy: { ordem: 'asc' },
      select: { id: true },
    });
    expect(posSwap.map((t) => t.id)).toEqual([antes[1].id, antes[0].id, antes[2].id]);

    // Reordenação completa: a posição no array vira a ordem.
    const nova = [antes[2].id, antes[0].id, antes[1].id];
    const full = await request(app)
      .post('/api/tags/reorder')
      .set(authHeader(A.jwt))
      .send({ tagIds: nova });
    expect(full.status).toBe(200);

    const posFull = await prismaTest.tag.findMany({
      where: { accountId: A.account.id, type: 'stage' },
      orderBy: { ordem: 'asc' },
      select: { id: true },
    });
    expect(posFull.map((t) => t.id)).toEqual(nova);
  });

  // ============================================
  // WARMUP — START IDEMPOTENTE (vazamento de leitura)
  //
  // Achado de auditoria: o claim era escopado por conta, mas quando ele não
  // casava o código caía num `findUnique({ where: { id } })` sem conta e
  // devolvia 200 com os dados. Um id de outro tenant não batia no claim e
  // saía pela porta de trás — status, dia atual e plano de disparo do vizinho.
  // ============================================
  it('POST /api/warmup/numbers/:id/start — B nao le o aquecimento da conta A', async () => {
    const A = await createTenant('Conta A');
    const B = await createTenant('Conta B');

    const poolA = await withRetry(() =>
      prismaSingleton.warmupPool.create({
        data: { accountId: A.account.id, name: 'Pool da A' },
      })
    );
    const numeroA = await withRetry(() =>
      prismaSingleton.warmupNumber.create({
        data: {
          accountId: A.account.id,
          poolId: poolA.id,
          evolutionInstance: 'inst-conta-a',
          phoneE164: '5511988887777',
          status: 'warming',
          currentDay: 7,
        },
      })
    );

    const res = await request(app)
      .post(`/api/warmup/numbers/${numeroA.id}/start`)
      .set(authHeader(B.jwt))
      .send({});

    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe('NOT_FOUND');
    // Nada do estado da conta A pode aparecer na resposta.
    expect(res.body?.data).toBeUndefined();
  });
});
