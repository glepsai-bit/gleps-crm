/**
 * Rotas de upload/URL da base de conhecimento, de ponta a ponta (multer +
 * controller + service + Postgres). O unitário já cobre a extração; aqui o
 * que se prova é o contrato HTTP: campo `file`, códigos 201/400/404/422, o
 * formato do erro, e que 422 não deixa doc no banco.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { prismaTest } from '../test/setup';
import { createTestAccount, authHeader } from '../test/helpers';
import { createTestApp } from '../test/app';
import { pdfMinimo, PDF_LINHAS_PRECOS, docxMinimo } from '../test/fixtures-documentos';

const app = createTestApp();

async function contaComBase() {
  const conta = await createTestAccount();
  const base = await prismaTest.knowledgeBase.create({
    data: { accountId: conta.account.id, name: 'Base de teste' },
  });
  return { ...conta, base };
}

describe('POST /api/ai/bases/:baseId/docs/upload', () => {
  it('PDF com texto → 201 com doc sourceType file e pendente de indexação', async () => {
    const { jwt, base, account } = await contaComBase();

    const res = await request(app)
      .post(`/api/ai/bases/${base.id}/docs/upload`)
      .set(authHeader(jwt))
      .attach('file', pdfMinimo(PDF_LINHAS_PRECOS), 'precos.pdf');

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      accountId: account.id,
      baseId: base.id,
      title: 'precos',
      sourceType: 'file',
      sourceRef: 'precos.pdf',
      status: 'pending',
    });
    expect(res.body.data.content).toContain('Plano Pro custa R$ 890 por mes');
  });

  it('PDF sem texto → 422 com mensagem em português e NENHUM doc no banco', async () => {
    const { jwt, base } = await contaComBase();

    const res = await request(app)
      .post(`/api/ai/bases/${base.id}/docs/upload`)
      .set(authHeader(jwt))
      .attach('file', pdfMinimo([]), 'escaneado.pdf');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DOCUMENTO_ILEGIVEL');
    expect(res.body.error.message).toBe(
      'PDF sem texto (provavelmente escaneado). Não é lido: converta pra texto ou cole o conteúdo.'
    );
    expect(await prismaTest.knowledgeDoc.count({ where: { baseId: base.id } })).toBe(0);
  });

  it('.docx → 201 com o texto do Word; title do body vence o nome do arquivo', async () => {
    const { jwt, base } = await contaComBase();

    const res = await request(app)
      .post(`/api/ai/bases/${base.id}/docs/upload`)
      .set(authHeader(jwt))
      .field('title', 'Manual do atendimento')
      .attach('file', docxMinimo(), 'manual.docx');

    expect(res.status).toBe(201);
    expect(res.body.data.title).toBe('Manual do atendimento');
    expect(res.body.data.content).toContain('Plano Premium inclui consultoria.');
  });

  it('extensão fora da lista → 400 antes de tocar no arquivo', async () => {
    const { jwt, base } = await contaComBase();

    const res = await request(app)
      .post(`/api/ai/bases/${base.id}/docs/upload`)
      .set(authHeader(jwt))
      .attach('file', Buffer.from('x'), 'planilha.xlsx');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Formato não aceito');
  });

  it('sem campo file → 400 explicando o campo', async () => {
    const { jwt, base } = await contaComBase();
    const res = await request(app).post(`/api/ai/bases/${base.id}/docs/upload`).set(authHeader(jwt)).field('title', 'x');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('"file"');
  });

  it('base de outra conta → 404 e nada gravado', async () => {
    const dona = await contaComBase();
    const intrusa = await createTestAccount();

    const res = await request(app)
      .post(`/api/ai/bases/${dona.base.id}/docs/upload`)
      .set(authHeader(intrusa.jwt))
      .attach('file', pdfMinimo(PDF_LINHAS_PRECOS), 'precos.pdf');

    expect(res.status).toBe(404);
    expect(await prismaTest.knowledgeDoc.count()).toBe(0);
  });

  it('o alias /knowledge/:baseId/docs/upload responde igual', async () => {
    const { jwt, base } = await contaComBase();
    const res = await request(app)
      .post(`/api/ai/knowledge/${base.id}/docs/upload`)
      .set(authHeader(jwt))
      .attach('file', Buffer.from('Fechado aos domingos.'), 'horario.txt');
    expect(res.status).toBe(201);
    expect(res.body.data.content).toBe('Fechado aos domingos.');
  });
});

describe('POST /api/ai/bases/:baseId/docs/url', () => {
  const fetchMock = vi.fn();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => vi.unstubAllGlobals());

  it('endereço interno → 400 sem nenhum fetch', async () => {
    const { jwt, base } = await contaComBase();

    const res = await request(app)
      .post(`/api/ai/bases/${base.id}/docs/url`)
      .set(authHeader(jwt))
      .send({ url: 'http://127.0.0.1:3000/api/admin' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('rede interna');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prismaTest.knowledgeDoc.count()).toBe(0);
  });

  it('página pública com texto → 201 com doc sourceType url', async () => {
    const { jwt, base } = await contaComBase();
    fetchMock.mockResolvedValue(
      new Response('<html><head><title>FAQ</title></head><body><h1>Perguntas</h1><p>Aceitamos Pix.</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    );

    const res = await request(app)
      .post(`/api/ai/bases/${base.id}/docs/url`)
      .set(authHeader(jwt))
      .send({ url: 'http://203.0.113.10/faq' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      title: 'FAQ',
      sourceType: 'url',
      sourceRef: 'http://203.0.113.10/faq',
      content: 'Perguntas\n\nAceitamos Pix.',
    });
  });

  it('body sem url → 400 do zod', async () => {
    const { jwt, base } = await contaComBase();
    const res = await request(app).post(`/api/ai/bases/${base.id}/docs/url`).set(authHeader(jwt)).send({});
    expect(res.status).toBe(400);
  });
});
