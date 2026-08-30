/**
 * T-033 — o worker acordando follow-up, e o cancelamento estrutural.
 *
 * O caso mais importante deste arquivo: o lead respondeu enquanto a cadência
 * dormia. Se o cancelamento falhar, ele recebe "e aí, pensou na proposta?"
 * logo depois de ter respondido — e é assim que se perde o lead e o número.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  flow: { findFirst: vi.fn() },
  conversation: { findFirst: vi.fn() },
  contact: { findFirst: vi.fn() },
  flowRun: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
  },
}));

vi.mock('../config/database', () => ({ prisma: prismaMock }));
vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const executeRunMock = vi.hoisted(() => vi.fn());
vi.mock('./flow/engine', async () => {
  const real = await vi.importActual<typeof import('./flow/engine')>('./flow/engine');
  return { ...real, executeRun: executeRunMock };
});

import { flowService } from './flow.service';

const FLUXO = {
  id: 'flow-1',
  accountId: 'acc-1',
  status: 'active',
  inboxIds: null,
  graph: {
    nodes: [
      { id: 't', type: 'trigger.message_received' },
      { id: 'b', type: 'buffer.debounce', config: { segundos: 15 } },
    ],
    edges: [{ id: 'e', source: 't', target: 'b' }],
  },
};

const evento = (over: Record<string, unknown> = {}) => ({
  accountId: 'acc-1',
  conversationId: 'conv-1',
  inboxId: 'inbox-1',
  messageId: 'msg-1',
  content: 'oi',
  contentType: 'text',
  ...over,
});

const runDormindo = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  accountId: 'acc-1',
  flowId: 'flow-1',
  conversationId: 'conv-1',
  shadow: false,
  context: {},
  resumeNodeId: 'depois',
  wakeCount: 1,
  flow: FLUXO,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.flow.findFirst.mockResolvedValue(FLUXO);
  prismaMock.flowRun.findFirst.mockResolvedValue(null);
  prismaMock.flowRun.findMany.mockResolvedValue([]);
  prismaMock.flowRun.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.flowRun.create.mockResolvedValue({ id: 'run-novo' });
  prismaMock.flowRun.update.mockResolvedValue({ id: 'run-1' });
  prismaMock.conversation.findFirst.mockResolvedValue({ customAttributes: {}, contactId: null });
  prismaMock.contact.findFirst.mockResolvedValue({ customAttributes: {} });
});

/** A chamada de cancelamento entre as várias que o serviço faz. */
const chamadaDeCancelamento = () =>
  prismaMock.flowRun.updateMany.mock.calls.find(
    (c) => c[0]?.where?.status === 'sleeping'
  )?.[0];

describe('cancelamento estrutural — o lead respondeu', () => {
  it('mensagem do lead mata o follow-up que dormia naquela conversa', async () => {
    await flowService.onInboundMessage(evento());

    const cancel = chamadaDeCancelamento();
    expect(cancel).toBeDefined();
    expect(cancel.where.conversationId).toBe('conv-1');
    expect(cancel.data.status).toBe('skipped');
    expect(cancel.data.stopReason).toBe('lead_respondeu');
    // Limpa a retomada: run cancelado não pode parecer retomável depois.
    expect(cancel.data.resumeNodeId).toBeNull();
    expect(cancel.data.runAfter).toBeNull();
  });

  it('cancela ANTES de decidir qualquer coisa sobre o run novo', async () => {
    // Fluxo restrito a outro inbox: o run novo nem vai ser criado...
    prismaMock.flow.findFirst.mockResolvedValue({ ...FLUXO, inboxIds: ['outro-inbox'] });
    await flowService.onInboundMessage(evento());

    // ...mas o follow-up velho tem que morrer do mesmo jeito.
    expect(chamadaDeCancelamento()).toBeDefined();
    expect(prismaMock.flowRun.create).not.toHaveBeenCalled();
  });

  it('sem fluxo publicado ainda cancela — despublicar não ressuscita cadência', async () => {
    prismaMock.flow.findFirst.mockResolvedValue(null);
    await flowService.onInboundMessage(evento());
    expect(chamadaDeCancelamento()).toBeDefined();
  });

  it('só mexe em run dormindo — não toca em atendimento em andamento', async () => {
    await flowService.onInboundMessage(evento());
    expect(chamadaDeCancelamento().where.status).toBe('sleeping');
  });
});

