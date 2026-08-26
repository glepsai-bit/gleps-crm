/**
 * T-028 Fase 2 — interpretador do grafo.
 *
 * Percorre o grafo nó a nó, grava cada passo e segue a aresta indicada pelo
 * ramo que o nó devolveu. Não há paralelismo: um atendimento é uma sequência,
 * e sequência é o que dá pra depurar às 2h da manhã lendo a tela de execuções.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import { NODE_CATALOG } from './nodes';
import type { FlowGraph, FlowNode, NodeContext } from './types';

/**
 * Teto de passos por execução. Um grafo com ciclo (o canvas permite desenhar)
 * rodaria pra sempre queimando token de IA — este teto é a trava dura.
 */
const MAX_STEPS = 40;
/** Teto por nó. Nó travado não pode segurar a conversa indefinidamente. */
const NODE_TIMEOUT_MS = 120_000;

export interface RunOutcome {
  status: 'done' | 'failed';
  steps: number;
  stopReason: string | null;
  error: string | null;
  vars: Record<string, unknown>;
}

export function parseGraph(raw: unknown): FlowGraph {
  const g = (raw ?? {}) as Partial<FlowGraph>;
  return {
    nodes: Array.isArray(g.nodes) ? g.nodes : [],
    edges: Array.isArray(g.edges) ? g.edges : [],
  };
}

/** Nó inicial: o gatilho. Sem ele o grafo não é executável. */
export function findStartNode(graph: FlowGraph): FlowNode | null {
  return graph.nodes.find((n) => n.type.startsWith('trigger.')) ?? null;
}

/**
 * Valida o grafo ANTES de deixar ativar. Erro de montagem tem que aparecer na
 * tela, não como atendimento silenciosamente parado no meio.
 */
export function validateGraph(graph: FlowGraph): string[] {
  const erros: string[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));

  if (graph.nodes.length === 0) erros.push('O fluxo está vazio.');
  if (!findStartNode(graph)) erros.push('Falta o nó de gatilho ("Mensagem recebida").');

  const gatilhos = graph.nodes.filter((n) => n.type.startsWith('trigger.'));
  if (gatilhos.length > 1) erros.push('Há mais de um gatilho; o fluxo precisa começar em um só.');

  for (const n of graph.nodes) {
    if (!NODE_CATALOG[n.type]) erros.push(`Nó desconhecido: "${n.type}".`);
    if (n.type === 'ai.agent' && !(n.config as { agentId?: string })?.agentId) {
      erros.push(`O nó "${n.label ?? n.id}" está sem agente selecionado.`);
    }
  }

  for (const e of graph.edges) {
    if (!ids.has(e.source)) erros.push(`Conexão aponta para um nó de origem inexistente (${e.source}).`);
    if (!ids.has(e.target)) erros.push(`Conexão aponta para um nó de destino inexistente (${e.target}).`);
  }

  // Nó órfão: não é o gatilho e ninguém chega nele. Não quebra a execução, mas
  // quase sempre é engano de montagem — o usuário acha que configurou algo que
  // nunca vai rodar.
  const alcancados = new Set(graph.edges.map((e) => e.target));
  for (const n of graph.nodes) {
    if (!n.type.startsWith('trigger.') && !alcancados.has(n.id)) {
      erros.push(`O nó "${n.label ?? n.id}" não está conectado a nada.`);
    }
  }

  return erros;
}

function nextNode(graph: FlowGraph, fromId: string, branch: string | undefined): FlowNode | null {
  const saidas = graph.edges.filter((e) => e.source === fromId);
  // Ramo explícito primeiro; senão a saída padrão (branch nulo/ausente).
  const escolhida =
    (branch && saidas.find((e) => e.branch === branch)) ??
    saidas.find((e) => !e.branch || e.branch === 'default');
  if (!escolhida) return null;
  return graph.nodes.find((n) => n.id === escolhida.target) ?? null;
}

async function comTimeout<T>(p: Promise<T>, ms: number, nodeType: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const limite = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Nó "${nodeType}" excedeu ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, limite]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Executa o grafo de um run já reclamado (status 'running').
 * Persiste um FlowRunStep por nó — é isso que vira a timeline na tela.
 */
