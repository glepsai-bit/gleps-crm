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

export type DocStatus = 'pending' | 'indexing' | 'ready' | 'failed';
export type DocSourceType = 'text' | 'file' | 'url';

const MAX_CONTENT_CHARS = 400_000;
const MAX_DOCS_PER_TICK = 3;

export interface CreateBaseInput {
  name: string;
  description?: string | null;
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
      data: { accountId, name, description: input.description?.trim() || null },
    });
  }

  async updateBase(accountId: string, id: string, input: Partial<CreateBaseInput>) {
    await this.getBaseOrThrow(accountId, id);

    const data: { name?: string; description?: string | null } = {};
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

  /** Indexação de um doc já reclamado. Idempotente: apaga e regrava os trechos. */
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

    const { vectors, tokens } = await embed(
      doc.accountId,
      chunks.map((c) => c.content)
    );

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
