/**
 * API de integração — /api/integrations/whatsapp/campaigns/* (chave de API)
 * reapontada pro motor único de disparos (etapa C1).
 *
 * Prova que o contrato antigo continua respondendo na mesma FORMA:
 * send-batch por phones e por contactIds (201 {batchId,totalContacts,scheduled}),
 * GET batches (lista no formato antigo + filtros), GET batches/:id (envios como
 * logs), scopes da chave, 422 sem inbox e send-single pelo caminho do Chat.
 * Só a Evolution é mockada.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

const evolutionMock = vi.hoisted(() => ({
  sendText: vi.fn(async () => ({ messageId: 'evo-single-1', raw: {} })),
  getStatus: vi.fn(async () => ({ state: 'open', raw: {} })),
  sendMedia: vi.fn(async () => ({ messageId: 'media-1', raw: {} })),
  sendWhatsAppAudio: vi.fn(async () => ({ messageId: 'audio-1', raw: {} })),
  getConnectedNumber: vi.fn(async () => null),
  markMessageAsRead: vi.fn(async () => true),
  sendPresence: vi.fn(async () => true),
  fetchProfilePictureUrl: vi.fn(async () => null),
}));
vi.mock('../services/evolution.service', () => ({
  evolutionService: evolutionMock,
  extractConnectedNumber: () => null,
}));

import { prismaTest } from '../test/setup';
import { createTestAccount, createTestApiKey, createTestContact, apiKeyHeader } from '../test/helpers';
import { createTestApp } from '../test/app';
import { renderizarMensagem } from '../services/disparo/regras';

const app = createTestApp();
const BASE = '/api/integrations/whatsapp/campaigns';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function contaComInbox() {
  const { account } = await createTestAccount();
  const inbox = await prismaTest.inbox.create({
    data: { accountId: account.id, name: 'Comercial', channelType: 'whatsapp', evolutionInstance: 'inst-api', active: true },
  });
  const escrita = await createTestApiKey(account.id, ['campaigns:write']);
  const leitura = await createTestApiKey(account.id, ['campaigns:read']);
  return { account, inbox, escrita, leitura };
}

describe('POST /campaigns/send-batch', () => {
  it('por phones (objeto e string): cria o disparo, grava rótulo/variáveis e responde no contrato antigo', async () => {
    const { inbox, escrita } = await contaComInbox();

    const res = await request(app)
      .post(`${BASE}/send-batch`)
      .set(apiKeyHeader(escrita.plaintextKey))
      .send({
        phones: [{ phone: '11987654321', name: 'Maria', variables: { valor: 'R$ 99' } }, '5511976543210'],
        content: 'Oi {{nome}}, seu plano custa {{valor}}',
        triggerName: 'faltoso',
        campaignType: 'retencao',
        delaySeconds: 5, // aceito e ignorado
        metadata: { origem: 'n8n' },
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ batchId: expect.stringMatching(UUID), totalContacts: 2, scheduled: false });

    const d = await prismaTest.disparo.findUniqueOrThrow({ where: { id: res.body.data.batchId } });
    expect(d.status).toBe('enviando');
    expect(d.inboxIds).toEqual([inbox.id]);
    expect(d.nome).toBe('faltoso');
    expect(d.atendeRespostas).toBe('agente');
    expect(d.lista).toMatchObject({
      tipo: 'numeros',
      source: 'api',
      triggerName: 'faltoso',
      campaignType: 'retencao',
      metadata: { origem: 'n8n', apiKeyId: escrita.id },
    });

    const envios = await prismaTest.disparoEnvio.findMany({ where: { disparoId: d.id } });
    expect(envios.map((e) => e.telefone).sort()).toEqual(['5511976543210', '5511987654321']);
    expect(envios.every((e) => e.status === 'pendente')).toBe(true);

    const maria = envios.find((e) => e.nome === 'Maria')!;
    expect(maria.variaveis).toMatchObject({ nome: 'Maria', primeiro_nome: 'Maria', valor: 'R$ 99' });
    expect(renderizarMensagem(d.texto, d.variantes, 0, maria.variaveis as never)).toBe('Oi Maria, seu plano custa R$ 99');
  });

  it('por contactIds: usa o template da conta, agenda e mantém o vínculo com o contato', async () => {
    const { account, escrita } = await contaComInbox();
    const ana = await createTestContact(account.id, { nome: 'Ana Souza', telefone: '5511911112222' });
    const bia = await createTestContact(account.id, { nome: 'Bia', telefone: '11933334444' });
    const semTelefone = await createTestContact(account.id, { nome: 'Sem Telefone' });
    const template = await prismaTest.whatsappTemplate.create({
      data: { accountId: account.id, name: 'Boas-vindas', content: 'Olá {{nome}}, bem-vinda!' },
    });
    const daquiUmaHora = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const res = await request(app)
      .post(`${BASE}/send-batch`)
      .set(apiKeyHeader(escrita.plaintextKey))
      .send({ contactIds: [ana.id, bia.id, semTelefone.id], templateId: template.id, scheduledAt: daquiUmaHora, triggerName: 'aniversario' });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ batchId: expect.stringMatching(UUID), totalContacts: 3, scheduled: true });

    const d = await prismaTest.disparo.findUniqueOrThrow({ where: { id: res.body.data.batchId } });
    expect(d.status).toBe('agendado');
    expect(d.agendadoPara?.toISOString()).toBe(daquiUmaHora);
    expect(d.texto).toBe('Olá {{nome}}, bem-vinda!');
    expect(d.lista).toMatchObject({ tipo: 'contatos', templateId: template.id, source: 'api' });
    expect({ total: d.total, pulados: d.pulados }).toEqual({ total: 2, pulados: 1 });

    const envios = await prismaTest.disparoEnvio.findMany({ where: { disparoId: d.id }, orderBy: { telefone: 'asc' } });
    const pendentes = envios.filter((e) => e.status === 'pendente');
    expect(pendentes.map((e) => [e.telefone, e.contactId])).toEqual([
      ['5511911112222', ana.id],
      ['5511933334444', bia.id],
    ]);
    expect(envios.find((e) => e.status === 'pulado_invalido')?.nome).toBe('Sem Telefone');
  });

  it('valida na borda: contato de outra conta é ignorado (400 sem destinatários), scheduledAt no passado é 400, sem chave 401', async () => {
    const { escrita } = await contaComInbox();
    const outra = await createTestAccount();
    const alheio = await createTestContact(outra.account.id, { telefone: '5511955556666' });

    const ignorado = await request(app)
      .post(`${BASE}/send-batch`)
      .set(apiKeyHeader(escrita.plaintextKey))
      .send({ contactIds: [alheio.id], content: 'oi' });
    expect(ignorado.status).toBe(400);
    expect(await prismaTest.disparo.count()).toBe(0);

    const passado = await request(app)
      .post(`${BASE}/send-batch`)
      .set(apiKeyHeader(escrita.plaintextKey))
      .send({ phones: ['5511955556666'], content: 'oi', scheduledAt: new Date(Date.now() - 60_000).toISOString() });
    expect(passado.status).toBe(400);
    expect(JSON.stringify(passado.body)).toContain('scheduledAt deve ser futuro');

    const semChave = await request(app).post(`${BASE}/send-batch`).send({ phones: ['5511955556666'], content: 'oi' });
    expect(semChave.status).toBe(401);
  });

  it('chave só de leitura não dispara (403); conta sem inbox WhatsApp conectada toma 422 NO_WHATSAPP_INBOX', async () => {
    const { leitura } = await contaComInbox();
    const negado = await request(app)
      .post(`${BASE}/send-batch`)
      .set(apiKeyHeader(leitura.plaintextKey))
      .send({ phones: ['5511955556666'], content: 'oi' });
    expect(negado.status).toBe(403);

    const semInbox = await createTestAccount();
    const chave = await createTestApiKey(semInbox.account.id, ['campaigns:write']);
    const res = await request(app)
      .post(`${BASE}/send-batch`)
      .set(apiKeyHeader(chave.plaintextKey))
      .send({ phones: ['5511955556666'], content: 'oi' });
    expect(res.status).toBe(422);
    expect(res.body?.error?.code).toBe('NO_WHATSAPP_INBOX');
  });
});

describe('GET /campaigns/batches e /campaigns/batches/:id', () => {
  it('lista no formato antigo (status/source/triggerName mapeados) e filtra; detalhe traz os envios como logs; outra conta 404', async () => {
    const { escrita, leitura } = await contaComInbox();
    const criar = (body: Record<string, unknown>) =>
      request(app).post(`${BASE}/send-batch`).set(apiKeyHeader(escrita.plaintextKey)).send(body);

    const agora = await criar({ phones: ['5511955556666', '5511955557777'], content: 'oi {{nome}}', triggerName: 'faltoso' });
    const agendado = await criar({
      phones: ['5511955558888'],
      content: 'parabéns',
      triggerName: 'aniversario',
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect([agora.status, agendado.status]).toEqual([201, 201]);

    const lista = await request(app).get(`${BASE}/batches`).set(apiKeyHeader(leitura.plaintextKey));
    expect(lista.status).toBe(200);
    expect(lista.body.data).toHaveLength(2);
    const doFaltoso = lista.body.data.find((b: { triggerName: string }) => b.triggerName === 'faltoso');
    expect(doFaltoso).toMatchObject({
      id: agora.body.data.batchId,
      status: 'running',
      totalContacts: 2,
      sentCount: 0,
      failedCount: 0,
      source: 'api',
      triggerName: 'faltoso',
      scheduledAt: null,
      completedAt: null,
      delaySeconds: null,
      templateId: null,
      inboxId: null,
    });
    expect(typeof doFaltoso.startedAt).toBe('string');
    expect(doFaltoso.metadata).toMatchObject({ campaign_type: null, respondedCount: 0 });

    const soAgendados = await request(app).get(`${BASE}/batches?status=scheduled`).set(apiKeyHeader(leitura.plaintextKey));
    expect(soAgendados.body.data.map((b: { triggerName: string }) => b.triggerName)).toEqual(['aniversario']);

    const porGatilho = await request(app).get(`${BASE}/batches?triggerName=faltoso&source=api`).set(apiKeyHeader(leitura.plaintextKey));
    expect(porGatilho.body.data.map((b: { id: string }) => b.id)).toEqual([agora.body.data.batchId]);

    const porFonteManual = await request(app).get(`${BASE}/batches?source=manual`).set(apiKeyHeader(leitura.plaintextKey));
    expect(porFonteManual.body.data).toEqual([]);

    const detalhe = await request(app).get(`${BASE}/batches/${agora.body.data.batchId}`).set(apiKeyHeader(leitura.plaintextKey));
    expect(detalhe.status).toBe(200);
    expect(detalhe.body.data).toMatchObject({ id: agora.body.data.batchId, status: 'running', totalContacts: 2 });
    expect(detalhe.body.data.logs).toHaveLength(2);
    expect(detalhe.body.data.logs.map((l: { status: string }) => l.status)).toEqual(['pending', 'pending']);
    expect(detalhe.body.data.logs.map((l: { phone: string }) => l.phone).sort()).toEqual(['5511955556666', '5511955557777']);
    expect(detalhe.body.data.logs[0]).toMatchObject({
      batchId: agora.body.data.batchId,
      inboxName: 'Comercial',
      inboxId: null,
      errorMessage: null,
      sentAt: null,
    });

    const outra = await createTestAccount();
    const chaveDaOutra = await createTestApiKey(outra.account.id, ['campaigns:read']);
    const alheio = await request(app).get(`${BASE}/batches/${agora.body.data.batchId}`).set(apiKeyHeader(chaveDaOutra.plaintextKey));
    expect(alheio.status).toBe(404);
    const listaDaOutra = await request(app).get(`${BASE}/batches`).set(apiKeyHeader(chaveDaOutra.plaintextKey));
    expect(listaDaOutra.body.data).toEqual([]);
  });
});

describe('POST /campaigns/send-single', () => {
  it('manda um texto agora pelo caminho do Chat e responde no contrato antigo', async () => {
    const { escrita } = await contaComInbox();
    evolutionMock.sendText.mockClear();

    const res = await request(app)
      .post(`${BASE}/send-single`)
      .set(apiKeyHeader(escrita.plaintextKey))
      .send({ phone: '5511987654321', contactName: 'Maria', content: 'Oi {{nome}}, tudo bem?', triggerName: 'boas-vindas' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      batchId: null,
      messageId: expect.stringMatching(UUID),
      conversationId: expect.stringMatching(UUID),
      status: 'sent',
    });
    expect(evolutionMock.sendText).toHaveBeenCalledTimes(1);
    expect((evolutionMock.sendText.mock.calls[0] as unknown[])[1]).toMatchObject({ text: 'Oi Maria, tudo bem?' });
    expect(await prismaTest.disparo.count()).toBe(0);
  });
});
