/**
 * T-028 — interpretador do grafo.
 *
 * O foco é o que quebra atendimento de verdade: roteamento por ramo, trava
 * anti-ciclo e o modo sombra. Um grafo mal roteado não dá erro — ele responde
 * a coisa errada pro lead, que é pior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FlowGraph, NodeDefinition } from './types';

const stepsGravados = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('../../config/database', () => ({
  prisma: {
    flowRunStep: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        stepsGravados.push(data);
        return data;
      }),
    },
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const catalogoMock = vi.hoisted(() => ({}) as Record<string, NodeDefinition>);
vi.mock('./nodes', () => ({ NODE_CATALOG: catalogoMock }));

import { executeRun, validateGraph, parseGraph, findStartNode } from './engine';

/** Nó de teste que devolve o que a gente mandar. */
function fakeNode(type: string, result: Record<string, unknown> = {}): NodeDefinition {
  return {
    type,
    label: type,
    description: '',
    branches: [{ key: 'default', label: '' }],
    mutates: false,
    execute: vi.fn(async () => result),
  } as unknown as NodeDefinition;
}

const base = {
  runId: 'run-1',
  accountId: 'acc-1',
  flowId: 'flow-1',
  conversationId: 'conv-1',
  shadow: false,
  vars: {},
};

beforeEach(() => {
  stepsGravados.length = 0;
  for (const k of Object.keys(catalogoMock)) delete catalogoMock[k];
  vi.clearAllMocks();
});

describe('validateGraph', () => {
  it('recusa grafo sem gatilho', () => {
    catalogoMock['chat.reply'] = fakeNode('chat.reply');
    const erros = validateGraph({
      nodes: [{ id: 'a', type: 'chat.reply' }],
      edges: [],
    });
    expect(erros.join(' ')).toContain('gatilho');
  });

  it('recusa agente sem agentId — é o erro de montagem mais comum', () => {
    catalogoMock['trigger.message_received'] = fakeNode('trigger.message_received');
    catalogoMock['ai.agent'] = fakeNode('ai.agent');
    const erros = validateGraph({
      nodes: [
        { id: 't', type: 'trigger.message_received' },
        { id: 'a', type: 'ai.agent', label: 'Agente', config: {} },
      ],
      edges: [{ id: 'e', source: 't', target: 'a' }],
    });
    expect(erros.join(' ')).toContain('sem agente selecionado');
  });

  it('aponta nó desconectado — usuário acha que configurou algo que nunca roda', () => {
    catalogoMock['trigger.message_received'] = fakeNode('trigger.message_received');
    catalogoMock['chat.reply'] = fakeNode('chat.reply');
    const erros = validateGraph({
      nodes: [
        { id: 't', type: 'trigger.message_received' },
        { id: 'orfao', type: 'chat.reply', label: 'Responder' },
      ],
      edges: [],
    });
    expect(erros.join(' ')).toContain('não está conectado');
  });

  it('grafo válido não gera problema', () => {
    catalogoMock['trigger.message_received'] = fakeNode('trigger.message_received');
    catalogoMock['chat.reply'] = fakeNode('chat.reply');
    expect(
      validateGraph({
        nodes: [
          { id: 't', type: 'trigger.message_received' },
          { id: 'r', type: 'chat.reply' },
        ],
        edges: [{ id: 'e', source: 't', target: 'r' }],
      })
    ).toEqual([]);
  });
});

describe('roteamento por ramo', () => {
  it('segue a aresta do ramo devolvido pelo nó', async () => {
    catalogoMock['trigger.message_received'] = fakeNode('trigger.message_received');
    catalogoMock['logic.switch'] = fakeNode('logic.switch', { branch: 'sim' });
    catalogoMock['caminho.sim'] = fakeNode('caminho.sim');
    catalogoMock['caminho.nao'] = fakeNode('caminho.nao');

    const graph: FlowGraph = {
      nodes: [
        { id: 't', type: 'trigger.message_received' },
        { id: 's', type: 'logic.switch' },
        { id: 'sim', type: 'caminho.sim' },
        { id: 'nao', type: 'caminho.nao' },
      ],
      edges: [
        { id: 'e1', source: 't', target: 's' },
        { id: 'e2', source: 's', target: 'sim', branch: 'sim' },
        { id: 'e3', source: 's', target: 'nao' },
      ],
    };

    await executeRun({ ...base, graph });

    const tipos = stepsGravados.map((s) => s.nodeType);
    expect(tipos).toEqual(['trigger.message_received', 'logic.switch', 'caminho.sim']);
  });

  it('sem ramo, cai na saída padrão', async () => {
    catalogoMock['trigger.message_received'] = fakeNode('trigger.message_received');
    catalogoMock['logic.switch'] = fakeNode('logic.switch', {});
    catalogoMock['caminho.nao'] = fakeNode('caminho.nao');

    await executeRun({
      ...base,
      graph: {
        nodes: [
          { id: 't', type: 'trigger.message_received' },
          { id: 's', type: 'logic.switch' },
          { id: 'nao', type: 'caminho.nao' },
        ],
        edges: [
          { id: 'e1', source: 't', target: 's' },
          { id: 'e2', source: 's', target: 'nao' },
        ],
      },
    });

    expect(stepsGravados.map((s) => s.nodeType)).toContain('caminho.nao');
  });
});

