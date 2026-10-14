/**
 * T-033 — dormir, acordar e não falar besteira.
 *
 * O que está sob teste não é "consegue esperar" — é RESTRIÇÃO. Um follow-up
 * que dispara sempre é trivial de escrever e destrói funil: cobra quem está
 * esperando resposta, fala por cima do atendente, insiste depois do terceiro
 * silêncio. Quase todo caso aqui verifica que a mensagem NÃO sai.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  conversation: { findFirst: vi.fn() },
  // count: a ordem dos passos continua de onde parou na retomada, então o
  // motor conta os que já existem antes de seguir.
  flowRunStep: { create: vi.fn(), count: vi.fn() },
}));

vi.mock('../../config/database', () => ({ prisma: prismaMock }));
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { NODE_CATALOG, proximaJanelaUtil } from './nodes';
import { executeRun } from './engine';
import type { FlowGraph, FlowNode, NodeContext } from './types';
import { montarGrafo, NOS } from '../provisionar/template-fluxo';
import { validarSpec } from '../provisionar/spec';
import { SPEC_CLINICA } from '../provisionar/fixtures.test-util';

const espera = NODE_CATALOG['flow.aguardar'];
const guarda = NODE_CATALOG['guard.conditions'];

const ctx = (vars: Record<string, unknown> = {}): NodeContext =>
  ({
    accountId: 'acc-1',
    runId: 'run-1',
    flowId: 'flow-1',
    conversationId: 'conv-1',
    shadow: false,
    actorId: 'flow:flow-1',
    vars,
  }) as NodeContext;

const no = (config: Record<string, unknown>): FlowNode => ({
  id: 'n',
  type: 'flow.aguardar',
  config,
});

// ============================================
// O nó de espera
// ============================================
describe('Aguardar — dorme em vez de travar', () => {
  it('devolve na hora e pede sono futuro, sem segurar processo', async () => {
    const t0 = Date.now();
    const r = await espera.execute(no({ valor: 2, unidade: 'dias' }), ctx());

    // O ponto: dois dias de espera não custam dois dias de processo.
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.sleep).toBeDefined();
    expect(r.sleep!.until.getTime()).toBeGreaterThan(t0 + 1.9 * 86_400_000);
  });

  it('teto de 60 dias — acima disso não é follow-up, é reativação', async () => {
    const r = await espera.execute(no({ valor: 900, unidade: 'dias' }), ctx());
    const dias = (r.sleep!.until.getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeLessThanOrEqual(61);
  });

  it('no simulador não dorme — ninguém espera dois dias olhando a tela', async () => {
    const r = await espera.execute(no({ valor: 2, unidade: 'dias' }), ctx({ __simulador: true }));
    expect(r.sleep).toBeUndefined();
    expect(r.output).toMatchObject({ pulado: 'simulador' });
  });

  it('dispersa os horários — 200 follow-ups às 9h em ponto é padrão de robô', async () => {
    const horas = new Set<number>();
    for (let i = 0; i < 25; i++) {
      const r = await espera.execute(
        no({ valor: 1, unidade: 'minutos', dispersaoMinutos: 30 }),
        ctx()
      );
      horas.add(r.sleep!.until.getTime());
    }
    // Se todos caíssem no mesmo instante, seria 1.
    expect(horas.size).toBeGreaterThan(5);
  });
});

describe('janela comercial', () => {
  const JANELA = { inicio: '09:00', fim: '18:00', dias: [1, 2, 3, 4, 5], timezone: 'UTC' };

  it('empurra madrugada para o expediente — 3h da manhã é pior que nada', () => {
    // Quarta-feira, 03:00 UTC.
    const madrugada = new Date('2026-06-10T03:00:00Z');
    const ajustado = proximaJanelaUtil(madrugada, JANELA);
    expect(ajustado.getTime()).toBeGreaterThan(madrugada.getTime());
    expect(ajustado.getUTCHours()).toBeGreaterThanOrEqual(9);
    expect(ajustado.getUTCHours()).toBeLessThanOrEqual(18);
  });

  it('atravessa o fim de semana até segunda', () => {
    // Sábado, 10:00 UTC — dentro do horário, mas fora dos dias.
    const sabado = new Date('2026-06-13T10:00:00Z');
    const ajustado = proximaJanelaUtil(sabado, JANELA);
    expect(ajustado.getUTCDay()).toBe(1); // segunda
  });

  it('hora que já está boa não é mexida', () => {
    const quarta = new Date('2026-06-10T14:00:00Z');
    expect(proximaJanelaUtil(quarta, JANELA).getTime()).toBe(quarta.getTime());
  });

  it('a dispersão entra ANTES de encaixar na janela: o toque marcado para o fim do expediente não sai dele (a guarda o descartaria)', async () => {
    // Quarta 17:50 UTC, janela 09–18: +5 min = 17:55 (dentro). Com a dispersão máxima (~12 min) somada
    // DEPOIS do encaixe virava 18:07 — fora do horário.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-10T17:50:00Z'));
    const sorteio = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      const r = await espera.execute(no({ valor: 5, unidade: 'minutos', dispersaoMinutos: 12, horarioComercial: JANELA }), ctx());
      const ate = r.sleep!.until;
      expect(ate.getTime()).toBeGreaterThan(Date.now());
      expect(proximaJanelaUtil(ate, JANELA).getTime()).toBe(ate.getTime()); // já está dentro: nada a empurrar
    } finally {
      sorteio.mockRestore();
      vi.useRealTimers();
    }
  });
});

// ============================================
// A guarda de cadência — quase tudo aqui IMPEDE a mensagem
// ============================================
describe('quando NÃO falar', () => {
  const conversa = (over: Record<string, unknown> = {}) => ({
    status: 'open',
    assigneeId: null,
    customAttributes: {},
    labels: [],
    messages: [{ senderType: 'ai_bot' }],
    ...over,
  });

  const config = (over: Record<string, unknown> = {}) => ({
    id: 'g',
    type: 'guard.conditions',
    config: { leadFalouPorUltimo: true, maxToques: 3, ...over },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.conversation.findFirst.mockResolvedValue(conversa());
  });

  it('lead falou por último: ele espera RESPOSTA, não cobrança', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(
      conversa({ messages: [{ senderType: 'customer' }] })
    );
    const r = await guarda.execute(config(), ctx({ __toque: 1, __edges: [] }));

    expect(r.stop).toBe(true);
    expect(r.stopReason).toContain('lead_aguarda_resposta');
  });

  it('conversa sem histórico não tem o que retomar', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(conversa({ messages: [] }));
    const r = await guarda.execute(config(), ctx({ __toque: 1, __edges: [] }));
    expect(r.stopReason).toContain('conversa_sem_historico');
  });

  it('para no teto de toques — o quarto só marca o número como incômodo', async () => {
    const r = await guarda.execute(config(), ctx({ __toque: 4, __edges: [] }));
    expect(r.stop).toBe(true);
    expect(r.stopReason).toContain('teto_de_toques');
  });

  it('ainda dentro do teto, segue — inclusive o ÚLTIMO toque (o terceiro, com teto 3)', async () => {
    for (const toque of [1, 2, 3]) {
      const r = await guarda.execute(config(), ctx({ __toque: toque, __edges: [] }));
      expect(r.stop, `toque ${toque}`).toBeFalsy();
      expect(r.output).toMatchObject({ bloqueado: false });
    }
  });

  it('atendente assumiu: a IA cala', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(conversa({ assigneeId: 'user-1' }));
    const r = await guarda.execute(config(), ctx({ __toque: 1, __edges: [] }));
    expect(r.stopReason).toContain('humano_atribuido');
  });

  it('conversa resolvida: alguém decidiu que acabou', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(conversa({ status: 'resolved' }));
    const r = await guarda.execute(config(), ctx({ __toque: 1, __edges: [] }));
    expect(r.stopReason).toContain('conversa_resolvida');
  });

  it('etiqueta terminal (fechado/perdido) corta a cadência', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(
      conversa({ labels: [{ tag: { slug: 'fechado', name: 'Fechado' } }] })
    );
    const r = await guarda.execute(
      config({ etiquetasBloqueio: ['fechado'] }),
      ctx({ __toque: 1, __edges: [] })
    );
    expect(r.stopReason).toContain('etiqueta_bloqueio:fechado');
  });

  it('sem as condições de cadência, o atendimento comum não muda', async () => {
    // Última do lead + toque alto: um fluxo normal não pode parar por isso.
    prismaMock.conversation.findFirst.mockResolvedValue(
      conversa({ messages: [{ senderType: 'customer' }] })
    );
    const r = await guarda.execute(
      { id: 'g', type: 'guard.conditions', config: {} },
      ctx({ __toque: 9, __edges: [] })
    );
    expect(r.stop).toBeFalsy();
  });
});

// ============================================
// O follow-up do provisionamento: quantos toques SAEM
// ============================================
describe('follow-up provisionado — um toque por intervalo, e todos saem', () => {
  const ETAPAS = { atender: 'em-atendimento', agendar: 'agendado', transferir: 'com-humano', terminais: ['fechado', 'perdido'] };
  const AGENT = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    // Quarta 14:00 em São Paulo: dentro da janela do template (09–19, dias da agenda).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-10T17:00:00Z'));
    prismaMock.conversation.findFirst.mockResolvedValue({
      status: 'open',
      assigneeId: null,
      customAttributes: {},
      labels: [],
      messages: [{ senderType: 'ai_bot' }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Quais despertares passam na guarda do toque: o run acorda pela i-ésima vez com `__toque = i`
   * (flow.service incrementa `wakeCount` ao reclamar). Passou na guarda = o toque é escrito e enviado.
   */
  const toquesQueSaem = async (tentativas: string[]): Promise<number[]> => {
    const spec = validarSpec({ ...SPEC_CLINICA, followup: { ...SPEC_CLINICA.followup, tentativas, mensagens: [] } });
    const g = montarGrafo({ agentId: AGENT, spec, etapas: ETAPAS });
    const saem: number[] = [];
    for (let toque = 1; toque <= tentativas.length + 1; toque++) {
      // O grafo só tem as guardas dos toques 1..N; o N+1 testa o teto na última.
      const nodeGuarda = g.nodes.find((n) => n.id === NOS.followup(Math.min(toque, tentativas.length)).guarda)!;
      const r = await guarda.execute(nodeGuarda, ctx({ __toque: toque, __edges: [] }));
      if (!r.stop) saem.push(toque);
    }
    return saem;
  };

  it('tentativas ["2h"]: o ÚNICO toque sai (antes, nenhum)', async () => {
    expect(await toquesQueSaem(['2h'])).toEqual([1]);
  });

  it('tentativas ["2h","1d"]: os DOIS toques saem, e um terceiro não existe', async () => {
    expect(await toquesQueSaem(['2h', '1d'])).toEqual([1, 2]);
  });

  it('três intervalos: os três saem — inclusive a "saída digna" (antes, o último nunca saía)', async () => {
    expect(await toquesQueSaem(['2h', '1d', '3d'])).toEqual([1, 2, 3]);
  });
});

