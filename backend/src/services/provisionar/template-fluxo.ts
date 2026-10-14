/**
 * PROVISIONAMENTO — o fluxo "Atendimento — <agente>" montado por template.
 *
 * Só nós que o catálogo (`flow/nodes.ts`) já executa. Em texto:
 *
 *   [gatilho] → [guardas] → [agrupar] → [atender]
 *      ├─ respondeu → [ainda em atendimento?] → [etapa: Em atendimento] → (follow-up…)
 *      ├─ humano    → [etapa: Com humano] → [transferir para atendente]
 *      ├─ encerrou  → [resolver conversa]
 *      └─ agendou   → [etapa: Agendado] → [aguardar até Xh antes] → [lembrete]
 *
 * Decisões que fogem da letra do contrato, e por quê (ver docs/PROVISIONAMENTO.md):
 * - A transcrição de áudio fica no GATILHO (`transcreverAudio`), não num nó
 *   `media.transcribe`: o nó transcreveria de novo o áudio que a entrada já
 *   transcreveu — duas chamadas de Whisper por áudio.
 * - Entre `respondeu` e a etapa "Em atendimento" há um "Só continuar se" com
 *   as etapas Agendado/Fechado/Perdido como bloqueio: aplicar etapa troca a
 *   etapa atual do lead, e sem isto a segunda mensagem de quem acabou de
 *   agendar devolveria o card para "Em atendimento".
 * - ETAPA G: o aviso de transferência sai do PRÓPRIO bloco "Atender"
 *   (`enviarTextoAoTransferir: true`): o texto de orientação que o agente
 *   escreveu vai antes da porta humano, e `transferencia.mensagemAoCliente`
 *   (em `mensagemAoTransferir`) só sai se ele não escreveu nada. O bloco
 *   "Avisar o lead" que existia aqui mandaria a mensagem fixa SEMPRE — duas
 *   mensagens para o lead.
 * - O follow-up segue o trio da cadência existente (aguardar → conferir →
 *   agente escreve → envia), um trio por intervalo de `followup.tentativas`,
 *   dentro de `followup.janela`.
 */

import type { FlowGraph, FlowNode, FlowEdge } from '../flow/types';
import { horasDoIntervalo, type SpecV1 } from './spec';

export interface EtapasDoFluxo {
  /** Slugs reais das etapas na conta (resolvidos no provisionamento). */
  atender: string;
  agendar: string;
  transferir: string;
  /** Slugs das etapas terminais (Fechado/Perdido) — bloqueiam re-etapa e follow-up. */
  terminais: string[];
}

export interface ParametrosDoTemplate {
  agentId: string;
  spec: SpecV1;
  etapas: EtapasDoFluxo;
}

/** Nomes dos nós — fixos para o re-provisionamento manter os ids (runs que dormem retomam por id). */
export const NOS = {
  gatilho: 'gatilho',
  guardas: 'guardas',
  agrupar: 'agrupar',
  atender: 'atende',
  aindaAtendendo: 'ainda_em_atendimento',
  etapaAtender: 'etapa_atender',
  etapaTransferir: 'etapa_transferir',
  transferir: 'transferir',
  resolver: 'resolver',
  etapaAgendar: 'etapa_agendar',
  aguardarReuniao: 'aguardar_reuniao',
  lembrete: 'lembrete',
  followup: (i: number) => ({
    espera: `fu${i}_espera`,
    guarda: `fu${i}_guarda`,
    escreve: `fu${i}_escreve`,
    envia: `fu${i}_envia`,
  }),
} as const;

const X = { esquerda: 60, centro: 380, direita: 700, maisDireita: 1020 };
const PASSO_Y = 140;

/** O lembrete que o lead recebe X horas antes — lê `{{agenda.*}}` gravado pelo bloco de atendimento. */
export const TEXTO_DO_LEMBRETE =
  'Oi! Passando para lembrar: {{agenda.servico}} marcado para {{agenda.rotulo}} com {{agenda.profissional}}. Se precisar remarcar, é só me avisar por aqui.';

/** Horas antes da reunião em que o lembrete sai. */
export const HORAS_ANTES_DO_LEMBRETE = 24;

