/**
 * T-027 Fase 1 — base de conhecimento (RAG) do atendimento IA.
 *
 * O admin cola/sobe o material do negócio; a indexação (quebra em trechos +
 * embedding) roda ASSÍNCRONA num worker. Assíncrona porque indexar um documento
 * grande leva dezenas de segundos de chamada de API — fazer isso dentro do
 * request faria a tela dar timeout e perderia o trabalho já feito.
 */

import { prisma } from '../config/database';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors';
import { logger } from '../utils/logger';
import { chunkText, estimateTokens } from './ai/knowledge-chunker';
import { embed } from './ai/embeddings';
import { invalidateBase } from './ai/knowledge-index';
import { chat } from './ai/chat';
import {
  DocumentoIlegivelError,
  extrairDocx,
  extrairHtml,
  extrairPdf,
  limparTexto,
} from './ai/extrair-texto';
import { safeFetch } from '../utils/ssrf-guard';

export type DocStatus = 'pending' | 'indexing' | 'ready' | 'failed';
export type DocSourceType = 'text' | 'file' | 'url';

const MAX_CONTENT_CHARS = 400_000;
const MAX_DOCS_PER_TICK = 3;
/** Página importada por URL: acima disso é dump de dados, não conteúdo de atendimento. */
const MAX_URL_BYTES = 2 * 1024 * 1024;
const URL_TIMEOUT_MS = 15_000;

/**
 * Formatos aceitos no upload. Planilha (.xlsx) não entra: o navegador converte
 * pra CSV antes de enviar, e CSV já é texto. PDF escaneado é recusado na
 * extração — não há OCR, e um doc vazio na base só engana.
 */
export const EXTENSOES_ACEITAS = ['.pdf', '.docx', '.txt', '.md', '.csv', '.json'] as const;
export type ExtensaoAceita = (typeof EXTENSOES_ACEITAS)[number];

export interface ArquivoEnviado {
  /** Nome original, com extensão — decide o extrator e vira sourceRef. */
  originalname: string;
  buffer: Buffer;
}

export function extensaoDe(nome: string): ExtensaoAceita | null {
  const m = /\.([a-z0-9]+)$/i.exec(nome.trim());
  const ext = m ? `.${m[1].toLowerCase()}` : '';
  return (EXTENSOES_ACEITAS as readonly string[]).includes(ext) ? (ext as ExtensaoAceita) : null;
}

function tituloDoArquivo(nome: string): string {
  return nome.replace(/\.[a-z0-9]+$/i, '').trim() || nome;
}

function excedeLimite(content: string): never {
  throw new DocumentoIlegivelError(
    `O conteúdo tem ${content.length.toLocaleString('pt-BR')} caracteres; o limite por documento é ` +
      `${MAX_CONTENT_CHARS.toLocaleString('pt-BR')}. Divida em partes menores.`
  );
}
/** Acima disso, um doc em 'indexing' é considerado órfão de restart, não trabalho em curso. */
const STALE_INDEXING_MS = 15 * 60 * 1000;

export interface CreateBaseInput {
  name: string;
  description?: string | null;
  /**
   * Quem é o negócio. Vai SEMPRE no prompt de qualquer agente ligado nesta
   * base — diferente da descrição, que é rótulo para humano escolher a base.
   */
  businessContext?: string | null;
}

export interface CreateDocInput {
  title: string;
  content: string;
  sourceType?: DocSourceType;
  sourceRef?: string | null;
}

class KnowledgeService {
  // ============================================
  // Bases
  // ============================================