// ============================================
// O motor: suspender e retomar
// ============================================
describe('motor — suspender e retomar', () => {
  const grafo: FlowGraph = {
    nodes: [
      { id: 'gatilho', type: 'trigger.message_received' },
      { id: 'dorme', type: 'flow.aguardar', config: { valor: 1, unidade: 'dias' } },
      { id: 'depois', type: 'trigger.webhook' }, // nó barato e sem efeito colateral
    ],
    edges: [
      { id: 'e1', source: 'gatilho', target: 'dorme' },
      { id: 'e2', source: 'dorme', target: 'depois' },
    ],
  };

  const rodar = (over: Record<string, unknown> = {}) =>
    executeRun({
      runId: 'run-1',
      accountId: 'acc-1',
      flowId: 'flow-1',
      conversationId: 'conv-1',
      shadow: false,
      graph: grafo,
      vars: {},
      ...over,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.flowRunStep.create.mockResolvedValue({});
    prismaMock.flowRunStep.count.mockResolvedValue(3); // 3 passos antes de dormir
  });

  it('suspende no nó de espera e guarda o PRÓXIMO passo', async () => {
    const r = await rodar();

    expect(r.status).toBe('sleeping');
    // O próximo, não o de espera: ao acordar a espera já aconteceu. Guardar o
    // próprio nó de espera faria o run dormir pra sempre.
    expect(r.resumeNodeId).toBe('depois');
    expect(r.sleepUntil).toBeInstanceOf(Date);
  });

  it('ao retomar, continua do ponto guardado — não refaz o atendimento', async () => {
    const r = await rodar({ resumeNodeId: 'depois' });

    expect(r.status).toBe('done');
    // Só o nó retomado rodou. Recomeçar do gatilho reenviaria tudo ao lead.
    expect(prismaMock.flowRunStep.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.flowRunStep.create.mock.calls[0][0].data.nodeId).toBe('depois');
    // E a ordem CONTINUA: reiniciar em zero embaralharia a timeline com os
    // passos do atendimento original.
    expect(prismaMock.flowRunStep.create.mock.calls[0][0].data.ordem).toBe(3);
  });

  it('espera sem saída não dorme — não haveria o que retomar', async () => {
    const semSaida: FlowGraph = {
      nodes: [
        { id: 'gatilho', type: 'trigger.message_received' },
        { id: 'dorme', type: 'flow.aguardar', config: { valor: 1, unidade: 'dias' } },
      ],
      edges: [{ id: 'e1', source: 'gatilho', target: 'dorme' }],
    };
    const r = await rodar({ graph: semSaida });
    expect(r.status).toBe('done');
    expect(r.stopReason).toBe('espera_sem_saida');
  });

  it('fluxo editado durante o sono: para em vez de recomeçar do início', async () => {
    const r = await rodar({ resumeNodeId: 'no-que-alguem-apagou' });

    expect(r.status).toBe('failed');
    expect(r.error).toContain('não existe mais');
    // O ponto: NÃO caiu no gatilho. Recomeçar seria pior que não continuar.
    expect(prismaMock.flowRunStep.create).not.toHaveBeenCalled();
  });
});


