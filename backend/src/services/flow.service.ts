/**
 * T-028 Fase 2 — fluxo de atendimento: gatilho, agrupamento e execução.
 *
 * O corte do n8n acontece aqui. Três estados de fluxo, e a ordem importa:
 *   draft  → não roda.
 *   shadow → roda inteiro e grava tudo, mas não envia nem altera nada.
 *   active → age de verdade.
 *
 * O caminho recomendado é ligar em `shadow`, deixar rodando em paralelo com o
 * n8n por alguns dias comparando as execuções, e só então virar pra `active`.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors';
import { executeRun, parseGraph, validateGraph } from './flow/engine';
import type { BufferedMessage, FlowGraph, FlowStatus } from './flow/types';

/** Janela de agrupamento padrão quando o fluxo não tem nó de debounce. */
const DEFAULT_DEBOUNCE_SECONDS = 0;
/** Teto da janela — protege contra alguém configurar 1h sem querer. */
const MAX_DEBOUNCE_SECONDS = 300;
const MAX_RUNS_PER_TICK = 5;
/** Acima disso, um run em 'running' é órfão de restart, não trabalho em curso. */
const STALE_RUNNING_MS = 10 * 60 * 1000;
/** Mensagens guardadas por run — conversa muito longa não pode estourar o contexto. */
const MAX_BUFFERED = 30;

export interface UpsertFlowInput {
  name: string;
  description?: string | null;
  graph: FlowGraph;
  inboxIds?: string[] | null;
}

export interface InboundMessageEvent {
  accountId: string;
  conversationId: string;
  inboxId: string;
  messageId: string;
  content: string | null;
  contentType: string;
}

class FlowService {
  // ============================================
  // CRUD
  // ============================================