export function montarGrafo(p: ParametrosDoTemplate): FlowGraph {
  const { agentId, spec, etapas } = p;
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let y = 0;
  const proximoY = () => (y += PASSO_Y);

  const no = (node: FlowNode) => nodes.push(node);
  const liga = (source: string, target: string, branch?: string) =>
    edges.push({ id: `e_${source}_${target}${branch ? `_${branch}` : ''}`, source, target, ...(branch ? { branch } : {}) });

  // ---- Tronco ----
  no({
    id: NOS.gatilho,
    type: 'trigger.message_received',
    label: 'Mensagem recebida',
    config: { agruparSegundos: 15, transcreverAudio: true, idiomaDoAudio: 'pt' },
    position: { x: X.centro, y },
  });
  no({
    id: NOS.guardas,
    type: 'guard.conditions',
    label: 'Só continuar se',
    config: { humanoAssumiu: true, conversaResolvida: true, janelaHumanoMinutos: 30, etiquetasBloqueio: [] },
    position: { x: X.centro, y: proximoY() },
  });
  no({
    id: NOS.agrupar,
    type: 'buffer.debounce',
    label: 'Agrupar mensagens',
    config: { segundos: 15 },
    position: { x: X.centro, y: proximoY() },
  });
  no({
    id: NOS.atender,
    type: 'ai.atender',
    label: `Atender com ${spec.agente.nome}`,
    config: {
      agentId,
      salvarEm: 'agente',
      // A rota "humano" do schema é TRAVA de código: o lead vai para a
      // porta humano mesmo que a IA tenha escrito uma resposta.
      rotasSempreHumano: ['humano'],
      // ETAPA G: o que a IA escreveu ao transferir (1–2 frases de
      // orientação, pedidas no prompt) É enviado antes da transferência…
      enviarTextoAoTransferir: true,
      // …e a mensagem fixa do spec só sai se ela não escreveu nada.
      mensagemAoTransferir: spec.transferencia.mensagemAoCliente,
    },
    position: { x: X.centro, y: proximoY() },
  });
  liga(NOS.gatilho, NOS.guardas);
  liga(NOS.guardas, NOS.agrupar);
  liga(NOS.agrupar, NOS.atender);

  const yPortas = proximoY();

  // ---- Porta RESPONDEU (coluna do centro) ----
  no({
    id: NOS.aindaAtendendo,
    type: 'guard.conditions',
    label: 'Ainda em atendimento?',
    config: {
      humanoAssumiu: true,
      conversaResolvida: true,
      janelaHumanoMinutos: 30,
      etiquetasBloqueio: [etapas.agendar, ...etapas.terminais],
    },
    position: { x: X.centro, y: yPortas },
  });
  no({
    id: NOS.etapaAtender,
    type: 'crm.apply_stage',
    label: `Etapa: ${spec.funil.etapaAoAtender}`,
    config: { etapa: etapas.atender },
    position: { x: X.centro, y: yPortas + PASSO_Y },
  });
  liga(NOS.atender, NOS.aindaAtendendo, 'respondeu');
  liga(NOS.aindaAtendendo, NOS.etapaAtender);

  // ---- Porta HUMANO (coluna da direita) ----
  // O aviso ao lead já saiu do bloco "Atender" (ver cabeçalho).
  no({
    id: NOS.etapaTransferir,
    type: 'crm.apply_stage',
    label: `Etapa: ${spec.funil.etapaAoTransferir}`,
    config: { etapa: etapas.transferir },
    position: { x: X.direita, y: yPortas },
  });
  no({
    id: NOS.transferir,
    type: 'chat.assign_human',
    label: 'Transferir para atendente',
    config: {},
    position: { x: X.direita, y: yPortas + PASSO_Y },
  });
  liga(NOS.atender, NOS.etapaTransferir, 'humano');
  liga(NOS.etapaTransferir, NOS.transferir);

  // ---- Porta ENCERROU (coluna da esquerda) ----
  no({
    id: NOS.resolver,
    type: 'chat.resolve',
    label: 'Resolver conversa',
    config: { outcome: 'resolved', motivo: `Encerrada por ${spec.agente.nome}` },
    position: { x: X.esquerda, y: yPortas },
  });
  liga(NOS.atender, NOS.resolver, 'encerrou');

  // ---- Porta AGENDOU (coluna mais à direita) ----
  if (spec.agenda.ativo) {
    no({
      id: NOS.etapaAgendar,
      type: 'crm.apply_stage',
      label: `Etapa: ${spec.funil.etapaAoAgendar}`,
      config: { etapa: etapas.agendar },
      position: { x: X.maisDireita, y: yPortas },
    });
    no({
      id: NOS.aguardarReuniao,
      type: 'flow.aguardar',
      label: `Aguardar até ${HORAS_ANTES_DO_LEMBRETE}h antes da reunião`,
      config: { modo: 'antes_da_reuniao', antesHoras: HORAS_ANTES_DO_LEMBRETE },
      position: { x: X.maisDireita, y: yPortas + PASSO_Y },
    });
    no({
      id: NOS.lembrete,
      type: 'chat.reply',
      label: 'Lembrete da reunião',
      config: { texto: TEXTO_DO_LEMBRETE },
      position: { x: X.maisDireita, y: yPortas + 2 * PASSO_Y },
    });
    liga(NOS.atender, NOS.etapaAgendar, 'agendou');
    liga(NOS.etapaAgendar, NOS.aguardarReuniao);
    liga(NOS.aguardarReuniao, NOS.lembrete);
  }

  // ---- Follow-up (continua a coluna do centro) ----
  if (spec.followup.ativo) {
    let anterior: string = NOS.etapaAtender;
    let yFu = yPortas + 2 * PASSO_Y;
    const tentativas = spec.followup.tentativas;

    for (let i = 1; i <= tentativas.length; i++) {
      const ids = NOS.followup(i);
      // ETAPA G: cada toque tem o próprio intervalo ("2h", "1d", "3d").
      const horas = horasDoIntervalo(tentativas[i - 1]);
      no({
        id: ids.espera,
        type: 'flow.aguardar',
        label: `Aguardar ${rotuloDeHoras(horas)}`,
        config: {
          valor: horas,
          unidade: 'horas',
          horarioComercial: janelaComercial(spec),
          dispersaoMinutos: 12,
        },
        position: { x: X.centro, y: yFu },
      });
      no({
        id: ids.guarda,
        type: 'guard.conditions',
        label: `Ainda cabe falar? (toque ${i})`,
        config: {
          humanoAssumiu: true,
          conversaResolvida: true,
          janelaHumanoMinutos: 240,
          leadFalouPorUltimo: true,
          maxToques: tentativas.length,
          etiquetasBloqueio: [etapas.agendar, etapas.transferir, ...etapas.terminais],
          horarioComercial: janelaComercial(spec),
        },
        position: { x: X.centro, y: yFu + PASSO_Y },
      });
      no({
        id: ids.escreve,
        type: 'ai.agent',
        label: `Escrever toque ${i}`,
        config: { agentId, objetivo: objetivoDoToque(spec, i), salvarEm: 'agente' },
        position: { x: X.centro, y: yFu + 2 * PASSO_Y },
      });
      no({
        id: ids.envia,
        type: 'chat.reply',
        label: `Enviar toque ${i}`,
        config: { texto: '{{agente.mensagem_de_resposta}}' },
        position: { x: X.centro, y: yFu + 3 * PASSO_Y },
      });
      liga(anterior, ids.espera);
      liga(ids.espera, ids.guarda);
      liga(ids.guarda, ids.escreve);
      liga(ids.escreve, ids.envia);
      anterior = ids.envia;
      yFu += 4 * PASSO_Y;
    }
  }

  return { nodes, edges };
}