  async listBases(accountId: string) {
    const bases = await prisma.knowledgeBase.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { docs: true, chunks: true } } },
    });
    return bases.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      businessContext: b.businessContext,
      docCount: b._count.docs,
      chunkCount: b._count.chunks,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }));
  }

  async createBase(accountId: string, input: CreateBaseInput) {
    const name = input.name?.trim();
    if (!name) throw new ValidationError('Nome da base é obrigatório');

    const existing = await prisma.knowledgeBase.findFirst({ where: { accountId, name } });
    if (existing) throw new ConflictError(`Já existe uma base chamada "${name}"`);

    return prisma.knowledgeBase.create({
      data: {
        accountId,
        name,
        description: input.description?.trim() || null,
        businessContext: input.businessContext?.trim() || null,
      },
    });
  }

  async updateBase(accountId: string, id: string, input: Partial<CreateBaseInput>) {
    await this.getBaseOrThrow(accountId, id);

    const data: {
      name?: string;
      description?: string | null;
      businessContext?: string | null;
    } = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new ValidationError('Nome da base é obrigatório');
      const clash = await prisma.knowledgeBase.findFirst({
        where: { accountId, name, id: { not: id } },
      });
      if (clash) throw new ConflictError(`Já existe uma base chamada "${name}"`);
      data.name = name;
    }
    if (input.description !== undefined) data.description = input.description?.trim() || null;
    if (input.businessContext !== undefined) {
      data.businessContext = input.businessContext?.trim() || null;
    }

    const updated = await prisma.knowledgeBase.update({ where: { id }, data });
    invalidateBase(accountId, id);
    return updated;
  }

  async deleteBase(accountId: string, id: string) {
    await this.getBaseOrThrow(accountId, id);
    // Docs e chunks caem por cascade; agentes que apontavam pra base ficam com
    // knowledgeBaseId = null (SET NULL) e seguem funcionando sem RAG.
    await prisma.knowledgeBase.delete({ where: { id } });
    invalidateBase(accountId, id);
  }

  private async getBaseOrThrow(accountId: string, id: string) {
    const base = await prisma.knowledgeBase.findFirst({ where: { id, accountId } });
    if (!base) throw new NotFoundError('Base de conhecimento');
    return base;
  }

  // ============================================
  // Documentos
  // ============================================

  async listDocs(accountId: string, baseId: string) {
    await this.getBaseOrThrow(accountId, baseId);
    return prisma.knowledgeDoc.findMany({
      where: { accountId, baseId },
      orderBy: { createdAt: 'desc' },
      // `content` fica de fora: a listagem carregaria centenas de KB por doc
      // sem que a tela use o texto.
      select: {
        id: true,
        title: true,
        // O que a tela mostra como "cobre:" — é a linha que vai pro índice do
        // agente, então o usuário precisa ver e poder conferir.
        summary: true,
        sourceType: true,
        sourceRef: true,
        status: true,
        error: true,
        chunkCount: true,
        tokens: true,
        indexedAt: true,
        createdAt: true,
      },
    });
  }

  async getDoc(accountId: string, docId: string) {
    const doc = await prisma.knowledgeDoc.findFirst({ where: { id: docId, accountId } });
    if (!doc) throw new NotFoundError('Documento');
    return doc;
  }

  async createDoc(accountId: string, baseId: string, input: CreateDocInput) {
    await this.getBaseOrThrow(accountId, baseId);

    const title = input.title?.trim();
    const content = input.content?.trim();
    if (!title) throw new ValidationError('Título do documento é obrigatório');
    if (!content) throw new ValidationError('Conteúdo do documento é obrigatório');
    if (content.length > MAX_CONTENT_CHARS) {
      throw new ValidationError(
        `Documento tem ${content.length} caracteres; o limite é ${MAX_CONTENT_CHARS}. Divida em documentos menores.`
      );
    }

    return prisma.knowledgeDoc.create({
      data: {
        accountId,
        baseId,
        title,
        content,
        sourceType: input.sourceType ?? 'text',
        sourceRef: input.sourceRef?.trim() || null,
        status: 'pending',
      },
    });
  }

  /**
   * Upload de arquivo → texto → doc. A extração mora em ai/extrair-texto; aqui
   * só se escolhe o extrator pela extensão e se aplica o limite de tamanho
   * ANTES de gravar, pra nunca nascer doc vazio ou truncado.
   */
  async createDocFromFile(
    accountId: string,
    baseId: string,
    arquivo: ArquivoEnviado,
    title?: string | null
  ) {
    await this.getBaseOrThrow(accountId, baseId);

    const ext = extensaoDe(arquivo.originalname);
    if (!ext) {
      throw new ValidationError(
        `Formato não aceito. Envie ${EXTENSOES_ACEITAS.join(', ')} (planilha: exporte como CSV).`
      );
    }

    let content: string;
    if (ext === '.pdf') {
      content = await extrairPdf(arquivo.buffer);
    } else if (ext === '.docx') {
      content = await extrairDocx(arquivo.buffer);
    } else {
      content = limparTexto(arquivo.buffer.toString('utf8').replace(/^\uFEFF/, ''));
      if (!content) {
        throw new DocumentoIlegivelError('O arquivo está vazio. Envie um arquivo com texto.');
      }
    }
    if (content.length > MAX_CONTENT_CHARS) excedeLimite(content);

    return this.createDoc(accountId, baseId, {
      title: title?.trim() || tituloDoArquivo(arquivo.originalname),
      content,
      sourceType: 'file',
      sourceRef: arquivo.originalname,
    });
  }

  /**
   * Importa uma página pública. `safeFetch` é a proteção contra rede interna
   * (loopback, RFC1918, metadata da nuvem) — inclusive em redirect; sem ele um
   * tenant leria o que o servidor enxerga. Tamanho e tempo têm teto porque a
   * requisição segura a tela do usuário enquanto baixa.
   */
  async createDocFromUrl(accountId: string, baseId: string, url: string, title?: string | null) {
    await this.getBaseOrThrow(accountId, baseId);

    const urlLimpa = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(urlLimpa);
    } catch {
      throw new ValidationError('Endereço inválido. Use o link completo, começando com https://');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ValidationError('Endereço inválido. Use o link completo, começando com https://');
    }

    const { corpo, contentType } = await this.baixarPagina(urlLimpa);

    let content: string;
    if (contentType.includes('pdf')) {
      content = await extrairPdf(corpo);
    } else if (contentType.includes('html') || /^\s*<(!doctype|html)/i.test(corpo.toString('utf8', 0, 512))) {
      content = extrairHtml(corpo.toString('utf8'));
    } else if (contentType.startsWith('text/') || contentType.includes('json')) {
      content = limparTexto(corpo.toString('utf8'));
    } else {
      throw new DocumentoIlegivelError(
        `A página devolveu "${contentType || 'tipo desconhecido'}", que não é texto. Envie o arquivo pelo upload ou cole o conteúdo.`
      );
    }

    if (!content) {
      throw new DocumentoIlegivelError(
        'A página não tem texto legível (conteúdo carregado por script ou vazio). Cole o conteúdo ou use outra página.'
      );
    }
    if (content.length > MAX_CONTENT_CHARS) excedeLimite(content);

    return this.createDoc(accountId, baseId, {
      title: title?.trim() || this.tituloDaPagina(corpo, contentType) || parsed.hostname,
      content,
      sourceType: 'url',
      sourceRef: urlLimpa,
    });
  }

  private tituloDaPagina(corpo: Buffer, contentType: string): string | null {
    if (!contentType.includes('html')) return null;
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(corpo.toString('utf8', 0, 64 * 1024));
    const t = m ? limparTexto(m[1]).replace(/\s+/g, ' ') : '';
    return t ? t.slice(0, 300) : null;
  }

  private async baixarPagina(url: string): Promise<{ corpo: Buffer; contentType: string }> {
    let res: Response;
    try {
      res = await safeFetch(url, {
        signal: AbortSignal.timeout(URL_TIMEOUT_MS),
        headers: {
          Accept: 'text/html, text/plain, application/pdf;q=0.9, */*;q=0.5',
          'User-Agent': 'GLEPS-CRM/1.0 (importador de base de conhecimento)',
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('SSRF guard')) {
        throw new ValidationError('Endereço não permitido: aponta para a rede interna do servidor.');
      }
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new DocumentoIlegivelError(
          `A página demorou mais de ${URL_TIMEOUT_MS / 1000}s para responder. Tente de novo ou cole o conteúdo.`
        );
      }
      logger.warn('[knowledge] falha ao baixar URL', { url, error: msg });
      throw new DocumentoIlegivelError(
        'Não consegui acessar a página (endereço fora do ar ou inexistente). Confira o link ou cole o conteúdo.'
      );
    }

    if (!res.ok) {
      throw new DocumentoIlegivelError(
        `A página respondeu com erro HTTP ${res.status}. Confira se o link é público ou cole o conteúdo.`
      );
    }

    const declarado = Number(res.headers.get('content-length') ?? 0);
    if (declarado > MAX_URL_BYTES) {
      throw new DocumentoIlegivelError(
        `A página tem ${(declarado / 1024 / 1024).toFixed(1)} MB; o limite é 2 MB. Cole só a parte que interessa.`
      );
    }

    // Lê em pedaços e para no teto: content-length pode faltar ou mentir.
    const partes: Buffer[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_URL_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new DocumentoIlegivelError(
            'A página passa de 2 MB. Cole só a parte que interessa ou envie como arquivo.'
          );
        }
        partes.push(Buffer.from(value));
      }
    }

    return {
      corpo: Buffer.concat(partes),
      contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
    };
  }

  async updateDoc(accountId: string, docId: string, input: Partial<CreateDocInput>) {
    const doc = await this.getDoc(accountId, docId);

    const data: Record<string, unknown> = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new ValidationError('Título do documento é obrigatório');
      data.title = title;
    }
    if (input.content !== undefined) {
      const content = input.content.trim();
      if (!content) throw new ValidationError('Conteúdo do documento é obrigatório');
      if (content.length > MAX_CONTENT_CHARS) {
        throw new ValidationError(`Documento excede ${MAX_CONTENT_CHARS} caracteres.`);
      }
      data.content = content;
      // Conteúdo novo invalida os trechos antigos: volta pra fila.
      data.status = 'pending';
      data.error = null;
    }

    const updated = await prisma.knowledgeDoc.update({ where: { id: docId }, data });
    invalidateBase(accountId, doc.baseId);
    return updated;
  }

  async deleteDoc(accountId: string, docId: string) {
    const doc = await this.getDoc(accountId, docId);
    await prisma.knowledgeDoc.delete({ where: { id: docId } });
    invalidateBase(accountId, doc.baseId);
  }

  /** Recoloca na fila (após corrigir a chave de API, por exemplo). */
  async reindexDoc(accountId: string, docId: string) {
    const doc = await this.getDoc(accountId, docId);
    return prisma.knowledgeDoc.update({
      where: { id: doc.id },
      data: { status: 'pending', error: null },
    });
  }

  // ============================================
  // Worker de indexação
  // ============================================

  /**
   * Processa documentos pendentes. Chamado pelo cron do server.ts.
   *
   * Cada doc é RECLAMADO com um updateMany condicional (pending → indexing):
   * é isso que impede duas réplicas de indexar o mesmo documento e gravar
   * chunks duplicados. O mutex do cron só protege dentro de um processo.
   */
  async processPendingDocs(limit = MAX_DOCS_PER_TICK): Promise<{ ok: number; failed: number }> {
    await this.requeueStaleIndexing();

    const candidates = await prisma.knowledgeDoc.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });

    let ok = 0;
    let failed = 0;

    for (const { id } of candidates) {
      const claimed = await prisma.knowledgeDoc.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'indexing' },
      });
      if (claimed.count === 0) continue; // outra réplica pegou primeiro

      try {
        await this.indexDoc(id);
        ok++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('[knowledge] falha ao indexar documento', { docId: id, error: message });
        await prisma.knowledgeDoc.update({
          where: { id },
          data: { status: 'failed', error: message.slice(0, 1000) },
        });
      }
    }

    return { ok, failed };
  }

  /**
   * Devolve pra fila documentos travados em 'indexing'.
   *
   * O claim pending→indexing não sobrevive a um restart: se o processo cai no
   * meio da indexação (deploy, OOM, Ctrl+C), o documento fica 'indexing' pra
   * sempre — a tela gira indefinidamente e a base nunca recebe os trechos, sem
   * nenhum erro em lugar nenhum. O corte por tempo é o que distingue "morto" de
   * "outra réplica está trabalhando nele agora": indexação real leva dezenas de
   * segundos, nunca 15 minutos.
   */
  private async requeueStaleIndexing(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_INDEXING_MS);
    const { count } = await prisma.knowledgeDoc.updateMany({
      where: { status: 'indexing', updatedAt: { lt: cutoff } },
      data: { status: 'pending' },
    });
    if (count > 0) {
      logger.warn('[knowledge] documentos travados em indexing devolvidos à fila', { count });
    }
  }

  /** Indexação de um doc já reclamado. Idempotente: apaga e regrava os trechos. */
  /**
   * Uma linha dizendo o que o documento cobre — vira item do índice da base.
   *
   * Nunca derruba a indexação: sem resumo o documento entra no índice só pelo
   * título, que já orienta. Falhar aqui e deixar o documento fora da base
   * seria trocar uma perda pequena por uma grande.
   */
  private async gerarSummary(
    accountId: string,
    title: string,
    content: string
  ): Promise<string | null> {
    try {
      const r = await chat({
        accountId,
        provider: 'openai',
        // Modelo padrão do provider: descrever assunto é tarefa barata.
        system:
          'Você recebe um documento interno de uma empresa. Responda com UMA frase, ' +
          'no máximo 20 palavras, dizendo QUE ASSUNTOS ele cobre — para servir de ' +
          'índice. Liste temas, não conclusões: "preços dos 3 planos e regras de ' +
          'desconto", não "os planos são caros". Sem preâmbulo, só a frase.',
        messages: [
          {
            role: 'user',
            // Trecho do começo basta: título e abertura dizem do que trata, e
            // mandar o documento inteiro custaria caro em base grande.
            content: `Título: ${title}\n\nInício do documento:\n${content.slice(0, 3000)}`,
          },
        ],
        maxTokens: 80,
      });
      const texto = r.text?.trim();
      return texto ? texto.slice(0, 300) : null;
    } catch (err) {
      logger.warn('[knowledge] não consegui resumir o documento; segue sem índice', {
        title,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async indexDoc(docId: string): Promise<void> {
    const doc = await prisma.knowledgeDoc.findUnique({ where: { id: docId } });
    if (!doc) return;

    const chunks = chunkText(doc.content);
    if (chunks.length === 0) {
      await prisma.knowledgeDoc.update({
        where: { id: docId },
        data: { status: 'ready', chunkCount: 0, tokens: 0, indexedAt: new Date(), error: null },
      });
      invalidateBase(doc.accountId, doc.baseId);
      return;
    }

    // Em paralelo: os vetores (obrigatórios) e o resumo de uma linha (opcional).
    // O resumo alimenta o índice que orienta o agente. Uma chamada barata por
    // documento, amortizada para sempre — o índice é lido em toda mensagem.
    const [{ vectors, tokens }, summary] = await Promise.all([
      embed(
        doc.accountId,
        chunks.map((c) => c.content)
      ),
      this.gerarSummary(doc.accountId, doc.title, doc.content),
    ]);

    // Transação: sem ela, uma falha entre o delete e o insert deixaria o doc
    // 'ready' com zero trechos — a IA responderia como se a base estivesse vazia.
    await prisma.$transaction([
      prisma.knowledgeChunk.deleteMany({ where: { docId } }),
      prisma.knowledgeChunk.createMany({
        data: chunks.map((c, i) => ({
          accountId: doc.accountId,
          baseId: doc.baseId,
          docId,
          ordem: c.ordem,
          content: c.content,
          embedding: vectors[i],
          tokens: c.tokens,
        })),
      }),
      prisma.knowledgeDoc.update({
        where: { id: docId },
        data: {
          status: 'ready',
          chunkCount: chunks.length,
          tokens: tokens || estimateTokens(doc.content),
          indexedAt: new Date(),
          error: null,
          // Só sobrescreve quando conseguiu gerar: falha no resumo não pode
          // apagar o que já servia de índice numa reindexação.
          ...(summary ? { summary } : {}),
        },
      }),
    ]);

    invalidateBase(doc.accountId, doc.baseId);
    logger.info('[knowledge] documento indexado', {
      docId,
      chunks: chunks.length,
      tokens,
    });
  }
}

export const knowledgeService = new KnowledgeService();
