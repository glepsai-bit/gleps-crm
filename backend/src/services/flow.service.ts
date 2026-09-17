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
import { executeRun, parseGraph, validateGraph, type RunOutcome } from './flow/engine';
import { valorDaMemoria, semExpiradas } from './ai/memoria';
import { TIPOS_QUE_ENVIAM } from './flow/nodes';
import { buildSuggestedAgentSchema } from './flow/default-graph';
import type { ContatoResumo } from './ai-agent.service';
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

/** Status em que o run não vai mais mudar sozinho. */
const STATUS_TERMINAL = new Set(['done', 'failed', 'sleeping', 'skipped']);

/**
 * A janela de agrupamento do grafo, em segundos — lida do nó `buffer.debounce`.
 * É a MESMA função pro gatilho real e pro simulador: se cada um lesse do seu
 * jeito, a simulação esperaria um tempo diferente do atendimento.
 */
function janelaDeAgrupamento(graph: FlowGraph): number {
  const debounce = graph.nodes.find((n) => n.type === 'buffer.debounce');
  const bruto = Number(
    (debounce?.config as { segundos?: number } | undefined)?.segundos ?? DEFAULT_DEBOUNCE_SECONDS
  );
  return Math.min(Math.max(Number.isFinite(bruto) ? bruto : 0, 0), MAX_DEBOUNCE_SECONDS);
}

/**
 * O que o lead ouviu, lido dos passos que falam.
 *
 * Em sombra cada passo registra em `output.texto` o que TERIA mandado. A lista
 * de quem fala vem do catálogo (TIPOS_QUE_ENVIAM), não daqui: este trecho já
 * procurou `chat.reply` literal, e quando o composto passou a enviar o
 * simulador ficou mudo pro fluxo novo.
 */
function falasDaIa(steps: { nodeType: string; output: unknown }[]): string[] {
  return steps
    .filter((s) => TIPOS_QUE_ENVIAM.includes(s.nodeType))
    .map((s) => ((s.output ?? {}) as { texto?: unknown }).texto)
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '');
}

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

/**
 * Desembrulha `{ v, por, em }` num mapa de memórias, deixando valor cru intacto.
 */