/*
  A FUSÃO: "Esperar" e "Aguardar" eram o mesmo conceito partido em dois pela
  implementação. Agora é um bloco só e o motor escolhe: segundos SEGURAM o
  processo (ritmo dentro da conversa), o resto DORME (sobrevive a restart).
  Quem monta escolhe a unidade; a estratégia não é botão na tela.
*/
describe('Aguardar: segura ou dorme, conforme a unidade', () => {
  it('segundos SEGURAM o processo — não voltam pra fila', async () => {
    const t0 = Date.now();
    const r = await espera.execute(no({ valor: 1, unidade: 'segundos' }), ctx());

    expect(r.sleep).toBeUndefined(); // esperou aqui mesmo, não dormiu
    expect(Date.now() - t0).toBeGreaterThan(900);
  });

  it('minutos DORMEM — prender processo por um minuto não é opção', async () => {
    const r = await espera.execute(no({ valor: 1, unidade: 'minutos' }), ctx());
    expect(r.sleep?.until).toBeInstanceOf(Date);
  });

  it('no simulador a espera curta acontece de verdade — é o ritmo que o lead sente', async () => {
    const t0 = Date.now();
    const r = await espera.execute(no({ valor: 1, unidade: 'segundos' }), ctx({ __simulador: true }));

    expect(r.output?.pulado).toBeUndefined();
    expect(Date.now() - t0).toBeGreaterThan(900);
  });
});