  async list(accountId: string) {
    const flows = await prisma.flow.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { runs: true } } },
    });
    return flows.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      status: f.status,
      version: f.version,
      inboxIds: f.inboxIds,
      runCount: f._count.runs,
      nodeCount: parseGraph(f.graph).nodes.length,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    }));
  }

  async get(accountId: string, id: string) {
    const flow = await prisma.flow.findFirst({ where: { id, accountId } });
    if (!flow) throw new NotFoundError('Fluxo');
    return flow;
  }

  async create(accountId: string, input: UpsertFlowInput) {
    const name = input.name?.trim();
    if (!name) throw new ValidationError('Nome do fluxo é obrigatório');

    const clash = await prisma.flow.findFirst({ where: { accountId, name } });
    if (clash) throw new ConflictError(`Já existe um fluxo chamado "${name}"`);

    return prisma.flow.create({
      data: {
        accountId,
        name,
        description: input.description?.trim() || null,
        graph: input.graph as unknown as Prisma.InputJsonValue,
        inboxIds: (input.inboxIds ?? null) as unknown as Prisma.InputJsonValue,
        status: 'draft',
      },
    });
  }

  async update(accountId: string, id: string, input: Partial<UpsertFlowInput>) {
    const current = await this.get(accountId, id);
    const data: Prisma.FlowUpdateInput = {};

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new ValidationError('Nome do fluxo é obrigatório');
      const clash = await prisma.flow.findFirst({
        where: { accountId, name, id: { not: id } },
      });
      if (clash) throw new ConflictError(`Já existe um fluxo chamado "${name}"`);
      data.name = name;
    }
    if (input.description !== undefined) data.description = input.description?.trim() || null;
    if (input.inboxIds !== undefined) {
      data.inboxIds = (input.inboxIds ?? null) as unknown as Prisma.InputJsonValue;
    }
    if (input.graph !== undefined) {
      data.graph = input.graph as unknown as Prisma.InputJsonValue;
      // Toda alteração do desenho incrementa a versão — é o que permite saber
      // qual desenho produziu uma execução antiga.
      data.version = current.version + 1;
    }

    return prisma.flow.update({ where: { id }, data });
  }

  async delete(accountId: string, id: string) {
    await this.get(accountId, id);
    await prisma.flow.delete({ where: { id } });
  }

  /**
   * Troca o estado do fluxo. Ativar (ou ligar em sombra) valida o grafo antes:
   * é melhor recusar com a lista de problemas do que deixar o atendimento
   * parar no meio sem ninguém entender por quê.
   */
  async setStatus(accountId: string, id: string, status: FlowStatus) {
    const flow = await this.get(accountId, id);

    if (status === 'active' || status === 'shadow') {
      const erros = validateGraph(parseGraph(flow.graph));
      if (erros.length > 0) {
        throw new ValidationError(`O fluxo tem problemas: ${erros.join(' ')}`);
      }
      // Só um fluxo agindo por vez na conta — dois fluxos ativos responderiam
      // o mesmo lead duas vezes.
      if (status === 'active') {
        await prisma.flow.updateMany({
          where: { accountId, status: 'active', id: { not: id } },
          data: { status: 'draft' },
        });
      }
    }

    return prisma.flow.update({ where: { id }, data: { status } });
  }

  // ============================================
  // Gatilho
  // ============================================

  /**
   * Chamado quando o lead manda mensagem. NÃO bloqueia o webhook da Evolution:
   * cria/atualiza o run e volta na hora; quem executa é o worker.
   *
   * O agrupamento vive aqui: cada mensagem nova empurra `runAfter` pra frente,
   * então o fluxo só roda quando o lead para de digitar. É o mesmo efeito do
   * Redis no n8n, mas sobrevive a restart porque o estado está no banco.
   */
  async onInboundMessage(evt: InboundMessageEvent): Promise<void> {
    const flow = await prisma.flow.findFirst({
      where: { accountId: evt.accountId, status: { in: ['active', 'shadow'] } },
      orderBy: { updatedAt: 'desc' },
    });
    if (!flow) return;

    // Fluxo restrito a certos inboxes.
    const inboxIds = Array.isArray(flow.inboxIds) ? (flow.inboxIds as string[]) : null;
    if (inboxIds && inboxIds.length > 0 && !inboxIds.includes(evt.inboxId)) return;

    const graph = parseGraph(flow.graph);
    const debounce = graph.nodes.find((n) => n.type === 'buffer.debounce');
    const segundos = Math.min(
      Math.max(Number((debounce?.config as { segundos?: number })?.segundos ?? DEFAULT_DEBOUNCE_SECONDS), 0),
      MAX_DEBOUNCE_SECONDS
    );
    const runAfter = new Date(Date.now() + segundos * 1000);

    const mensagem: BufferedMessage = {
      id: evt.messageId,
      content: evt.content,
      contentType: evt.contentType,
      createdAt: new Date().toISOString(),
    };

    const anexado = await this.anexarAoRunAberto(evt.conversationId, mensagem, runAfter);
    if (anexado) return;

    try {
      await prisma.flowRun.create({
        data: {
          accountId: evt.accountId,
          flowId: flow.id,
          conversationId: evt.conversationId,
          status: 'buffering',
          runAfter,
          shadow: flow.status === 'shadow',
          context: { mensagens: [mensagem] } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // P2002 no índice único parcial = outra mensagem criou o run entre o
      // nosso findFirst e o insert. Agrupa nele em vez de duplicar.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        await this.anexarAoRunAberto(evt.conversationId, mensagem, runAfter);
        return;
      }
      throw err;
    }
  }

  private async anexarAoRunAberto(
    conversationId: string,
    mensagem: BufferedMessage,
    runAfter: Date
  ): Promise<boolean> {
    const aberto = await prisma.flowRun.findFirst({
      where: { conversationId, status: 'buffering' },
      select: { id: true, context: true },
    });
    if (!aberto) return false;

    const ctx = (aberto.context ?? {}) as { mensagens?: BufferedMessage[] };
    const mensagens = [...(ctx.mensagens ?? []), mensagem].slice(-MAX_BUFFERED);

    await prisma.flowRun.update({
      where: { id: aberto.id },
      data: {
        runAfter,
        context: { ...ctx, mensagens } as unknown as Prisma.InputJsonValue,
      },
    });
    return true;
  }

  // ============================================
  // Worker
  // ============================================

  /** Devolve à fila runs travados em 'running' por restart no meio da execução. */
  private async resgatarOrfaos(): Promise<void> {
    const corte = new Date(Date.now() - STALE_RUNNING_MS);
    const { count } = await prisma.flowRun.updateMany({
      where: { status: 'running', startedAt: { lt: corte } },
      data: { status: 'failed', error: 'Interrompido por reinício do servidor' },
    });
    if (count > 0) {
      logger.warn('[flow] runs órfãos marcados como falha', { count });
    }
  }

  /**
   * Executa os runs cuja janela de agrupamento venceu.
   * Chamado pelo cron do server.ts.
   */
  async processDueRuns(limit = MAX_RUNS_PER_TICK): Promise<{ ok: number; failed: number }> {
    await this.resgatarOrfaos();

    const vencidos = await prisma.flowRun.findMany({
      where: { status: 'buffering', runAfter: { lte: new Date() } },
      orderBy: { runAfter: 'asc' },
      take: limit,
      select: { id: true },
    });

    let ok = 0;
    let failed = 0;

    for (const { id } of vencidos) {
      // Claim atômico: impede duas réplicas de executarem o mesmo atendimento
      // (que responderia o lead duas vezes).
      const claimed = await prisma.flowRun.updateMany({
        where: { id, status: 'buffering' },
        data: { status: 'running', startedAt: new Date() },
      });
      if (claimed.count === 0) continue;

      try {
        await this.runOne(id);
        ok++;
      } catch (err) {
        failed++;
        const mensagem = err instanceof Error ? err.message : String(err);
        logger.warn('[flow] execução falhou', { runId: id, error: mensagem });
        await prisma.flowRun
          .update({
            where: { id },
            data: { status: 'failed', error: mensagem.slice(0, 2000), finishedAt: new Date() },
          })
          .catch(() => undefined);
      }
    }

    return { ok, failed };
  }

  private async runOne(runId: string): Promise<void> {
    const run = await prisma.flowRun.findUnique({
      where: { id: runId },
      include: { flow: true },
    });
    if (!run) return;

    // O fluxo pode ter sido despublicado enquanto o run esperava na janela.
    if (run.flow.status === 'draft') {
      await prisma.flowRun.update({
        where: { id: runId },
        data: { status: 'skipped', stopReason: 'fluxo_despublicado', finishedAt: new Date() },
      });
      return;
    }

    // DUAS MEMÓRIAS, e a distinção é o que impede o agente de perder contexto:
    //
    //   memoria (LONGO PRAZO) — fica no CONTATO. Fatos sobre a pessoa, que
    //     valem entre conversas. O lead que sumiu e voltou em março continua
    //     com o mesmo faturamento; se isso morasse na conversa, sumiria junto
    //     com ela ao ser resolvida.
    //   sessao (CURTO PRAZO)  — fica na CONVERSA. Onde paramos no roteiro.
    //     Morre com a conversa, e é isso que se quer.
    const conversa = await prisma.conversation.findFirst({
      where: { id: run.conversationId, accountId: run.accountId },
      select: { customAttributes: true, contactId: true },
    });
    const sessao = (conversa?.customAttributes ?? {}) as Record<string, unknown>;

    let memoria: Record<string, unknown> = {};
    if (conversa?.contactId) {
      const contato = await prisma.contact.findFirst({
        where: { id: conversa.contactId, accountId: run.accountId },
        select: { customAttributes: true },
      });
      memoria = (contato?.customAttributes ?? {}) as Record<string, unknown>;
    }

    const resultado = await executeRun({
      runId,
      accountId: run.accountId,
      flowId: run.flowId,
      conversationId: run.conversationId,
      shadow: run.shadow,
      graph: parseGraph(run.flow.graph),
      vars: {
        ...((run.context ?? {}) as Record<string, unknown>),
        memoria,
        sessao,
        __contactId: conversa?.contactId ?? null,
      },
    });

    // Nada disso vai pro contexto salvo: `__edges`/`__contactId` são controle
    // interno do motor, e as duas memórias têm dono próprio (contato e
    // conversa). Duplicar criaria uma segunda verdade que diverge.
    const {
      __edges: _edges,
      __contactId: _contact,
      memoria: _memoria,
      sessao: _sessao,
      ...contexto
    } = resultado.vars;

    await prisma.flowRun.update({
      where: { id: runId },
      data: {
        status: resultado.status,
        stopReason: resultado.stopReason?.slice(0, 80) ?? null,
        error: resultado.error?.slice(0, 2000) ?? null,
        context: contexto as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
  }

  // ============================================
  // Execuções (a tela que substitui o Executions do n8n)
  // ============================================

  async listRuns(
    accountId: string,
    filtros: { flowId?: string; status?: string; limit?: number } = {}
  ) {
    return prisma.flowRun.findMany({
      where: {
        accountId,
        ...(filtros.flowId ? { flowId: filtros.flowId } : {}),
        ...(filtros.status ? { status: filtros.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filtros.limit ?? 50, 200),
      select: {
        id: true,
        flowId: true,
        conversationId: true,
        status: true,
        shadow: true,
        stopReason: true,
        error: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
        flow: { select: { name: true } },
        _count: { select: { steps: true } },
      },
    });
  }

  async getRun(accountId: string, runId: string) {
    const run = await prisma.flowRun.findFirst({
      where: { id: runId, accountId },
      include: {
        flow: { select: { name: true, status: true } },
        steps: { orderBy: { ordem: 'asc' } },
      },
    });
    if (!run) throw new NotFoundError('Execução');
    return run;
  }
}

export const flowService = new FlowService();
