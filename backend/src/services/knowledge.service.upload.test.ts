/**
 * Upload de arquivo e importação por URL na base de conhecimento.
 *
 * O que está em jogo: nunca nascer documento vazio (PDF escaneado, página sem
 * texto), a proteção de rede interna valer ANTES de qualquer fetch, e o doc
 * criado carregar a origem certa (sourceType/sourceRef) pra tela mostrar.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pdfMinimo, PDF_LINHAS_PRECOS, docxMinimo } from '../test/fixtures-documentos';

const prismaMock = vi.hoisted(() => ({
  knowledgeBase: { findFirst: vi.fn() },
  knowledgeDoc: { create: vi.fn() },
}));

vi.mock('../config/database', () => ({ prisma: prismaMock }));
vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./ai/knowledge-index', () => ({ invalidateBase: vi.fn() }));
vi.mock('./ai/embeddings', () => ({ embed: vi.fn() }));
vi.mock('./ai/chat', () => ({ chat: vi.fn() }));

import { knowledgeService, extensaoDe } from './knowledge.service';
import { DocumentoIlegivelError } from './ai/extrair-texto';

// Erros do projeto são conferidos por statusCode/code, não por instanceof:
// AppError refaz o prototype no construtor e as subclasses perdem a identidade.
const ACCOUNT = 'conta-1';
const BASE = 'base-1';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.knowledgeBase.findFirst.mockResolvedValue({ id: BASE, accountId: ACCOUNT });
  prismaMock.knowledgeDoc.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'doc-1',
    ...data,
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function respostaHttp(corpo: string | Buffer, init: { status?: number; type?: string; length?: number } = {}) {
  const headers = new Headers({ 'content-type': init.type ?? 'text/html; charset=utf-8' });
  if (init.length !== undefined) headers.set('content-length', String(init.length));
  return new Response(corpo, { status: init.status ?? 200, headers });
}

describe('extensaoDe', () => {
  it('aceita só os formatos combinados, ignorando maiúsculas', () => {
    expect(extensaoDe('Preços.PDF')).toBe('.pdf');
    expect(extensaoDe('manual.docx')).toBe('.docx');
    expect(extensaoDe('dados.csv')).toBe('.csv');
    expect(extensaoDe('planilha.xlsx')).toBeNull();
    expect(extensaoDe('antigo.doc')).toBeNull();
    expect(extensaoDe('sem-extensao')).toBeNull();
  });
});

describe('createDocFromFile', () => {
  it('PDF com texto vira doc sourceType file, sourceRef = nome, título = nome sem extensão', async () => {
    const doc = await knowledgeService.createDocFromFile(ACCOUNT, BASE, {
      originalname: 'Tabela de Preços.pdf',
      buffer: pdfMinimo(PDF_LINHAS_PRECOS),
    });

    expect(prismaMock.knowledgeDoc.create).toHaveBeenCalledTimes(1);
    const { data } = prismaMock.knowledgeDoc.create.mock.calls[0][0];
    expect(data.accountId).toBe(ACCOUNT);
    expect(data.baseId).toBe(BASE);
    expect(data.sourceType).toBe('file');
    expect(data.sourceRef).toBe('Tabela de Preços.pdf');
    expect(data.title).toBe('Tabela de Preços');
    expect(data.status).toBe('pending');
    expect(data.content).toContain('Plano Pro custa R$ 890 por mes');
    expect(doc.id).toBe('doc-1');
  });

  it('título do body, quando vem, vence o nome do arquivo', async () => {
    await knowledgeService.createDocFromFile(
      ACCOUNT,
      BASE,
      { originalname: 'x.pdf', buffer: pdfMinimo(PDF_LINHAS_PRECOS) },
      '  Preços 2026  '
    );
    expect(prismaMock.knowledgeDoc.create.mock.calls[0][0].data.title).toBe('Preços 2026');
  });

  it('PDF sem texto: 422 e NENHUM doc criado', async () => {
    const err = await knowledgeService
      .createDocFromFile(ACCOUNT, BASE, { originalname: 'scan.pdf', buffer: pdfMinimo([]) })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DocumentoIlegivelError);
    expect((err as DocumentoIlegivelError).statusCode).toBe(422);
    expect((err as Error).message).toBe(
      'PDF sem texto (provavelmente escaneado). Não é lido: converta pra texto ou cole o conteúdo.'
    );
    expect(prismaMock.knowledgeDoc.create).not.toHaveBeenCalled();
  });

  it('Word .docx vira texto', async () => {
    await knowledgeService.createDocFromFile(ACCOUNT, BASE, {
      originalname: 'manual.docx',
      buffer: docxMinimo(),
    });
    const { data } = prismaMock.knowledgeDoc.create.mock.calls[0][0];
    expect(data.content).toContain('Horário de atendimento: 8h às 18h.');
    expect(data.sourceType).toBe('file');
  });

  it('texto puro (.md/.csv/.txt) entra como está, sem BOM', async () => {
    await knowledgeService.createDocFromFile(ACCOUNT, BASE, {
      originalname: 'faq.md',
      buffer: Buffer.from('﻿# FAQ\n\nComo cancelo?\n', 'utf8'),
    });
    expect(prismaMock.knowledgeDoc.create.mock.calls[0][0].data.content).toBe('# FAQ\n\nComo cancelo?');
  });

  it('arquivo de texto vazio é 422, não doc vazio', async () => {
    await expect(
      knowledgeService.createDocFromFile(ACCOUNT, BASE, { originalname: 'vazio.txt', buffer: Buffer.from('  \n') })
    ).rejects.toBeInstanceOf(DocumentoIlegivelError);
    expect(prismaMock.knowledgeDoc.create).not.toHaveBeenCalled();
  });

  it('extensão fora da lista é 400 com os formatos aceitos', async () => {
    const err = await knowledgeService
      .createDocFromFile(ACCOUNT, BASE, { originalname: 'planilha.xlsx', buffer: Buffer.from('x') })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect((err as Error).message).toContain('.pdf, .docx');
    expect((err as Error).message).toContain('CSV');
  });

  it('conteúdo acima de 400 mil caracteres é 422 dizendo o limite', async () => {
    const err = await knowledgeService
      .createDocFromFile(ACCOUNT, BASE, { originalname: 'gigante.txt', buffer: Buffer.from('a'.repeat(400_001)) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentoIlegivelError);
    expect((err as Error).message).toContain('400.000');
    expect(prismaMock.knowledgeDoc.create).not.toHaveBeenCalled();
  });

  it('base de outra conta: 404 antes de ler o arquivo', async () => {
    prismaMock.knowledgeBase.findFirst.mockResolvedValue(null);
    await expect(
      knowledgeService.createDocFromFile('outra-conta', BASE, { originalname: 'x.pdf', buffer: pdfMinimo(PDF_LINHAS_PRECOS) })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(prismaMock.knowledgeBase.findFirst).toHaveBeenCalledWith({ where: { id: BASE, accountId: 'outra-conta' } });
    expect(prismaMock.knowledgeDoc.create).not.toHaveBeenCalled();
  });
});

describe('createDocFromUrl', () => {
  // IP público reservado pra documentação (TEST-NET-3): passa no guard sem DNS.
  const URL_PUBLICA = 'http://203.0.113.10/planos';

  it.each(['http://127.0.0.1/admin', 'http://10.0.0.5/', 'http://localhost:3000/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/'])(
    'endereço interno %s é recusado pelo safeFetch sem nenhum fetch',
    async (url) => {
      const err = await knowledgeService.createDocFromUrl(ACCOUNT, BASE, url).catch((e: unknown) => e);

      expect(err).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      expect((err as Error).message).toContain('rede interna');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(prismaMock.knowledgeDoc.create).not.toHaveBeenCalled();
    }
  );

  it('endereço sem http(s) ou malformado é 400', async () => {
    await expect(knowledgeService.createDocFromUrl(ACCOUNT, BASE, 'ftp://x.com/a')).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    await expect(knowledgeService.createDocFromUrl(ACCOUNT, BASE, 'planos da empresa')).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('página HTML vira doc sourceType url, título do <title>, sem script/nav', async () => {
    fetchMock.mockResolvedValue(
      respostaHttp(
        '<html><head><title>Planos — Mychooice</title><script>x()</script></head><body><nav>menu</nav><h1>Planos</h1><p>Essencial custa R$ 500.</p></body></html>'
      )
    );

    await knowledgeService.createDocFromUrl(ACCOUNT, BASE, URL_PUBLICA);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(URL_PUBLICA);
    // safeFetch segue redirect à mão, revalidando cada destino.
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
    const { data } = prismaMock.knowledgeDoc.create.mock.calls[0][0];
    expect(data.sourceType).toBe('url');
    expect(data.sourceRef).toBe(URL_PUBLICA);
    expect(data.title).toBe('Planos — Mychooice');
    expect(data.content).toBe('Planos\n\nEssencial custa R$ 500.');
  });

  it('redirect pra rede interna é bloqueado no segundo salto', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
    );

    const err = await knowledgeService.createDocFromUrl(ACCOUNT, BASE, URL_PUBLICA).catch((e: unknown) => e);

    expect(err).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect((err as Error).message).toContain('rede interna');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeDoc.create).not.toHaveBeenCalled();
  });

  it('página sem texto útil é 422 e não cria doc', async () => {
    fetchMock.mockResolvedValue(respostaHttp('<html><body><script>app()</script><div id="root"></div></body></html>'));

    const err = await knowledgeService.createDocFromUrl(ACCOUNT, BASE, URL_PUBLICA).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DocumentoIlegivelError);
    expect((err as Error).message).toContain('não tem texto legível');
    expect(prismaMock.knowledgeDoc.create).not.toHaveBeenCalled();
  });

  it('HTTP de erro (404) é 422 legível', async () => {
    fetchMock.mockResolvedValue(respostaHttp('nada', { status: 404 }));
    const err = await knowledgeService.createDocFromUrl(ACCOUNT, BASE, URL_PUBLICA).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentoIlegivelError);
    expect((err as Error).message).toContain('HTTP 404');
  });

  it('resposta que não é texto (imagem) é 422', async () => {
    fetchMock.mockResolvedValue(respostaHttp(Buffer.from([0xff, 0xd8]), { type: 'image/jpeg' }));
    await expect(knowledgeService.createDocFromUrl(ACCOUNT, BASE, URL_PUBLICA)).rejects.toBeInstanceOf(DocumentoIlegivelError);
  });

  it('página acima de 2 MB é recusada pelo content-length e também pelo corpo real', async () => {
    fetchMock.mockResolvedValueOnce(respostaHttp('<p>x</p>', { length: 3 * 1024 * 1024 }));
    await expect(knowledgeService.createDocFromUrl(ACCOUNT, BASE, URL_PUBLICA)).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining('2 MB'),
    });

    // content-length ausente e corpo grande de verdade
    fetchMock.mockResolvedValueOnce(respostaHttp('<p>' + 'a'.repeat(2 * 1024 * 1024 + 10) + '</p>'));
    await expect(knowledgeService.createDocFromUrl(ACCOUNT, BASE, URL_PUBLICA)).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining('2 MB'),
    });
    expect(prismaMock.knowledgeDoc.create).not.toHaveBeenCalled();
  });

  it('PDF servido por URL passa pelo extrator de PDF', async () => {
    fetchMock.mockResolvedValue(respostaHttp(pdfMinimo(PDF_LINHAS_PRECOS), { type: 'application/pdf' }));

    await knowledgeService.createDocFromUrl(ACCOUNT, BASE, URL_PUBLICA, 'Tabela');

    const { data } = prismaMock.knowledgeDoc.create.mock.calls[0][0];
    expect(data.content).toContain('Plano Essencial custa R$ 500 por mes.');
    expect(data.title).toBe('Tabela');
    expect(data.sourceType).toBe('url');
  });

  it('texto puro (text/plain) entra como está', async () => {
    fetchMock.mockResolvedValue(respostaHttp('Horário: 8h às 18h.\n\nFechado domingo.', { type: 'text/plain' }));
    await knowledgeService.createDocFromUrl(ACCOUNT, BASE, URL_PUBLICA);
    const { data } = prismaMock.knowledgeDoc.create.mock.calls[0][0];
    expect(data.content).toBe('Horário: 8h às 18h.\n\nFechado domingo.');
    // Sem <title>, o título é o host.
    expect(data.title).toBe('203.0.113.10');
  });

  it('base de outra conta: 404 antes de qualquer fetch', async () => {
    prismaMock.knowledgeBase.findFirst.mockResolvedValue(null);
    await expect(knowledgeService.createDocFromUrl('outra', BASE, URL_PUBLICA)).rejects.toMatchObject({ statusCode: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