describe('parada', () => {
  it('stop encerra o run e registra o motivo', async () => {
    catalogoMock['trigger.message_received'] = fakeNode('trigger.message_received');
    catalogoMock['guard.conditions'] = fakeNode('guard.conditions', {
      stop: true,
      stopReason: 'humano_assumiu',
    });
    catalogoMock['chat.reply'] = fakeNode('chat.reply');

    const r = await executeRun({
      ...base,
      graph: {
        nodes: [
          { id: 't', type: 'trigger.message_received' },
          { id: 'g', type: 'guard.conditions' },
          { id: 'r', type: 'chat.reply' },
        ],
        edges: [
          { id: 'e1', source: 't', target: 'g' },
          { id: 'e2', source: 'g', target: 'r' },
        ],
      },
    });

    expect(r.stopReason).toBe('humano_assumiu');
    // O nó de resposta NÃO pode ter rodado — é a garantia de que a IA não
    // fala por cima do atendente.
    expect(stepsGravados.map((s) => s.nodeType)).not.toContain('chat.reply');
  });

  it('erro em um nó falha o run com a mensagem, sem seguir adiante', async () => {
    catalogoMock['trigger.message_received'] = fakeNode('trigger.message_received');
    const quebrado = fakeNode('ai.agent');
    quebrado.execute = vi.fn(async () => {
      throw new Error('chave OpenAI ausente');
    });
    catalogoMock['ai.agent'] = quebrado;
    catalogoMock['chat.reply'] = fakeNode('chat.reply');

    const r = await executeRun({
      ...base,
      graph: {
        nodes: [
          { id: 't', type: 'trigger.message_received' },
          { id: 'a', type: 'ai.agent' },
          { id: 'r', type: 'chat.reply' },
        ],
        edges: [
          { id: 'e1', source: 't', target: 'a' },
          { id: 'e2', source: 'a', target: 'r' },
        ],
      },
    });

    expect(r.status).toBe('failed');
    expect(r.error).toContain('OpenAI');
    expect(stepsGravados.map((s) => s.nodeType)).not.toContain('chat.reply');
    expect(stepsGravados.at(-1)!.status).toBe('error');
  });
});

describe('trava anti-ciclo', () => {
  it('grafo circular para no teto de passos em vez de rodar pra sempre', async () => {
    catalogoMock['trigger.message_received'] = fakeNode('trigger.message_received');
    catalogoMock['loop'] = fakeNode('loop');

    const r = await executeRun({
      ...base,
      graph: {
        nodes: [
          { id: 't', type: 'trigger.message_received' },
          { id: 'a', type: 'loop' },
          { id: 'b', type: 'loop' },
        ],
        edges: [
          { id: 'e1', source: 't', target: 'a' },
          { id: 'e2', source: 'a', target: 'b' },
          { id: 'e3', source: 'b', target: 'a' }, // ciclo
        ],
      },
    });

    expect(r.stopReason).toBe('teto_de_passos');
    expect(r.steps).toBeLessThanOrEqual(40);
  });
});

describe('variáveis entre nós', () => {
  it('vars de um nó ficam disponíveis pros seguintes', async () => {
    catalogoMock['trigger.message_received'] = fakeNode('trigger.message_received', {
      vars: { agente: { etapa: 'agendado' } },
    });
    const seguinte = fakeNode('crm.apply_stage');
    catalogoMock['crm.apply_stage'] = seguinte;

    await executeRun({
      ...base,
      graph: {
        nodes: [
          { id: 't', type: 'trigger.message_received' },
          { id: 'e', type: 'crm.apply_stage' },
        ],
        edges: [{ id: 'e1', source: 't', target: 'e' }],
      },
    });

    const ctxRecebido = (seguinte.execute as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(ctxRecebido.vars.agente).toEqual({ etapa: 'agendado' });
  });

  it('o modo sombra chega em todo nó', async () => {
    const no = fakeNode('chat.reply');
    catalogoMock['trigger.message_received'] = fakeNode('trigger.message_received');
    catalogoMock['chat.reply'] = no;

    await executeRun({
      ...base,
      shadow: true,
      graph: {
        nodes: [
          { id: 't', type: 'trigger.message_received' },
          { id: 'r', type: 'chat.reply' },
        ],
        edges: [{ id: 'e1', source: 't', target: 'r' }],
      },
    });

    const ctx = (no.execute as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(ctx.shadow).toBe(true);
    // Ator sentinela: os services registram isso em evento, sem FK pra User.
    expect(ctx.actorId).toBe('flow:flow-1');
  });
});

describe('parseGraph / findStartNode', () => {
  it('grafo inválido vira grafo vazio em vez de estourar', () => {
    expect(parseGraph(null)).toEqual({ nodes: [], edges: [] });
    expect(parseGraph({ nodes: 'nao-e-array' })).toEqual({ nodes: [], edges: [] });
  });

  it('acha o gatilho independente da ordem dos nós', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 'r', type: 'chat.reply' },
        { id: 't', type: 'trigger.message_received' },
      ],
      edges: [],
    };
    expect(findStartNode(g)?.id).toBe('t');
  });
});