describe('worker acordando a cadência', () => {
  const filaCom = (runs: { id: string; status: string }[]) => {
    prismaMock.flowRun.findMany.mockResolvedValue(runs);
    prismaMock.flowRun.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.flowRun.findUnique.mockResolvedValue(runDormindo());
    executeRunMock.mockResolvedValue({
      status: 'done',
      steps: 1,
      stopReason: null,
      error: null,
      vars: {},
    });
  };

  it('varre agrupamento E follow-up na mesma passada', async () => {
    filaCom([]);
    await flowService.processDueRuns();

    const where = prismaMock.flowRun.findMany.mock.calls.at(-1)![0].where;
    expect(where.status).toEqual({ in: ['buffering', 'sleeping'] });
  });

  it('reclama pelo status que leu — se mudou no meio, não roda', async () => {
    filaCom([{ id: 'run-1', status: 'sleeping' }]);
    await flowService.processDueRuns();

    const claim = prismaMock.flowRun.updateMany.mock.calls.find(
      (c) => c[0]?.where?.id === 'run-1'
    )![0];
    // Condicionado a 'sleeping': se o lead respondeu nesse instante e o run
    // virou 'skipped', o claim não pega nada e a mensagem não sai.
    expect(claim.where.status).toBe('sleeping');
  });

  it('cada retomada conta como um toque', async () => {
    filaCom([{ id: 'run-1', status: 'sleeping' }]);
    await flowService.processDueRuns();

    const claim = prismaMock.flowRun.updateMany.mock.calls.find(
      (c) => c[0]?.where?.id === 'run-1'
    )![0];
    expect(claim.data.wakeCount).toEqual({ increment: 1 });
  });

  it('agrupamento comum NÃO incrementa toque — não é follow-up', async () => {
    filaCom([{ id: 'run-1', status: 'buffering' }]);
    await flowService.processDueRuns();

    const claim = prismaMock.flowRun.updateMany.mock.calls.find(
      (c) => c[0]?.where?.id === 'run-1'
    )![0];
    expect(claim.data.wakeCount).toBeUndefined();
  });

  it('retoma do ponto guardado e informa qual toque é', async () => {
    filaCom([{ id: 'run-1', status: 'sleeping' }]);
    await flowService.processDueRuns();

    const params = executeRunMock.mock.calls[0][0];
    expect(params.resumeNodeId).toBe('depois');
    expect(params.vars.__toque).toBe(1);
  });
});

describe('persistir o sono', () => {
  const dormir = async (outcome: Record<string, unknown>) => {
    prismaMock.flowRun.findMany.mockResolvedValue([{ id: 'run-1', status: 'buffering' }]);
    prismaMock.flowRun.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.flowRun.findUnique.mockResolvedValue(runDormindo({ resumeNodeId: null }));
    executeRunMock.mockResolvedValue({
      status: 'sleeping',
      steps: 2,
      stopReason: null,
      error: null,
      vars: {},
      ...outcome,
    });
    await flowService.processDueRuns();
    return prismaMock.flowRun.update.mock.calls.at(-1)![0].data;
  };

  it('volta pra fila com hora marcada, sem marcar como terminado', async () => {
    const quando = new Date(Date.now() + 86_400_000);
    const salvo = await dormir({ sleepUntil: quando, resumeNodeId: 'toque2' });

    expect(salvo.status).toBe('sleeping');
    expect(salvo.runAfter).toEqual(quando);
    expect(salvo.resumeNodeId).toBe('toque2');
    // finishedAt marcaria como concluído um atendimento que vai continuar —
    // e a tela de execuções mentiria.
    expect(salvo.finishedAt).toBeUndefined();
  });

  it('run que terminou de verdade limpa a retomada', async () => {
    prismaMock.flowRun.findMany.mockResolvedValue([{ id: 'run-1', status: 'sleeping' }]);
    prismaMock.flowRun.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.flowRun.findUnique.mockResolvedValue(runDormindo());
    executeRunMock.mockResolvedValue({
      status: 'done',
      steps: 3,
      stopReason: 'fim_do_fluxo',
      error: null,
      vars: {},
    });

    await flowService.processDueRuns();
    const salvo = prismaMock.flowRun.update.mock.calls.at(-1)![0].data;
    // Sem isto, um run concluído continuaria parecendo retomável.
    expect(salvo.resumeNodeId).toBeNull();
    expect(salvo.finishedAt).toBeInstanceOf(Date);
  });

  it('o contador de toque não vaza pro contexto salvo', async () => {
    prismaMock.flowRun.findMany.mockResolvedValue([{ id: 'run-1', status: 'sleeping' }]);
    prismaMock.flowRun.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.flowRun.findUnique.mockResolvedValue(runDormindo());
    executeRunMock.mockResolvedValue({
      status: 'done',
      steps: 1,
      stopReason: null,
      error: null,
      vars: { __toque: 2, __edges: [], memoria: {}, sessao: {}, algo: 'x' },
    });

    await flowService.processDueRuns();
    const ctx = prismaMock.flowRun.update.mock.calls.at(-1)![0].data.context;
    expect(ctx.__toque).toBeUndefined();
    expect(ctx.algo).toBe('x');
  });
});
