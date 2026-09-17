/**
 * T-028 Fase 2 — fluxo de atendimento padrão.
 *
 * É a tradução do workflow `I.A-SDR-Gleps-DEFINITIVO` (62 nós do n8n) para o
 * catálogo daqui. Os 62 viram 10 porque a maior parte daquele grafo era
 * encanamento — 17 chamadas HTTP de volta pro CRM, merges e switches de
 * roteamento — que aqui é chamada direta de service.
 *
 * O que sobrou é a lógica de atendimento de verdade:
 *   mensagem → guardas → agrupa → transcreve → agente → etapa no kanban
 *            → transferir? → responder → resolver?
 *
 * O nó do agente nasce SEM agente selecionado de propósito: a validação recusa
 * ativar até você escolher, o que força a decisão consciente de qual prompt vai
 * atender seu lead.
 */

import type { FlowGraph } from './types';

/**
 * Schema de saída sugerido para o agente usado neste fluxo. Espelha o
 * `Output_Parser_Resposta1` do n8n — é o que faz `{{agente.*}}` funcionar nos
 * nós seguintes.
 *
 * O enum de `etapa` vem de FORA, das etapas cadastradas na conta. Seis slugs
 * fixos aqui eram uma verdade que não existia em conta nenhuma: o modelo
 * devolvia "agendado", o fluxo criava uma etiqueta com esse nome e o kanban de
 * verdade ficava intocado. Sem etapa cadastrada o enum sai vazio — e em
 * runtime a propriedade nem é enviada ao modelo.
 */
export function buildSuggestedAgentSchema(etapas: readonly string[]) {
  return {
    type: 'object',
    properties: {
      mensagem_de_resposta: {
        type: 'string',
        description: 'O que responder ao lead, pronto para enviar no WhatsApp.',
      },
      etapa: {
        type: 'string',
        enum: [...etapas],
        description: 'Etapa do funil que melhor descreve a conversa agora (use o nome exato).',
      },
      transferir_para_humano: {
        type: 'boolean',
        description: 'true quando o lead pede atendente humano ou o caso sai do script.',
      },
      resolver_conversa: {
        type: 'boolean',
        description: 'true quando o atendimento terminou e nada mais é esperado.',
      },
    },
    required: ['mensagem_de_resposta', 'etapa', 'transferir_para_humano'],
  } as const;
}

export function buildDefaultGraph(agentId: string | null = null): FlowGraph {
  return {
    nodes: [
      {
        id: 'gatilho',
        type: 'trigger.message_received',
        label: 'Mensagem recebida',
        config: {},
        position: { x: 380, y: 0 },
      },
      {
        id: 'guardas',
        type: 'guard.conditions',
        label: 'Só continuar se',
        config: {
          humanoAssumiu: true,
          conversaResolvida: true,
          janelaHumanoMinutos: 30,
          etiquetasBloqueio: [],
        },
        position: { x: 380, y: 140 },
      },
      {
        id: 'agrupar',
        type: 'buffer.debounce',
        label: 'Agrupar mensagens',
        config: { segundos: 15 },
        position: { x: 380, y: 280 },
      },
      {
        // O BLOCO COMPOSTO. Antes eram seis passos aqui — agente, etapa,
        // condição, resposta, condição, e as duas decisões lidas de variável.
        // Eram SEMPRE os mesmos seis: o n8n é granular porque serve qualquer
        // automação, e aqui o domínio é um só.
        id: 'atende',
        type: 'ai.atender',
        label: 'Atender com IA',
        config: {
          agentId,
          salvarEm: 'agente',
          // Assuntos que nunca são atendidos pela IA. Fica vazio de propósito:
          // é decisão de negócio de cada cliente, e um padrão nosso aqui seria
          // palpite sobre o negócio dele.
          rotasSempreHumano: [],
        },
        position: { x: 380, y: 420 },
      },
      {
        id: 'transferir',
        type: 'chat.assign_human',
        label: 'Transferir para atendente',
        config: {},
        position: { x: 660, y: 600 },
      },
      {
        id: 'resolver',
        type: 'chat.resolve',
        label: 'Resolver conversa',
        config: { outcome: 'resolved' },
        position: { x: 100, y: 600 },
      },
    ],
    edges: [
      { id: 'e1', source: 'gatilho', target: 'guardas' },
      { id: 'e2', source: 'guardas', target: 'agrupar' },
      { id: 'e3', source: 'agrupar', target: 'atende' },
      // As decisões do agente são PORTAS do bloco, não nós de condição soltos.
      // "respondeu" não tem aresta: a maioria das mensagens acaba aqui, e o
      // fluxo simplesmente termina esperando a próxima.
      { id: 'e4', source: 'atende', target: 'transferir', branch: 'humano' },
      { id: 'e5', source: 'atende', target: 'resolver', branch: 'encerrou' },
    ],
  };
}