function semAutoria(attrs: Record<string, unknown>): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(attrs)) {
    saida[chave] = valorDaMemoria(valor);
  }
  return saida;
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
    const segundos = janelaDeAgrupamento(graph);
    const runAfter = new Date(Date.now() + segundos * 1000);

    const mensagem: BufferedMessage = {
      id: evt.messageId,
      content: evt.content,
      contentType: evt.contentType,
      createdAt: new Date().toISOString(),
    };

    const anexado = await this.anexarAoRunAberto(evt.conversationId, mensagem, runAfter);
    if (anexado) return;

    // O agente que assumiu a conversa continua dono: o run já nasce apontando
    // pro bloco dele, em vez de recomeçar pela triagem. Se o bloco sumiu do
    // grafo (alguém editou o fluxo), volta pro começo — é melhor re-triar do
    // que parar o atendimento num nó que não existe mais.
    const blocoAtivo = await this.blocoAtivoValido(evt.conversationId, graph);

    try {
      await prisma.flowRun.create({
        data: {
          accountId: evt.accountId,
          flowId: flow.id,
          conversationId: evt.conversationId,
          status: 'buffering',
          runAfter,
          shadow: flow.status === 'shadow',
          resumeNodeId: blocoAtivo,
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
   * O bloco dono da conversa, se ainda existir no grafo.
   *
   * Editar o fluxo enquanto uma conversa está no meio de um atendimento é
   * normal. Se o bloco do especialista foi removido, retomar nele travaria o
   * atendimento em silêncio — recomeçar pela triagem é o degrau seguro.
   */
  private async blocoAtivoValido(
    conversationId: string,
    graph: ReturnType<typeof parseGraph>
  ): Promise<string | null> {
    const conversa = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { customAttributes: true, assigneeId: true, status: true },
    });
    const attrs = (conversa?.customAttributes ?? {}) as Record<string, unknown>;
    const id = typeof attrs.__blocoAtivo === 'string' ? attrs.__blocoAtivo : null;
    if (!id) return null;

    // Humano assumiu, ou a conversa foi encerrada e reaberta: muita coisa pode
    // ter mudado fora do fluxo. Recomeçar pela triagem é mais honesto que
    // devolver a um especialista escolhido antes de tudo isso. A guarda vai
    // barrar de qualquer forma enquanto o humano estiver ativo — isto trata o
    // depois, quando ele soltar a conversa.
    if (conversa?.assigneeId || conversa?.status === 'resolved') return null;

    const existe = graph.nodes.some((n) => n.id === id);
    if (!existe) {
      logger.warn('[flow] bloco ativo sumiu do grafo; recomeçando pela triagem', {
        conversationId,
        blocoAtivo: id,
      });
      return null;
    }
    return id;
  }

  /**
   * Persiste (ou limpa) o agente dono da conversa.
   *
   * `undefined` significa "o fluxo não se pronunciou" — mantém o que estava.
   * Só `null` limpa. A distinção importa: um fluxo de follow-up não pode
   * derrubar, de passagem, a posse que uma triagem estabeleceu.
   *
   * A chave começa com `__` de propósito: é controle interno e o prompt do
   * agente já filtra chaves assim.
   */
  private async gravarBlocoAtivo(
    conversationId: string,
    vars: Record<string, unknown>
  ): Promise<void> {
    if (!('__blocoAtivo' in vars)) return;
    const novo = vars.__blocoAtivo as string | null;

    const conversa = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { customAttributes: true },
    });
    const attrs = { ...((conversa?.customAttributes ?? {}) as Record<string, unknown>) };

    if (novo === attrs.__blocoAtivo) return;
    if (novo) attrs.__blocoAtivo = novo;
    else delete attrs.__blocoAtivo;

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { customAttributes: attrs as unknown as Prisma.InputJsonValue },
    });
    logger.info('[flow] posse da conversa', { conversationId, blocoAtivo: novo ?? null });
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

  /** Anexa ao run 'buffering' da conversa, se houver. Devolve o id dele, ou null. */
  private async anexarAoRunAberto(
    conversationId: string,
    mensagem: BufferedMessage,
    runAfter: Date
  ): Promise<string | null> {
    const aberto = await prisma.flowRun.findFirst({
      where: { conversationId, status: 'buffering' },
      select: { id: true, context: true },
    });
    if (!aberto) return null;

    const ctx = (aberto.context ?? {}) as { mensagens?: BufferedMessage[] };
    const mensagens = [...(ctx.mensagens ?? []), mensagem].slice(-MAX_BUFFERED);

    await prisma.flowRun.update({
      where: { id: aberto.id },
      data: {
        runAfter,
        context: { ...ctx, mensagens } as unknown as Prisma.InputJsonValue,
      },
    });
    return aberto.id;
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
  /**
   * Tira o embrulho de autoria antes da memória virar variável do fluxo.
   *
   * `lembrar` grava `{ v, por, em }` pra responder "quem disse isso?". Mas o
   * interpolador faz `JSON.stringify` em tudo que não é string, então um bloco
   * com `Olá {{memoria.nome}}` mandava ao CLIENTE o objeto inteiro:
   * `Olá {"v":"João","por":"Marcus","em":"2026-..."}`.
   *
   * Aqui, e não no interpolador, porque é aqui que se sabe que estes valores
   * são memória — o interpolador serve pra qualquer variável. `valorDaMemoria`
   * aceita as duas formas, então memória antiga (valor cru) passa intacta.
   */
  private async carregarMemorias(
    accountId: string,
    conversationId: string
  ): Promise<{
    memoria: Record<string, unknown>;
    sessao: Record<string, unknown>;
    contactId: string | null;
    contato: ContatoResumo | null;
  }> {
    const conversa = await prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { customAttributes: true, contactId: true },
    });
    const sessao = semAutoria((conversa?.customAttributes ?? {}) as Record<string, unknown>);

    let memoria: Record<string, unknown> = {};
    let contato: ContatoResumo | null = null;
    if (conversa?.contactId) {
      // Cadastro e histórico vêm na MESMA consulta que a memória: é o que
      // faz o lead que volta ser recebido como quem volta, sem query a mais.
      const row = await prisma.contact.findFirst({
        where: { id: conversa.contactId, accountId },
        select: {
          customAttributes: true,
          nome: true,
          telefone: true,
          cidade: true,
          estado: true,
          nicho: true,
          origem: true,
          createdAt: true,
          _count: { select: { conversations: { where: { id: { not: conversationId } } } } },
        },
      });
      const attrs = (row?.customAttributes ?? {}) as Record<string, unknown>;
      // Vencida na LEITURA: some do prompt, fica no banco.
      memoria = semAutoria(semExpiradas(attrs));
      if (row) {
        const ultima = attrs._ultima_conversa as ContatoResumo['ultimaConversa'] | undefined;
        contato = {
          nome: row.nome,
          telefone: row.telefone,
          cidade: row.cidade,
          estado: row.estado,
          nicho: row.nicho,
          origem: row.origem,
          clienteDesde: row.createdAt,
          conversasAnteriores: row._count?.conversations ?? 0,
          ultimaConversa:
            ultima && typeof ultima === 'object'
              ? {
                  em: typeof ultima.em === 'string' ? ultima.em : null,
                  etapa: typeof ultima.etapa === 'string' ? ultima.etapa : null,
                  resumo: typeof ultima.resumo === 'string' ? ultima.resumo : null,
                }
              : null,
        };
      }
    }
    return { memoria, sessao, contactId: conversa?.contactId ?? null, contato };
  }

  /**
   * Executa UM run já reclamado ('running'). É o mesmo caminho pro atendimento
   * real e pro simulador — a diferença toda cabe em três pontos: o simulador
   * roda fluxo em rascunho, roda sempre em sombra, e ao terminar persiste as
   * falas da IA na conversa de teste.
   */
  private async runOne(runId: string): Promise<RunOutcome | null> {
    const run = await prisma.flowRun.findUnique({
      where: { id: runId },
      include: { flow: true },
    });
    if (!run) return null;

    // O fluxo pode ter sido despublicado enquanto o run esperava na janela.
    // O simulador é a exceção: ele existe justamente pra testar rascunho.
    if (run.flow.status === 'draft' && !run.simulador) {
      await prisma.flowRun.update({
        where: { id: runId },
        data: { status: 'skipped', stopReason: 'fluxo_despublicado', finishedAt: new Date() },
      });
      return null;
    }

    // DUAS MEMÓRIAS, e a distinção é o que impede o agente de perder contexto:
    //   memoria (LONGO PRAZO) — no CONTATO, vale entre conversas.
    //   sessao  (CURTO PRAZO) — na CONVERSA, morre com ela.
    const { memoria, sessao, contactId, contato } = await this.carregarMemorias(
      run.accountId,
      run.conversationId
    );

    const resultado = await executeRun({
      runId,
      accountId: run.accountId,
      flowId: run.flowId,
      conversationId: run.conversationId,
      // Simulador é sombra SEMPRE, mesmo que alguém edite o run no banco.
      shadow: run.shadow || run.simulador,
      graph: parseGraph(run.flow.graph),
      resumeNodeId: run.resumeNodeId,
      vars: {
        ...((run.context ?? {}) as Record<string, unknown>),
        memoria,
        sessao,
        __contactId: contactId,
        __contato: contato,
        // Qual toque da cadência é este. As guardas de follow-up leem daqui.
        __toque: run.wakeCount,
        // Os nós de espera leem daqui pra decidir o que pular.
        ...(run.simulador ? { __simulador: true } : {}),
      },
    });

    // Nada disso vai pro contexto salvo: `__edges`/`__contactId` são controle
    // interno do motor, e as duas memórias têm dono próprio (contato e
    // conversa). Duplicar criaria uma segunda verdade que diverge.
    const {
      __edges: _edges,
      __contactId: _contact,
      __contato: _contatoVar,
      __toque: _toque,
      __blocoAtivo: _blocoAtivo,
      __simulador: _simulador,
      memoria: _memoria,
      sessao: _sessao,
      ...contexto
    } = resultado.vars;

    // Quem atende a PRÓXIMA mensagem desta conversa. Vive na conversa e não no
    // run, porque o run acaba e a posse não.
    await this.gravarBlocoAtivo(run.conversationId, resultado.vars);

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
      return resultado;
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

    // Passo compartilhado entre o caminho imediato e o worker: quem executou
    // o run do simulador é quem grava as falas — e cada run é executado por
    // um só dos dois, então cada fala entra uma vez.
    if (run.simulador) await this.finalizarRunDoSimulador(runId, run.conversationId);

    return resultado;
  }

  // ============================================
  // Simulador
  // ============================================

  /**
   * Um turno do simulador: o lead "escreve" numa conversa de teste e o fluxo
   * roda contra ela — com a MESMA janela de agrupamento do atendimento real.
   *
   * Por que existe: o playground testa um agente isolado, e o modo sombra exige
   * mensagem real de WhatsApp e só mostra o resultado depois. Nenhum dos dois
   * serve pra iterar no atendimento — trocar uma frase do prompt e ver o efeito
   * na mesma hora.
   *
   * Com `buffer.debounce` no grafo, o run nasce em 'buffering' e é o worker
   * que executa quando a janela vence — igual ao lead de verdade. Pular a
   * janela aqui era o que fazia a simulação responder mensagem por mensagem
   * enquanto o cliente, em produção, recebia uma resposta só pras três que
   * mandou seguidas. Sem debounce, executa na hora.
   *
   * Roda com `shadow: true` de propósito: o fluxo executa todos os passos, mas
   * nada sai pro WhatsApp e nada muda no funil.
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
    const mensagem: BufferedMessage = {
      id: msg.id,
      content: texto,
      contentType: 'text',
      createdAt: msg.createdAt.toISOString(),
    };

    const segundos = janelaDeAgrupamento(graph);

    // ---- COM JANELA: nasce em 'buffering' e o worker executa ----
    if (segundos > 0) {
      const runAfter = new Date(Date.now() + segundos * 1000);
      const resposta = (runId: string) => ({
        conversationId,
        runId,
        status: 'buffering' as const,
        runAfter: runAfter.toISOString(),
        segundos,
      });

      // Mesma regra do atendimento real: mensagem nova empurra a janela.
      const anexado = await this.anexarAoRunAberto(conversationId, mensagem, runAfter);
      if (anexado) return resposta(anexado);

      const blocoAtivo = await this.blocoAtivoValido(conversationId, graph);
      try {
        const run = await prisma.flowRun.create({
          data: {
            accountId: params.accountId,
            flowId: flow.id,
            conversationId,
            status: 'buffering',
            runAfter,
            shadow: true,
            simulador: true,
            resumeNodeId: blocoAtivo,
            context: { mensagens: [mensagem] } as unknown as Prisma.InputJsonValue,
          },
        });
        return resposta(run.id);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const outro = await this.anexarAoRunAberto(conversationId, mensagem, runAfter);
          if (outro) return resposta(outro);
        }
        throw err;
      }
    }

    // ---- SEM JANELA: executa na hora ----
    // O agente que assumiu a conversa continua dono também aqui — o simulador
    // precisa mostrar a entrega entre agentes como ela acontece.
    const blocoAtivo = await this.blocoAtivoValido(conversationId, graph);
    const run = await prisma.flowRun.create({
      data: {
        accountId: params.accountId,
        flowId: flow.id,
        conversationId,
        // Já nasce 'running': executa na hora, sem passar pelo worker — senão
        // o usuário esperaria o próximo tick.
        status: 'running',
        shadow: true,
        simulador: true,
        resumeNodeId: blocoAtivo,
        startedAt: new Date(),
        context: { mensagens: [mensagem] } as unknown as Prisma.InputJsonValue,
      },
    });

    let resultado: RunOutcome | null;
    try {
      resultado = await this.runOne(run.id);
    } catch (err) {
      const mensagemErro = err instanceof Error ? err.message : String(err);
      await prisma.flowRun
        .update({
          where: { id: run.id },
          data: { status: 'failed', error: mensagemErro.slice(0, 2000), finishedAt: new Date() },
        })
        .catch(() => undefined);
      resultado = { status: 'failed', steps: 0, stopReason: null, error: mensagemErro, vars: {} };
    }

    const steps = await prisma.flowRunStep.findMany({
      where: { runId: run.id },
      orderBy: { ordem: 'asc' },
    });
    const enviados = falasDaIa(steps);

    // Estado depois da execução — é o que deixa ver a memória sendo construída.
    const depois = await this.carregarMemorias(params.accountId, conversationId);

    return {
      conversationId,
      runId: run.id,
      resposta: enviados.length > 0 ? enviados.join('\n\n') : null,
      status: resultado?.status ?? 'failed',
      stopReason: resultado?.stopReason ?? null,
      error: resultado?.error ?? null,
      steps,
      // As chaves com `_` são controle interno (resumo do histórico, marcação do
      // simulador) — mostrar na tela só confundiria quem está lendo a memória.
      memoria: semChavesInternas(depois.memoria),
      sessao: semChavesInternas(depois.sessao),
    };
  }

  /**
   * Fecha um run do simulador: grava as falas da IA como mensagens da conversa
   * de teste. Sem isso o turno seguinte veria só as falas do lead e a IA se
   * repetiria — a simulação deixaria de parecer com o atendimento no exato
   * ponto que importa.
   *
   * Todos os envios, não só o primeiro: um fluxo que manda duas mensagens
   * precisa gravar as duas, senão o turno seguinte lê um histórico que não
   * aconteceu.
   */
  private async finalizarRunDoSimulador(runId: string, conversationId: string): Promise<void> {
    const steps = await prisma.flowRunStep.findMany({
      where: { runId },
      orderBy: { ordem: 'asc' },
    });
    for (const texto of falasDaIa(steps)) {
      await prisma.message.create({
        data: {
          conversationId,
          senderType: 'ai_bot',
          content: texto,
          contentType: 'text',
          metadata: { simulador: true, runId },
        },
      });
    }
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

  /**
   * Os passos do run em andamento na conversa de teste.
   *
   * O motor grava cada FlowRunStep assim que o nó termina, então dá pra
   * acompanhar a execução acontecendo em vez de esperar o fim. É o que permite
   * o canvas acender os blocos um a um — e mostrar EM QUAL deles quebrou, que é
   * a informação que o usuário quer quando algo dá errado.
   */
  async previewRunAtual(accountId: string, conversationId: string) {
    await this.exigirConversaDeTeste(accountId, conversationId);

    const run = await prisma.flowRun.findFirst({
      where: { accountId, conversationId, simulador: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, runAfter: true, stopReason: true, error: true },
    });
    if (!run) return null;

    const steps = await prisma.flowRunStep.findMany({
      where: { runId: run.id },
      orderBy: { ordem: 'asc' },
    });

    // A resposta é DERIVADA dos passos, em toda chamada — idempotente. É o que
    // permite ao run que rodou no worker (janela de agrupamento) entregar a
    // resposta à tela pela mesma porta que o canvas já consulta.
    const enviados = falasDaIa(steps);
    const terminou = STATUS_TERMINAL.has(run.status);
    const depois = terminou ? await this.carregarMemorias(accountId, conversationId) : null;

    return {
      runId: run.id,
      status: run.status,
      runAfter: run.runAfter ? run.runAfter.toISOString() : null,
      steps,
      resposta: enviados.length > 0 ? enviados.join('\n\n') : null,
      stopReason: run.stopReason,
      error: run.error,
      memoria: depois ? semChavesInternas(depois.memoria) : {},
      sessao: depois ? semChavesInternas(depois.sessao) : {},
    };
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
  // Schema sugerido do agente
  // ============================================

  /**
   * O schema de saída sugerido, com o enum de `etapa` vindo das etapas REAIS
   * da conta. Seis slugs fixos no código não existiam em conta nenhuma — o
   * modelo devolvia "agendado" e o kanban de verdade ficava intocado.
   */
  async agentSchema(accountId: string) {
    const etapas = await prisma.tag.findMany({
      where: { accountId, type: 'stage', ativo: true },
      orderBy: { ordem: 'asc' },
      select: { slug: true },
    });
    return buildSuggestedAgentSchema(etapas.map((e) => e.slug));
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