/** "2h", "1 dia", "3 dias" — o rótulo do bloco no canvas. */
export function rotuloDeHoras(horas: number): string {
  if (horas % 24 === 0) return `${horas / 24} dia${horas / 24 > 1 ? 's' : ''}`;
  return `${horas}h`;
}

/**
 * O objetivo de cada toque — segue a régua da cadência semeada (retomar →
 * ângulo novo → saída digna), com a mensagem de referência do spec: a do
 * toque (`followup.mensagens[i-1]`) se houver, senão a geral (`mensagem`).
 */
function objetivoDoToque(spec: SpecV1, i: number): string {
  const mensagem = (spec.followup.mensagens[i - 1] ?? spec.followup.mensagem).trim();
  const referencia = `Mensagem de referência (adapte; onde estiver {{nome}}, use o nome do lead se souber, senão omita): "${mensagem}"`;
  const ultimo = i === spec.followup.tentativas.length;
  if (i === 1) {
    return (
      'FOLLOW-UP, toque 1 — RETOMAR. O lead parou de responder. Volte ao ponto exato onde a conversa parou ' +
      '(a dúvida, o horário que ia confirmar, o que ficou pendente). Nada de "tudo bem?". Curto, uma pergunta só. ' +
      referencia
    );
  }
  if (!ultimo) {
    return (
      `FOLLOW-UP, toque ${i} — ÂNGULO NOVO. Repetir o pedido não muda a resposta: traga algo útil que ainda não foi dito ` +
      '(um diferencial, um horário, uma informação que responda a objeção provável). Não pergunte o que ele já respondeu. ' +
      referencia
    );
  }
  return (
    `FOLLOW-UP, toque ${i} — SAÍDA DIGNA. Último contato: pergunte, sem cobrança, se faz sentido retomar mais pra frente ` +
    'ou se prefere que você não insista. Devolva o controle para a pessoa. ' +
    referencia
  );
}

/**
 * A janela em que o follow-up pode sair: horas de `followup.janela` (padrão
 * 08:00–20:00, já resolvido no spec) nos dias de expediente da agenda — ou
 * segunda a sexta quando não há agenda.
 */
function janelaComercial(spec: SpecV1): { inicio: string; fim: string; dias: number[]; timezone: string } {
  const faixas = spec.agenda.horarios;
  const timezone = spec.agenda.fuso?.trim() || 'America/Sao_Paulo';
  const dias = faixas.length > 0 ? Array.from(new Set(faixas.flatMap((f) => f.dias))).sort() : [1, 2, 3, 4, 5];
  return { inicio: spec.followup.janela.inicio, fim: spec.followup.janela.fim, dias, timezone };
}

/** Nome do fluxo provisionado — fixo, é por ele que o re-provisionamento o reencontra. */
export function nomeDoFluxo(nomeDoAgente: string): string {
  return `Atendimento — ${nomeDoAgente.trim()}`;
}
