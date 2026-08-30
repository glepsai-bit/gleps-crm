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
/** Nome do inbox reservado ao simulador. É a trava do reset. */
const INBOX_SIMULADOR = 'Simulador de atendimento';

/** Tira as chaves de controle interno (`_resumo_conversa`, `_simulador`). */
const semChavesInternas = (dados: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(dados ?? {}).filter(([k]) => !k.startsWith('_')));

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
    // CANCELAMENTO ESTRUTURAL DO FOLLOW-UP — a PRIMEIRA coisa que acontece.
    //
    // O lead respondeu: a cadência perdeu o propósito. Fazer disso uma
    // CONSEQUÊNCIA de a mensagem entrar — e não uma verificação lá na frente,
    // ao acordar — é o que impede o erro clássico de mandar "e aí, pensou na
    // proposta?" pra quem acabou de responder. Verificação alguém esquece de
    // escrever; consequência não tem como pular.
    //
    // Antes de QUALQUER saída antecipada desta função: sem fluxo publicado,
    // fluxo restrito a outro inbox, fluxo despublicado ontem — em todos esses
    // casos o follow-up velho continua tendo que morrer. Já errei isto uma vez
    // deixando a chamada depois do filtro de inbox.
    await this.cancelarFollowupPendente(evt.conversationId, 'lead_respondeu');

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

  /**
   * Mata o follow-up que dormia nesta conversa.
   *
   * `updateMany` condicionado a 'sleeping': se o worker acabou de reclamar o
   * run (já virou 'running'), o update não pega nada — e aí a guarda de
   * follow-up é a segunda rede, checando quem falou por último antes de
   * escrever. Duas barreiras porque a corrida é real: o lead pode responder no
   * exato segundo em que a cadência acorda.
   */
  private async cancelarFollowupPendente(conversationId: string, motivo: string): Promise<void> {
    const { count } = await prisma.flowRun.updateMany({
      where: { conversationId, status: 'sleeping' },
      data: {
        status: 'skipped',
        stopReason: motivo,
        runAfter: null,
        resumeNodeId: null,
        finishedAt: new Date(),
      },
    });
    if (count > 0) {
      logger.info('[flow] follow-up cancelado', { conversationId, motivo, count });
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

    // Dois motivos pra um run estar na fila, e o mesmo índice serve aos dois:
    //   buffering — a janela de agrupamento venceu (segundos).
    //   sleeping  — um follow-up marcado pra depois chegou a hora (dias).
    const vencidos = await prisma.flowRun.findMany({
      where: { status: { in: ['buffering', 'sleeping'] }, runAfter: { lte: new Date() } },
      orderBy: { runAfter: 'asc' },
      take: limit,
      select: { id: true, status: true },
    });

    let ok = 0;
    let failed = 0;

    for (const { id, status } of vencidos) {
      // Claim atômico: impede duas réplicas de executarem o mesmo atendimento
      // (que responderia o lead duas vezes). A condição é o status que ACABAMOS
      // de ler — se mudou nesse meio-tempo (o lead respondeu e cancelou o
      // follow-up), o claim falha e o run não roda, que é o certo.
      const claimed = await prisma.flowRun.updateMany({
        where: { id, status },
        data: {
          status: 'running',
          startedAt: new Date(),
          // Cada retomada é um toque da cadência. É este contador que permite
          // "pare no terceiro" — sem ele a cadência insiste pra sempre.
          ...(status === 'sleeping' ? { wakeCount: { increment: 1 } } : {}),
        },
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

  /**
   * Carrega as duas memórias de uma conversa. Usado pelo worker e pelo
   * simulador — se cada um montasse o contexto do seu jeito, o simulador
   * mostraria um atendimento diferente do que roda de verdade, que é
   * exatamente o que ele existe pra evitar.
   */
  private async carregarMemorias(accountId: string, conversationId: string) {
    const conversa = await prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { customAttributes: true, contactId: true },
    });
    const sessao = (conversa?.customAttributes ?? {}) as Record<string, unknown>;

    let memoria: Record<string, unknown> = {};
    if (conversa?.contactId) {
      const contato = await prisma.contact.findFirst({
        where: { id: conversa.contactId, accountId },
        select: { customAttributes: true },
      });
      memoria = (contato?.customAttributes ?? {}) as Record<string, unknown>;
    }
    return { memoria, sessao, contactId: conversa?.contactId ?? null };
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
    //   memoria (LONGO PRAZO) — no CONTATO, vale entre conversas.
    //   sessao  (CURTO PRAZO) — na CONVERSA, morre com ela.
    const { memoria, sessao, contactId } = await this.carregarMemorias(
      run.accountId,
      run.conversationId
    );

    const resultado = await executeRun({
      runId,
      accountId: run.accountId,
      flowId: run.flowId,
      conversationId: run.conversationId,
      shadow: run.shadow,
      graph: parseGraph(run.flow.graph),
      resumeNodeId: run.resumeNodeId,
      vars: {
        ...((run.context ?? {}) as Record<string, unknown>),
        memoria,
        sessao,
        __contactId: contactId,
        // Qual toque da cadência é este. As guardas de follow-up leem daqui.
        __toque: run.wakeCount,
      },
    });

    // Nada disso vai pro contexto salvo: `__edges`/`__contactId` são controle
    // interno do motor, e as duas memórias têm dono próprio (contato e
    // conversa). Duplicar criaria uma segunda verdade que diverge.
    const {
      __edges: _edges,
      __contactId: _contact,
      __toque: _toque,
      memoria: _memoria,
      sessao: _sessao,
      ...contexto
    } = resultado.vars;

    // Dormindo não é terminado: o run volta pra fila com hora marcada e o
    // ponto de retomada. `finishedAt` fica nulo — senão a tela de execuções
    // mostraria como concluído um atendimento que ainda vai continuar.
    if (resultado.status === 'sleeping') {
      await prisma.flowRun.update({
        where: { id: runId },
        data: {
          status: 'sleeping',
          runAfter: resultado.sleepUntil ?? new Date(),
          resumeNodeId: resultado.resumeNodeId ?? null,
          context: contexto as unknown as Prisma.InputJsonValue,
        },
      });
      return;
    }

    await prisma.flowRun.update({
      where: { id: runId },
      data: {
        status: resultado.status,
        stopReason: resultado.stopReason?.slice(0, 80) ?? null,
        error: resultado.error?.slice(0, 2000) ?? null,
        context: contexto as unknown as Prisma.InputJsonValue,
        // Acabou de verdade: limpa a retomada pra um run concluído nunca
        // parecer retomável.
        resumeNodeId: null,
        finishedAt: new Date(),
      },
    });
  }

  // ============================================
  // Simulador
  // ============================================

  /**
   * Roda o fluxo INTEIRO contra uma conversa de teste, na hora, e devolve o que
   * a IA responderia.
   *
   * Por que existe: o playground testa um agente isolado, e o modo sombra exige
   * mensagem real de WhatsApp e só mostra o resultado depois. Nenhum dos dois
   * serve pra iterar no atendimento — trocar uma frase do prompt e ver o efeito
   * na mesma hora.
   *
   * Roda com `shadow: true` de propósito: o fluxo executa todos os passos, mas
   * nada sai pro WhatsApp e nada muda no funil. A resposta é lida do passo de
   * envio, que em sombra já registra o texto que teria mandado.
   */
  async preview(params: {
    accountId: string;
    flowId: string;
    message: string;
    /** Conversa de teste em andamento. Ausente = começa uma nova. */
    conversationId?: string | null;
  }) {
    const flow = await this.get(params.accountId, params.flowId);
    const graph = parseGraph(flow.graph);

    const problemas = validateGraph(graph);
    if (problemas.length > 0) {
      throw new ValidationError(`O fluxo tem problemas: ${problemas.join(' ')}`);
    }

    const texto = params.message?.trim();
    if (!texto) throw new ValidationError('Escreva a mensagem do lead');

    // TRAVA: o simulador GRAVA mensagem na conversa. Se aceitasse qualquer id
    // vindo do request, um engano de front (ou um id colado à mão) injetaria
    // fala falsa no histórico de um lead de verdade — e o atendente leria como
    // se o cliente tivesse escrito. Só conversa do inbox do simulador entra.
    const conversationId = params.conversationId
      ? (await this.exigirConversaDeTeste(params.accountId, params.conversationId)).id
      : (await this.criarConversaDeTeste(params.accountId)).id;

    // A mensagem é persistida de verdade: é o que faz o histórico e o resumo
    // se comportarem no simulador igual ao atendimento real.
    const msg = await prisma.message.create({
      data: {
        conversationId,
        senderType: 'customer',
        content: texto,
        contentType: 'text',
        metadata: { simulador: true },
      },
    });

    // Mesmo formato que o gatilho monta no atendimento real — o motor lê
    // `mensagens` esperando esta forma.
    const mensagens = [
      {
        id: msg.id,
        content: texto,
        contentType: 'text',
        createdAt: msg.createdAt.toISOString(),
      },
    ];

    const run = await prisma.flowRun.create({
      data: {
        accountId: params.accountId,
        flowId: flow.id,
        conversationId,
        // Já nasce 'running': o simulador executa na hora, sem passar pelo
        // worker — senão o usuário esperaria o próximo tick.
        status: 'running',
        shadow: true,
        simulador: true,
        startedAt: new Date(),
        context: { mensagens } as unknown as Prisma.InputJsonValue,
      },
    });

    const { memoria, sessao, contactId } = await this.carregarMemorias(
      params.accountId,
      conversationId
    );

    const resultado = await executeRun({
      runId: run.id,
      accountId: params.accountId,
      flowId: flow.id,
      conversationId,
      shadow: true,
      graph,
      vars: { mensagens, memoria, sessao, __contactId: contactId, __simulador: true },
    });

    await prisma.flowRun.update({
      where: { id: run.id },
      data: {
        status: resultado.status,
        stopReason: resultado.stopReason?.slice(0, 80) ?? null,
        error: resultado.error?.slice(0, 2000) ?? null,
        finishedAt: new Date(),
      },
    });

    const steps = await prisma.flowRunStep.findMany({
      where: { runId: run.id },
      orderBy: { ordem: 'asc' },
    });

    // A resposta sai do passo de envio: em sombra ele registra o texto que
    // teria mandado, em vez de mandar.
    const envio = steps.find((s) => s.nodeType === 'chat.reply');
    const resposta = ((envio?.output ?? {}) as { texto?: string }).texto ?? null;

    // A resposta é gravada como mensagem da conversa de teste. Sem isso o turno
    // seguinte veria só as falas do lead e a IA se repetiria — a simulação
    // deixaria de parecer com o atendimento no exato ponto que importa.
    if (resposta) {
      await prisma.message.create({
        data: {
          conversationId,
          senderType: 'ai_bot',
          content: resposta,
          contentType: 'text',
          metadata: { simulador: true, runId: run.id },
        },
      });
    }

    // Estado depois da execução — é o que deixa ver a memória sendo construída.
    const depois = await this.carregarMemorias(params.accountId, conversationId);

    return {
      conversationId,
      runId: run.id,
      resposta,
      status: resultado.status,
      stopReason: resultado.stopReason,
      error: resultado.error,
      steps,
      // As chaves com `_` são controle interno (resumo do histórico, marcação do
      // simulador) — mostrar na tela só confundiria quem está lendo a memória.
      memoria: semChavesInternas(depois.memoria),
      sessao: semChavesInternas(depois.sessao),
    };
  }

  /**
   * Conversa de teste isolada: inbox próprio e inativo, pra que ela não apareça
   * como caixa de envio nem se misture com o atendimento real.
   */
  private async criarConversaDeTeste(accountId: string) {
    let inbox = await prisma.inbox.findFirst({
      where: { accountId, name: INBOX_SIMULADOR },
    });
    if (!inbox) {
      inbox = await prisma.inbox.create({
        data: { accountId, name: INBOX_SIMULADOR, channelType: 'whatsapp', active: false },
      });
    }

    const telefone = `simulador-${Date.now().toString(36)}`;
    const contato = await prisma.contact.create({
      data: {
        accountId,
        // Nome explícito: este contato aparece na lista de leads como qualquer
        // outro, e quem abrir precisa entender na hora que não é cliente.
        nome: 'Simulador — lead de teste',
        telefone,
        customAttributes: { _simulador: true },
      },
    });

    return prisma.conversation.create({
      data: {
        accountId,
        inboxId: inbox.id,
        contactId: contato.id,
        status: 'open',
        customAttributes: {},
      },
    });
  }

  /**
   * A conversa existe, é desta conta E nasceu no simulador.
   *
   * A checagem do inbox é a única coisa separando "escrever numa conversa de
   * teste" de "escrever na conversa de um cliente" — tanto no preview, que
   * grava mensagem, quanto no reset, que apaga.
   */
  private async exigirConversaDeTeste(accountId: string, conversationId: string) {
    const conversa = await prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { id: true, contactId: true, inbox: { select: { name: true } } },
    });
    if (!conversa) throw new NotFoundError('Conversa de teste');
    if (conversa.inbox?.name !== INBOX_SIMULADOR) {
      throw new ValidationError('Esta conversa não é do simulador');
    }
    return conversa;
  }

  /** Descarta a conversa de teste — recomeça do zero, sem memória nenhuma. */
  async resetPreview(accountId: string, conversationId: string) {
    const conversa = await this.exigirConversaDeTeste(accountId, conversationId);

    // Os runs não têm FK pra conversa — sem apagar aqui virariam órfãos.
    await prisma.flowRun.deleteMany({ where: { accountId, conversationId: conversa.id } });
    await prisma.conversation.delete({ where: { id: conversa.id } });
    if (conversa.contactId) {
      await prisma.contact.delete({ where: { id: conversa.contactId } }).catch(() => undefined);
    }
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
        // Fora as execuções do simulador: esta tela existe pra comparar o modo
        // sombra com o atendimento real, e conversa de teste polui a comparação.
        simulador: false,
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
