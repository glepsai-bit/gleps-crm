/**
 * T-039 — a reunião marcada atravessa o fluxo.
 *
 * Três coisas sob teste: o bloco "Atender com IA" sai por `agendou` quando a
 * ferramenta marcou (e só então); o "Aguardar até X horas antes" dorme
 * ancorado à reunião e acorda NO PRÓPRIO bloco pra conferir se ela ainda
 * existe; e o lembrete não morre quando o lead manda mensagem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  conversation: { findFirst: vi.fn() },
  contact: { findFirst: vi.fn(), update: vi.fn() },
  tag: { findFirst: vi.fn() },
  team: { findFirst: vi.fn() },
  flowRunStep: { create: vi.fn(), count: vi.fn() },
}));

vi.mock('../../config/database', () => ({ prisma: prismaMock }));
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const runAgentMock = vi.hoisted(() => vi.fn());
vi.mock('../ai-agent.service', () => ({
  aiAgentService: { run: runAgentMock },
  AVAILABLE_TOOLS: {},
}));

const estadoDaReuniaoMock = vi.hoisted(() => vi.fn());
vi.mock('../agenda.service', () => ({
  agendaService: { estadoDaReuniao: estadoDaReuniaoMock },
}));

const sendMock = vi.hoisted(() => vi.fn());
vi.mock('../whatsapp-send.service', () => ({ whatsappSendService: { send: sendMock } }));
const addLabelMock = vi.hoisted(() => vi.fn());
vi.mock('../conversation.service', () => ({
  conversationService: {
    addLabel: addLabelMock,
    assign: vi.fn(),
    assignToTeam: vi.fn(),
    updateStatus: vi.fn(),
    resolve: vi.fn(),
  },
}));
vi.mock('../agent-availability.service', () => ({ agentAvailabilityService: { listOnline: vi.fn(async () => []) } }));
vi.mock('../team.service', () => ({ teamService: { pickAssignee: vi.fn() } }));
vi.mock('../attachment-storage.service', () => ({ attachmentStorageService: {} }));
vi.mock('../ai/transcription', () => ({ transcribe: vi.fn() }));

import { NODE_CATALOG } from './nodes';
import { executeRun } from './engine';
import type { FlowGraph, NodeContext } from './types';

const atender = NODE_CATALOG['ai.atender'];
const aguardar = NODE_CATALOG['flow.aguardar'];

const ctx = (over: Partial<NodeContext> = {}): NodeContext =>
  ({
    accountId: 'acc-1',
    runId: 'run-1',
    flowId: 'flow-1',
    conversationId: 'conv-1',
    shadow: false,
    actorId: 'flow:flow-1',
    vars: { mensagens: [{ content: 'quinta às 14 então' }] },
    ...over,
  }) as NodeContext;

const reuniao = (over: Record<string, unknown> = {}) => ({
  eventoId: 'ev-1',
  inicio: '2026-10-01T17:00:00.000Z',
  fim: '2026-10-01T17:30:00.000Z',
  data: '01/10',
  hora: '14:00',
  diaDaSemana: 'quinta-feira',
  rotulo: 'quinta-feira, 01/10 às 14:00',
  profissionalId: 'u-marina',
  profissional: 'Dra. Marina',
  servico: 'Botox',
  googleEventId: 'g-1',
  etapa: null,
  ...over,
});

const respostaAgente = (structured: Record<string, unknown> | null, efeitos: Record<string, unknown> = {}) => ({
  text: 'texto cru',
  structured,
  efeitos,
  toolCalls: [{ id: 't1', name: 'agendar', arguments: {} }],
  hits: [],
  attempts: 1,
  usage: { inputTokens: 10, outputTokens: 5, usdEstimate: 0.0002, priced: true },
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.conversation.findFirst.mockResolvedValue({ assigneeId: null });
  prismaMock.flowRunStep.create.mockResolvedValue({});
  prismaMock.flowRunStep.count.mockResolvedValue(0);
  prismaMock.tag.findFirst.mockImplementation(async (q: { where: { OR: { slug?: { equals: string } }[] } }) => {
    const pedida = q.where.OR[0].slug?.equals;
    return pedida === 'agendado' ? { id: 'tag-ag', slug: 'agendado' } : null;
  });
  sendMock.mockResolvedValue({ messageId: 'm1', status: 'sent' });
  addLabelMock.mockResolvedValue(undefined);
});

// ============================================
describe('Atender com IA — a porta agendou', () => {
  it('a ferramenta marcou: responde, sai por "agendou" e grava {{agenda}}', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'Fechado, quinta às 14h!' }, { agendou: reuniao() })
    );

    const r = await atender.execute({ id: 'a', type: 'ai.atender', config: { agentId: 'ag-1' } }, ctx());

    expect(r.branch).toBe('agendou');
    expect(sendMock.mock.calls[0][1].content).toBe('Fechado, quinta às 14h!');
    expect((r.vars as Record<string, unknown>).agenda).toMatchObject({ eventoId: 'ev-1', hora: '14:00' });
    expect(r.output).toMatchObject({ saiuPor: 'agendou', ferramentas: ['agendar'] });
    expect((r.output as Record<string, unknown>).agendou).toMatchObject({ profissional: 'Dra. Marina' });
  });

  it('a etapa "ao agendar" das regras da conta é aplicada por código', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'ok' }, { agendou: reuniao({ etapa: 'agendado' }) })
    );
    const r = await atender.execute({ id: 'a', type: 'ai.atender', config: { agentId: 'ag-1' } }, ctx());
    expect(addLabelMock).toHaveBeenCalledWith('conv-1', 'acc-1', 'tag-ag', 'flow:flow-1');
    expect((r.output as Record<string, unknown>).etapaDaAgenda).toMatchObject({ etapa: 'agendado' });
  });

  it('o modelo já aplicou uma etapa nesta rodada: a das regras não passa por cima', async () => {
    prismaMock.tag.findFirst.mockImplementation(async (q: { where: { OR: { slug?: { equals: string } }[] } }) => {
      const pedida = q.where.OR[0].slug?.equals;
      return { id: `tag-${pedida}`, slug: pedida };
    });
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'ok', etapa: 'convertido' }, { agendou: reuniao({ etapa: 'agendado' }) })
    );
    await atender.execute({ id: 'a', type: 'ai.atender', config: { agentId: 'ag-1' } }, ctx());
    expect(addLabelMock).toHaveBeenCalledTimes(1);
    expect(addLabelMock.mock.calls[0][2]).toBe('tag-convertido');
  });

  it('agendou vence a rota própria e os sinais: o lembrete precisa nascer', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente(
        { mensagem_de_resposta: 'ok', rota: 'financeiro', transferir_para_humano: true },
        { agendou: reuniao() }
      )
    );
    const r = await atender.execute({ id: 'a', type: 'ai.atender', config: { agentId: 'ag-1' } }, ctx());
    expect(r.branch).toBe('agendou');
  });

  it('sem efeito de agenda, nada muda: "respondeu" como sempre', async () => {
    runAgentMock.mockResolvedValue(respostaAgente({ mensagem_de_resposta: 'ok' }));
    const r = await atender.execute({ id: 'a', type: 'ai.atender', config: { agentId: 'ag-1' } }, ctx());
    expect(r.branch).toBe('respondeu');
    expect((r.vars as Record<string, unknown>).agenda).toBeUndefined();
  });

  it('em sombra o agente roda com shadow=true — a ferramenta finge em vez de gravar', async () => {
    runAgentMock.mockResolvedValue(respostaAgente({ mensagem_de_resposta: 'ok' }));
    await atender.execute({ id: 'a', type: 'ai.atender', config: { agentId: 'ag-1' } }, ctx({ shadow: true }));
    expect(runAgentMock.mock.calls[0][0]).toMatchObject({ shadow: true });
  });
});

// ============================================
describe('Aguardar até X horas antes da reunião', () => {
  const no = (antesHoras = 24) => ({
    id: 'esp',
    type: 'flow.aguardar',
    config: { modo: 'antes_da_reuniao', antesHoras },
  });

  it('sem reunião no atendimento, para — não há o que lembrar', async () => {
    const r = await aguardar.execute(no(), ctx({ vars: {} }));
    expect(r.stop).toBe(true);
    expect(r.stopReason).toBe('sem_reuniao');
    expect(estadoDaReuniaoMock).not.toHaveBeenCalled();
  });

  it('dorme até X horas antes, ancorado à reunião, e acorda no PRÓPRIO bloco', async () => {
    const daquiA3Dias = new Date(Date.now() + 3 * 86_400_000);
    estadoDaReuniaoMock.mockResolvedValue({ status: 'scheduled', inicio: daquiA3Dias, fim: null });

    const r = await aguardar.execute(no(24), ctx({ vars: { agenda: reuniao({ inicio: daquiA3Dias.toISOString() }) } }));

    expect(r.sleep?.retomarAqui).toBe(true);
    expect(r.sleep?.until.getTime()).toBe(daquiA3Dias.getTime() - 24 * 3_600_000);
    expect((r.vars as Record<string, unknown>).__aguardandoReuniao).toBe('ev-1');
  });

  it('a reunião foi cancelada (no CRM ou no Google): o fluxo para aqui, sem lembrete órfão', async () => {
    estadoDaReuniaoMock.mockResolvedValue({ status: 'cancelled', inicio: null, fim: null });
    const r = await aguardar.execute(no(), ctx({ vars: { agenda: reuniao() } }));
    expect(r.stop).toBe(true);
    expect(r.stopReason).toBe('reuniao_cancelada');
  });

  it('a profissional moveu a reunião no Google: o alvo acompanha a nova hora', async () => {
    const novaHora = new Date(Date.now() + 5 * 86_400_000);
    estadoDaReuniaoMock.mockResolvedValue({ status: 'scheduled', inicio: novaHora, fim: null });
    const r = await aguardar.execute(no(2), ctx({ vars: { agenda: reuniao() } }));
    expect(r.sleep?.until.getTime()).toBe(novaHora.getTime() - 2 * 3_600_000);
    expect((r.vars as Record<string, unknown>).agenda).toMatchObject({ inicio: novaHora.toISOString() });
  });

  it('já é hora (ou a reunião é daqui a pouco): segue direto pro lembrete', async () => {
    const daquiA1Hora = new Date(Date.now() + 3_600_000);
    estadoDaReuniaoMock.mockResolvedValue({ status: 'scheduled', inicio: daquiA1Hora, fim: null });
    const r = await aguardar.execute(no(24), ctx({ vars: { agenda: reuniao({ inicio: daquiA1Hora.toISOString() }) } }));
    expect(r.sleep).toBeUndefined();
    expect(r.stop).toBeFalsy();
    expect(r.output).toMatchObject({ seguiu: 'ja_era_hora' });
  });

  it('no simulador não dorme: o passo diz que pulou e quanto tempo seria', async () => {
    const daquiA3Dias = new Date(Date.now() + 3 * 86_400_000);
    const r = await aguardar.execute(
      no(),
      ctx({ vars: { __simulador: true, agenda: reuniao({ inicio: daquiA3Dias.toISOString(), simulado: true }) } })
    );
    expect(r.sleep).toBeUndefined();
    expect(r.output).toMatchObject({ pulado: 'simulador' });
    expect(estadoDaReuniaoMock).not.toHaveBeenCalled();
  });
});

// ============================================
describe('o motor com retomarAqui', () => {
  it('o run dorme apontando pro PRÓPRIO bloco de espera, não pro seguinte', async () => {
    const daquiA3Dias = new Date(Date.now() + 3 * 86_400_000);
    estadoDaReuniaoMock.mockResolvedValue({ status: 'scheduled', inicio: daquiA3Dias, fim: null });

    const graph: FlowGraph = {
      nodes: [
        { id: 'g', type: 'trigger.message_received' },
        { id: 'esp', type: 'flow.aguardar', config: { modo: 'antes_da_reuniao', antesHoras: 24 } },
        { id: 'lembra', type: 'chat.reply', config: { texto: 'Lembrete: {{agenda.hora}}' } },
      ],
      edges: [
        { id: 'e1', source: 'g', target: 'esp' },
        { id: 'e2', source: 'esp', target: 'lembra' },
      ],
    };

    const r = await executeRun({
      runId: 'run-1',
      accountId: 'acc-1',
      flowId: 'flow-1',
      conversationId: 'conv-1',
      shadow: false,
      graph,
      vars: { mensagens: [], agenda: reuniao({ inicio: daquiA3Dias.toISOString() }) },
      // O run vem de um `agendou`: retoma no bloco de espera.
      resumeNodeId: 'esp',
    });

    expect(r.status).toBe('sleeping');
    expect(r.resumeNodeId).toBe('esp');
    expect(r.vars.__aguardandoReuniao).toBe('ev-1');
    expect(sendMock).not.toHaveBeenCalled();
  });
});