export async function executeRun(params: {
  runId: string;
  accountId: string;
  flowId: string;
  conversationId: string;
  shadow: boolean;
  graph: FlowGraph;
  vars: Record<string, unknown>;
}): Promise<RunOutcome> {
  const { runId, accountId, flowId, conversationId, shadow, graph } = params;

  const ctx: NodeContext = {
    accountId,
    runId,
    flowId,
    conversationId,
    shadow,
    // Ator sentinela — mesmo padrão que as integrações usam (`api:<id>`).
    // Os services só gravam isso em evento; não há FK pra User.
    actorId: `flow:${flowId}`,
    vars: { ...params.vars, __edges: graph.edges },
  };

  let atual = findStartNode(graph);
  if (!atual) {
    return { status: 'failed', steps: 0, stopReason: null, error: 'Grafo sem nó de gatilho', vars: ctx.vars };
  }

  let ordem = 0;
  let stopReason: string | null = null;

  while (atual && ordem < MAX_STEPS) {
    // Binding local não-nulo: `atual` é reatribuído no fim do laço, então sem
    // isto o TypeScript o considera possivelmente nulo dentro do catch.
    const node = atual;
    const def = NODE_CATALOG[node.type];
    const inicio = Date.now();

    if (!def) {
      await gravarPasso(runId, node, ordem, 'error', null, null, `Nó desconhecido: ${node.type}`, 0);
      return {
        status: 'failed',
        steps: ordem + 1,
        stopReason: null,
        error: `Nó desconhecido: ${node.type}`,
        vars: ctx.vars,
      };
    }

    try {
      const r = await comTimeout(def.execute(node, ctx), NODE_TIMEOUT_MS, node.type);
      const ms = Date.now() - inicio;

      if (r.vars) Object.assign(ctx.vars, r.vars);

      await gravarPasso(
        runId,
        node,
        ordem,
        r.stop ? 'skipped' : 'ok',
        sanitizarEntrada(node),
        r.output ?? null,
        null,
        ms
      );
      ordem++;

      if (r.stop) {
        stopReason = r.stopReason ?? 'parado';
        break;
      }

      atual = nextNode(graph, node.id, r.branch);
      if (!atual) {
        stopReason = 'fim_do_fluxo';
        break;
      }
    } catch (err) {
      const ms = Date.now() - inicio;
      const mensagem = err instanceof Error ? err.message : String(err);
      await gravarPasso(runId, node, ordem, 'error', sanitizarEntrada(node), null, mensagem, ms);
      logger.warn('[flow] nó falhou', { runId, nodeId: node.id, type: node.type, error: mensagem });
      return { status: 'failed', steps: ordem + 1, stopReason: null, error: mensagem, vars: ctx.vars };
    }
  }

  if (ordem >= MAX_STEPS) {
    stopReason = 'teto_de_passos';
    logger.warn('[flow] run atingiu o teto de passos — possível ciclo no grafo', { runId, flowId });
  }

  return { status: 'done', steps: ordem, stopReason, error: null, vars: ctx.vars };
}

/** A config do nó é o "input" do passo, sem os dados de layout do canvas. */
function sanitizarEntrada(node: FlowNode): Record<string, unknown> {
  return { type: node.type, label: node.label ?? null, config: node.config ?? {} };
}

async function gravarPasso(
  runId: string,
  node: FlowNode,
  ordem: number,
  status: 'ok' | 'error' | 'skipped',
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null,
  error: string | null,
  ms: number
): Promise<void> {
  try {
    await prisma.flowRunStep.create({
      data: {
        runId,
        nodeId: node.id,
        nodeType: node.type,
        status,
        input: (input ?? undefined) as Prisma.InputJsonValue | undefined,
        output: (output ?? undefined) as Prisma.InputJsonValue | undefined,
        error: error?.slice(0, 2000) ?? null,
        ms,
        ordem,
      },
    });
  } catch (err) {
    // Falhar ao gravar o log não pode derrubar o atendimento em si.
    logger.warn('[flow] não foi possível gravar o passo', {
      runId,
      nodeId: node.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
