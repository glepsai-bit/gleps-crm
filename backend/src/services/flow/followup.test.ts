/**
 * T-033 — dormir, acordar e não falar besteira.
 *
 * O que está sob teste não é "consegue esperar" — é RESTRIÇÃO. Um follow-up
 * que dispara sempre é trivial de escrever e destrói funil: cobra quem está
 * esperando resposta, fala por cima do atendente, insiste depois do terceiro
 * silêncio. Quase todo caso aqui verifica que a mensagem NÃO sai.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    const r = await guarda.execute(config(), ctx({ __toque: 3, __edges: [] }));
    expect(r.stop).toBe(true);
    expect(r.stopReason).toContain('teto_de_toques');
  });

  it('ainda dentro do teto, segue', async () => {
    const r = await guarda.execute(config(), ctx({ __toque: 2, __edges: [] }));
    expect(r.stop).toBeFalsy();
    expect(r.output).toMatchObject({ bloqueado: false });
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
