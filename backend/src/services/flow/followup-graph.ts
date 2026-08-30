/**
 * T-033 — cadência de follow-up semeada.
 *
 * Follow-up automático tem má fama merecida: espera dois dias, manda "oi, tudo
 * bem? conseguiu ver?", o lead ignora, manda de novo, o lead bloqueia. O erro
 * não é insistir — é insistir SEM OLHAR. A mensagem podia ter sido enviada pra
 * qualquer pessoa, e o lead percebe isso em dois segundos.
 *
 * Por isso a cadência aqui é uma sequência de OBJETIVOS, não de textos. O
 * mesmo agente escreve cada toque, com o histórico e a memória da conversa,
 * mudando só a intenção. O texto nasce na hora.
 *
 * Cada toque repete o mesmo trio — aguardar, conferir, escrever — porque cada
 * espera é uma janela em que a conversa pode ter mudado. Conferir uma vez no
 * começo e confiar por sete dias é como se manda "e aí, pensou na proposta?"
 * pra quem fechou ontem.
 */

import type { FlowGraph } from './types';

/** Espaçamento crescente: cada silêncio é sinal de menos interesse. */
const TOQUES = [
  {
    id: 't1',
    espera: 1,
    objetivo:
      'RETOMAR. Volte ao assunto exato onde a conversa parou — a dúvida que ficou, ' +
      'o valor que ele pediu, o horário que ia confirmar. Nada de "tudo bem?". ' +
      'Se nós prometemos algo e não entregamos, reconheça isso ANTES de qualquer ' +
      'pergunta: cobrar quem está esperando por nós é o pior erro possível.',
  },
  {
    id: 't2',
    espera: 3,
    objetivo:
      'ÂNGULO NOVO. Repetir o pedido não muda a resposta. Traga algo que ainda não ' +
      'foi dito e que responda a objeção mais provável dele — use o que você sabe ' +
      'desta pessoa. Não pergunte de novo o que ela já respondeu.',
  },
  {
    id: 't3',
    espera: 7,
    objetivo:
      'SAÍDA DIGNA. Último contato. Pergunte, sem cobrança, se faz mais sentido você ' +
      'parar de procurar ou retomar mais pra frente. Devolva o controle pra ela. ' +
      'As duas respostas servem: uma reativa a conversa, a outra libera o funil.',
  },
];

const JANELA_COMERCIAL = {
  inicio: '09:00',
  fim: '18:00',
  dias: [1, 2, 3, 4, 5],
  timezone: 'America/Sao_Paulo',
};

/**
 * Monta os três toques. `entradaId` é o nó do fluxo de atendimento que deve
 * apontar para a cadência — normalmente o de resposta.
 */
export function buildFollowupGraph(agentId: string | null = null): FlowGraph {
  const nodes: FlowGraph['nodes'] = [];
  const edges: FlowGraph['edges'] = [];
  let y = 0;

  TOQUES.forEach((toque, i) => {
    const espera = `espera_${toque.id}`;
    const guarda = `guarda_${toque.id}`;
    const escreve = `agente_${toque.id}`;
    const envia = `envia_${toque.id}`;

    nodes.push({
      id: espera,
      type: 'flow.aguardar',
      label: `Aguardar ${toque.espera} dia${toque.espera > 1 ? 's' : ''}`,
      config: {
        valor: toque.espera,
        unidade: 'dias',
        horarioComercial: JANELA_COMERCIAL,
        dispersaoMinutos: 12,
      },
      position: { x: 380, y: (y += 140) },
    });

    nodes.push({
      id: guarda,
      type: 'guard.conditions',
      label: `Ainda cabe falar? (toque ${i + 1})`,
      config: {
        humanoAssumiu: true,
        conversaResolvida: true,
        janelaHumanoMinutos: 240,
        // As duas condições que fazem a cadência ser educada:
        leadFalouPorUltimo: true,
        maxToques: TOQUES.length,
        // O admin edita aqui as etapas terminais do funil dele.
        etiquetasBloqueio: [],
        horarioComercial: JANELA_COMERCIAL,
      },
      position: { x: 380, y: (y += 140) },
    });

    nodes.push({
      id: escreve,
      type: 'ai.agent',
      label: `Escrever toque ${i + 1}`,
      config: { agentId, objetivo: toque.objetivo, salvarEm: 'agente' },
      position: { x: 380, y: (y += 140) },
    });

    nodes.push({
      id: envia,
      type: 'chat.reply',
      label: `Enviar toque ${i + 1}`,
      config: { texto: '{{agente.mensagem_de_resposta}}' },
      position: { x: 380, y: (y += 140) },
    });

    edges.push({ id: `e_${espera}_${guarda}`, source: espera, target: guarda });
    edges.push({ id: `e_${guarda}_${escreve}`, source: guarda, target: escreve });
    edges.push({ id: `e_${escreve}_${envia}`, source: escreve, target: envia });

    // Encadeia com o toque anterior. O primeiro fica solto de propósito: quem
    // liga a cadência ao atendimento é quem semeia, escolhendo de onde ela sai.
    if (i > 0) {
      const anterior = `envia_${TOQUES[i - 1].id}`;
      edges.push({ id: `e_${anterior}_${espera}`, source: anterior, target: espera });
    }
  });

  return { nodes, edges };
}

/** Onde a cadência começa — para quem for costurar no fluxo de atendimento. */
export const FOLLOWUP_ENTRY_NODE = `espera_${TOQUES[0].id}`;

/**
 * Sugestão de trecho pro prompt do agente. Sem isso o agente ignora o objetivo
 * e escreve como se fosse a primeira mensagem.
 */
export const FOLLOWUP_PROMPT_HINT = `
Quando existir um OBJETIVO DESTE PASSO, ele manda:

{{objetivo_do_passo}}

Regra que vale sempre: nunca escreva uma mensagem que poderia ser enviada para
qualquer outra pessoa. Cite algo concreto desta conversa. Se não houver nada
concreto para citar, é sinal de que não era hora de escrever.
`.trim();
