/**
 * PROVISIONAMENTO — o grafo gerado passa em `validateGraph()` com e sem agenda
 * e follow-up, e as portas do "Atender com IA" saem para os blocos certos.
 */

import { describe, it, expect } from 'vitest';
import { validateGraph } from '../flow/engine';
import { montarGrafo, nomeDoFluxo, NOS, TEXTO_DO_LEMBRETE } from './template-fluxo';
import { validarSpec } from './spec';
import { SPEC_MINIMO, SPEC_CLINICA } from './fixtures.test-util';

const ETAPAS = { atender: 'em-atendimento', agendar: 'agendado', transferir: 'com-humano', terminais: ['fechado', 'perdido'] };
const AGENT = '11111111-1111-4111-8111-111111111111';

const porta = (g: ReturnType<typeof montarGrafo>, branch: string) =>
  g.edges.find((e) => e.source === NOS.atender && e.branch === branch)?.target;
const no = (g: ReturnType<typeof montarGrafo>, id: string) => g.nodes.find((n) => n.id === id);

describe('grafo com agenda e follow-up (clínica)', () => {
  const g = montarGrafo({ agentId: AGENT, spec: validarSpec(SPEC_CLINICA), etapas: ETAPAS });

  it('passa em validateGraph', () => {
    expect(validateGraph(g)).toEqual([]);
  });

  it('tronco: gatilho (transcrição ligada) → guardas → agrupar → atender', () => {
    expect(no(g, NOS.gatilho)?.config).toEqual({ agruparSegundos: 15, transcreverAudio: true, idiomaDoAudio: 'pt' });
    const seq = ['gatilho', 'guardas', 'agrupar', 'atende'];
    for (let i = 0; i < seq.length - 1; i++) {
      expect(g.edges.some((e) => e.source === seq[i] && e.target === seq[i + 1] && !e.branch)).toBe(true);
    }
    expect(no(g, NOS.atender)?.config).toMatchObject({ agentId: AGENT, rotasSempreHumano: ['humano'], mensagemAoTransferir: '' });
  });

  it('porta respondeu → "Ainda em atendimento?" (bloqueia Agendado/Fechado/Perdido) → etapa Em atendimento', () => {
    expect(porta(g, 'respondeu')).toBe(NOS.aindaAtendendo);
    expect(no(g, NOS.aindaAtendendo)?.config).toMatchObject({ etiquetasBloqueio: ['agendado', 'fechado', 'perdido'] });
    expect(g.edges.some((e) => e.source === NOS.aindaAtendendo && e.target === NOS.etapaAtender)).toBe(true);
    expect(no(g, NOS.etapaAtender)?.config).toEqual({ etapa: 'em-atendimento' });
  });

  it('porta humano → avisar o lead → etapa Com humano → transferir para atendente', () => {
    expect(porta(g, 'humano')).toBe(NOS.avisar);
    expect(no(g, NOS.avisar)?.config).toEqual({ texto: 'Vou chamar alguém da equipe para te ajudar, um instante.' });
    expect(g.edges.some((e) => e.source === NOS.avisar && e.target === NOS.etapaTransferir)).toBe(true);
    expect(no(g, NOS.etapaTransferir)?.config).toEqual({ etapa: 'com-humano' });
    expect(g.edges.some((e) => e.source === NOS.etapaTransferir && e.target === NOS.transferir)).toBe(true);
    expect(no(g, NOS.transferir)?.type).toBe('chat.assign_human');
  });

  it('porta encerrou → resolver; porta agendou → etapa Agendado → aguardar antes da reunião → lembrete', () => {
    expect(porta(g, 'encerrou')).toBe(NOS.resolver);
    expect(porta(g, 'agendou')).toBe(NOS.etapaAgendar);
    expect(no(g, NOS.etapaAgendar)?.config).toEqual({ etapa: 'agendado' });
    expect(no(g, NOS.aguardarReuniao)?.config).toEqual({ modo: 'antes_da_reuniao', antesHoras: 24 });
    expect(no(g, NOS.lembrete)?.config).toEqual({ texto: TEXTO_DO_LEMBRETE });
  });

  it('follow-up: 2 toques no trio aguardar → conferir → escrever → enviar, encadeados após a etapa', () => {
    const t1 = NOS.followup(1);
    const t2 = NOS.followup(2);
    expect(g.edges.some((e) => e.source === NOS.etapaAtender && e.target === t1.espera)).toBe(true);
    expect(no(g, t1.espera)?.config).toMatchObject({ valor: 24, unidade: 'horas' });
    expect(no(g, t1.guarda)?.config).toMatchObject({ leadFalouPorUltimo: true, maxToques: 2 });
    expect(no(g, t1.escreve)?.type).toBe('ai.agent');
    expect(String(no(g, t1.escreve)?.config?.objetivo)).toContain('RETOMAR');
    expect(String(no(g, t1.escreve)?.config?.objetivo)).toContain('Oi {{nome}}, ficou alguma dúvida?');
    expect(no(g, t1.envia)?.config).toEqual({ texto: '{{agente.mensagem_de_resposta}}' });
    expect(g.edges.some((e) => e.source === t1.envia && e.target === t2.espera)).toBe(true);
    expect(String(no(g, t2.escreve)?.config?.objetivo)).toContain('SAÍDA DIGNA');
    expect(no(g, NOS.followup(3).espera)).toBeUndefined();
  });

  it('todo nó tem posição no canvas, sem dois no mesmo lugar', () => {
    const pos = g.nodes.map((n) => `${n.position?.x},${n.position?.y}`);
    expect(pos.every((p) => !p.includes('undefined'))).toBe(true);
    expect(new Set(pos).size).toBe(pos.length);
  });
});

describe('grafo sem agenda e sem follow-up (mínimo)', () => {
  const g = montarGrafo({ agentId: AGENT, spec: validarSpec(SPEC_MINIMO), etapas: ETAPAS });

  it('passa em validateGraph e não tem porta agendou nem toques', () => {
    expect(validateGraph(g)).toEqual([]);
    expect(porta(g, 'agendou')).toBeUndefined();
    expect(no(g, NOS.etapaAgendar)).toBeUndefined();
    expect(no(g, NOS.followup(1).espera)).toBeUndefined();
    expect(g.nodes.map((n) => n.type)).not.toContain('ai.agent');
  });
});

describe('sem agente', () => {
  it('validateGraph acusa o nó sem agente — é o que impede publicar um fluxo quebrado', () => {
    const g = montarGrafo({ agentId: '', spec: validarSpec(SPEC_MINIMO), etapas: ETAPAS });
    expect(validateGraph(g).join(' ')).toContain('sem agente selecionado');
  });
});

describe('nomeDoFluxo', () => {
  it('é fixo por agente', () => {
    expect(nomeDoFluxo(' Bia ')).toBe('Atendimento — Bia');
  });
});
