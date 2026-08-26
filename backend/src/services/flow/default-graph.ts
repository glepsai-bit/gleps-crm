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
 */
export const SUGGESTED_AGENT_SCHEMA = {
  type: 'object',
  properties: {
    mensagem_de_resposta: {
      type: 'string',
      description: 'O que responder ao lead, pronto para enviar no WhatsApp.',
    },
    etapa: {
      type: 'string',
      enum: [
        'novo-lead',
        'em-atendimento',
        'aguardando-resposta',
        'agendado',
        'convertido',
        'perdido',
      ],
      description: 'Etapa do funil que melhor descreve a conversa agora.',
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
        position: { x: 380, y: 130 },
      },
      {
        id: 'agrupar',
        type: 'buffer.debounce',
        label: 'Agrupar mensagens',
        // 15s: o lead costuma mandar 2-3 mensagens seguidas. Sem isso a IA
        // responde a primeira e atropela o resto do raciocínio dele.
        config: { segundos: 15 },
        position: { x: 380, y: 260 },
      },
      {
        id: 'transcrever',
        type: 'media.transcribe',
        label: 'Transcrever áudio',
        config: { idioma: 'pt' },
        position: { x: 380, y: 390 },
      },
      {
        id: 'agente',
        type: 'ai.agent',
        label: 'Agente de atendimento',
        config: { agentId: agentId ?? '', salvarEm: 'agente' },
        position: { x: 380, y: 520 },
      },
      {
        id: 'etapa',
        type: 'crm.apply_stage',
        label: 'Aplicar etapa no kanban',
        config: { etapa: '{{agente.etapa}}' },
        position: { x: 380, y: 650 },
      },
      {
        id: 'quer_humano',
        type: 'logic.switch',
        label: 'Pediu humano?',
        config: {
          variavel: 'agente.transferir_para_humano',
          casos: [{ valor: 'true', branch: 'sim' }],
        },
        position: { x: 380, y: 780 },
      },
      {
        id: 'transferir',
        type: 'chat.assign_human',
        label: 'Transferir para atendente',
        config: {},
        position: { x: 700, y: 910 },
      },
      {
        id: 'responder',
        type: 'chat.reply',
        label: 'Responder no WhatsApp',
        config: { texto: '{{agente.mensagem_de_resposta}}' },
        position: { x: 100, y: 910 },
      },
      {
        id: 'quer_resolver',
        type: 'logic.switch',
        label: 'Encerrar conversa?',
        config: {
          variavel: 'agente.resolver_conversa',
          casos: [{ valor: 'true', branch: 'sim' }],
        },
        position: { x: 100, y: 1040 },
      },
      {
        id: 'resolver',
        type: 'chat.resolve',
        label: 'Resolver conversa',
        config: { outcome: 'resolved', pedirCsat: false },
        position: { x: 100, y: 1170 },
      },
    ],
    edges: [
      { id: 'e1', source: 'gatilho', target: 'guardas' },
      { id: 'e2', source: 'guardas', target: 'agrupar' },
      { id: 'e3', source: 'agrupar', target: 'transcrever' },
      { id: 'e4', source: 'transcrever', target: 'agente' },
      { id: 'e5', source: 'agente', target: 'etapa' },
      { id: 'e6', source: 'etapa', target: 'quer_humano' },
      // Pediu humano → transfere e encerra o fluxo (o atendente assume daqui).
      { id: 'e7', source: 'quer_humano', target: 'transferir', branch: 'sim' },
      // Caminho normal → responde.
      { id: 'e8', source: 'quer_humano', target: 'responder' },
      // Ninguém online pra receber → responde assim mesmo, pra não deixar o
      // lead no vácuo enquanto espera atendimento.
      { id: 'e9', source: 'transferir', target: 'responder', branch: 'sem_atendente' },
      { id: 'e10', source: 'responder', target: 'quer_resolver' },
      { id: 'e11', source: 'quer_resolver', target: 'resolver', branch: 'sim' },
    ],
  };
}
