/**
 * PROVISIONAMENTO — o grafo gerado passa em `validateGraph()` com e sem agenda
 * e follow-up, e as portas do "Atender com IA" saem para os blocos certos.
 *
 * ETAPA G: o aviso de transferência sai do próprio bloco "Atender"
 * (`enviarTextoAoTransferir` + `mensagemAoTransferir`), e o follow-up tem um
 * toque por intervalo de `followup.tentativas`, dentro de `followup.janela`.
 */

import { describe, it, expect } from 'vitest';
import { validateGraph } from '../flow/engine';
import { montarGrafo, nomeDoFluxo, rotuloDeHoras, NOS, TEXTO_DO_LEMBRETE } from './template-fluxo';
import { validarSpec } from './spec';
import { SPEC_MINIMO, SPEC_CLINICA, SPEC_SDR } from './fixtures.test-util';

const ETAPAS = { atender: 'em-atendimento', agendar: 'agendado', transferir: 'com-humano', terminais: ['fechado', 'perdido'] };
const AGENT = '11111111-1111-4111-8111-111111111111';

const porta = (g: ReturnType<typeof montarGrafo>, branch: string) =>
  g.edges.find((e) => e.source === NOS.atender && e.branch === branch)?.target;
const no = (g: ReturnType<typeof montarGrafo>, id: string) => g.nodes.find((n) => n.id === id);

describe('grafo com agenda e follow-up (clínica, compat v1)', () => {
  const g = montarGrafo({ agentId: AGENT, spec: validarSpec(SPEC_CLINICA), etapas: ETAPAS });

  it('passa em validateGraph', () => {
    expect(validateGraph(g)).toEqual([]);
  });

  it('tronco: gatilho (transcrição ligada) → guardas → agrupar → atender, que envia o texto do agente ao transferir', () => {
    expect(no(g, NOS.gatilho)?.config).toEqual({ agruparSegundos: 15, transcreverAudio: true, idiomaDoAudio: 'pt' });
    const seq = ['gatilho', 'guardas', 'agrupar', 'atende'];
    for (let i = 0; i < seq.length - 1; i++) {
      expect(g.edges.some((e) => e.source === seq[i] && e.target === seq[i + 1] && !e.branch)).toBe(true);
    }
    expect(no(g, NOS.atender)?.config).toEqual({
      agentId: AGENT,
      salvarEm: 'agente',
      rotasSempreHumano: ['humano'],
      enviarTextoAoTransferir: true,
      mensagemAoTransferir: 'Vou chamar alguém da equipe para te ajudar, um instante.',
    });
  });

  it('porta respondeu → "Ainda em atendimento?" (bloqueia Agendado/Fechado/Perdido) → etapa Em atendimento', () => {
    expect(porta(g, 'respondeu')).toBe(NOS.aindaAtendendo);
    expect(no(g, NOS.aindaAtendendo)?.config).toMatchObject({ etiquetasBloqueio: ['agendado', 'fechado', 'perdido'] });
    expect(g.edges.some((e) => e.source === NOS.aindaAtendendo && e.target === NOS.etapaAtender)).toBe(true);
    expect(no(g, NOS.etapaAtender)?.config).toEqual({ etapa: 'em-atendimento' });
  });

  it('porta humano → etapa Com humano → transferir para atendente (sem bloco "Avisar o lead": o aviso já saiu do Atender)', () => {
    expect(porta(g, 'humano')).toBe(NOS.etapaTransferir);
    expect(no(g, 'avisar_transferencia')).toBeUndefined();
    expect(g.nodes.filter((n) => n.type === 'chat.reply').map((n) => n.id)).not.toContain('avisar_transferencia');
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

  it('follow-up compat (aposHoras 24, maxTentativas 2): 2 toques de 24h, janela padrão 08–20 nos dias da agenda', () => {
    const t1 = NOS.followup(1);
    const t2 = NOS.followup(2);
    expect(g.edges.some((e) => e.source === NOS.etapaAtender && e.target === t1.espera)).toBe(true);
    expect(no(g, t1.espera)?.config).toEqual({
      valor: 24,
      unidade: 'horas',
      horarioComercial: { inicio: '08:00', fim: '20:00', dias: [1, 2, 3, 4, 5], timezone: 'America/Sao_Paulo' },
      dispersaoMinutos: 12,
    });
    expect(no(g, t1.espera)?.label).toBe('Aguardar 1 dia');
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

describe('follow-up v1.1 (SDR): tentativas ["2h","1d","3d"], janela 09–19, mensagem por toque', () => {
  const g = montarGrafo({ agentId: AGENT, spec: validarSpec(SPEC_SDR), etapas: ETAPAS });

  it('passa em validateGraph e tem 3 toques com o intervalo de cada um', () => {
    expect(validateGraph(g)).toEqual([]);
    expect(no(g, NOS.followup(1).espera)?.config).toMatchObject({ valor: 2, unidade: 'horas' });
    expect(no(g, NOS.followup(2).espera)?.config).toMatchObject({ valor: 24, unidade: 'horas' });
    expect(no(g, NOS.followup(3).espera)?.config).toMatchObject({ valor: 72, unidade: 'horas' });
    expect(no(g, NOS.followup(4).espera)).toBeUndefined();
    expect([1, 2, 3].map((i) => no(g, NOS.followup(i).espera)?.label)).toEqual(['Aguardar 2h', 'Aguardar 1 dia', 'Aguardar 3 dias']);
  });

  it('a janela do spec vale na espera e na guarda, nos dias da agenda; teto de toques = 3', () => {
    const janela = { inicio: '09:00', fim: '19:00', dias: [2, 3, 4, 5, 6], timezone: 'America/Sao_Paulo' };
    expect(no(g, NOS.followup(1).espera)?.config).toMatchObject({ horarioComercial: janela });
    expect(no(g, NOS.followup(3).guarda)?.config).toMatchObject({ horarioComercial: janela, maxToques: 3 });
  });

  it('cada toque leva a própria mensagem de referência; o último é a saída digna', () => {
    expect(String(no(g, NOS.followup(1).escreve)?.config?.objetivo)).toContain('ficou alguma dúvida sobre a avaliação?');
    expect(String(no(g, NOS.followup(2).escreve)?.config?.objetivo)).toContain('ÂNGULO NOVO');
    expect(String(no(g, NOS.followup(2).escreve)?.config?.objetivo)).toContain('Passando pra lembrar que a avaliação é gratuita.');
    expect(String(no(g, NOS.followup(3).escreve)?.config?.objetivo)).toContain('SAÍDA DIGNA');
    expect(String(no(g, NOS.followup(3).escreve)?.config?.objetivo)).toContain('retomo em outro momento');
  });

  it('rotuloDeHoras', () => {
    expect(rotuloDeHoras(2)).toBe('2h');
    expect(rotuloDeHoras(24)).toBe('1 dia');
    expect(rotuloDeHoras(72)).toBe('3 dias');
    expect(rotuloDeHoras(36)).toBe('36h');
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
