/**
 * T-028 — gatilho e agrupamento do fluxo de atendimento.
 *
 * O agrupamento é a parte mais fácil de errar e a mais visível pro lead: se
 * falhar, a IA responde cada mensagem separada e atropela o raciocínio de quem
 * está do outro lado. Aqui garantimos que mensagens seguidas viram UM run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  flow: { findFirst: vi.fn(), updateMany: vi.fn() },
  // O motor carrega a memória da conversa antes de executar (T-030).
  conversation: { findFirst: vi.fn() },
  // Longo prazo vive no contato (T-030b).
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

import { Prisma } from '@prisma/client';
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

const evento = (over: Partial<Parameters<typeof flowService.onInboundMessage>[0]> = {}) => ({
  accountId: 'acc-1',
  conversationId: 'conv-1',
  inboxId: 'inbox-1',
  messageId: 'msg-1',
  content: 'oi',
  contentType: 'text',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.flow.findFirst.mockResolvedValue(FLUXO);
  prismaMock.flowRun.findFirst.mockResolvedValue(null);
  prismaMock.flowRun.findMany.mockResolvedValue([]);
  prismaMock.flowRun.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.flowRun.create.mockResolvedValue({ id: 'run-1' });
  prismaMock.flowRun.update.mockResolvedValue({ id: 'run-1' });
  prismaMock.conversation.findFirst.mockResolvedValue({ customAttributes: {}, contactId: null });
  prismaMock.contact.findFirst.mockResolvedValue({ customAttributes: {} });
});

describe('gatilho', () => {
  it('não faz nada quando não há fluxo publicado', async () => {
    prismaMock.flow.findFirst.mockResolvedValue(null);
    await flowService.onInboundMessage(evento());
    expect(prismaMock.flowRun.create).not.toHaveBeenCalled();
  });

  it('cria run em buffering com a janela do nó de agrupamento', async () => {
    const antes = Date.now();
    await flowService.onInboundMessage(evento());

    const data = prismaMock.flowRun.create.mock.calls[0][0].data;
    expect(data.status).toBe('buffering');
    expect(data.shadow).toBe(false);
    const espera = data.runAfter.getTime() - antes;
    // 15s configurados no nó buffer.debounce
    expect(espera).toBeGreaterThan(13_000);
    expect(espera).toBeLessThan(17_000);
    expect(data.context.mensagens).toHaveLength(1);
  });

  it('fluxo em sombra marca o run como sombra — nada será enviado', async () => {
    prismaMock.flow.findFirst.mockResolvedValue({ ...FLUXO, status: 'shadow' });
    await flowService.onInboundMessage(evento());
    expect(prismaMock.flowRun.create.mock.calls[0][0].data.shadow).toBe(true);
  });

  it('ignora inbox fora da lista do fluxo', async () => {
    prismaMock.flow.findFirst.mockResolvedValue({ ...FLUXO, inboxIds: ['outro-inbox'] });
    await flowService.onInboundMessage(evento());
    expect(prismaMock.flowRun.create).not.toHaveBeenCalled();
  });
});

describe('agrupamento (debounce)', () => {
  it('segunda mensagem entra no mesmo run e empurra o horário', async () => {
    prismaMock.flowRun.findFirst.mockResolvedValue({
      id: 'run-1',
      context: { mensagens: [{ id: 'msg-1', content: 'oi', contentType: 'text', createdAt: 'x' }] },
    });

    const antes = Date.now();
    await flowService.onInboundMessage(evento({ messageId: 'msg-2', content: 'quanto custa?' }));

    // NÃO cria run novo — esse é o ponto todo.
    expect(prismaMock.flowRun.create).not.toHaveBeenCalled();

    const upd = prismaMock.flowRun.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'run-1' });
    expect(upd.data.context.mensagens).toHaveLength(2);
    expect(upd.data.context.mensagens[1].content).toBe('quanto custa?');
    // Horário empurrado pra frente: a IA só responde quando o lead parar.
    expect(upd.data.runAfter.getTime()).toBeGreaterThan(antes + 13_000);
  });

  it('corrida entre dois webhooks: P2002 agrupa em vez de duplicar o atendimento', async () => {
    // Nenhum run aberto no findFirst, mas outro processo criou no meio.
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '5.22.0',
    });
    prismaMock.flowRun.create.mockRejectedValueOnce(p2002);
    prismaMock.flowRun.findFirst
      .mockResolvedValueOnce(null) // primeira checagem
      .mockResolvedValueOnce({ id: 'run-existente', context: { mensagens: [] } });

    await flowService.onInboundMessage(evento());

    // Recupera: anexa no run que o outro processo criou.
    expect(prismaMock.flowRun.update).toHaveBeenCalled();
    expect(prismaMock.flowRun.update.mock.calls[0][0].where).toEqual({ id: 'run-existente' });
  });

  it('erro que não é P2002 sobe — não mascara falha real de banco', async () => {
    prismaMock.flowRun.create.mockRejectedValueOnce(new Error('conexão perdida'));
    await expect(flowService.onInboundMessage(evento())).rejects.toThrow('conexão perdida');
  });
});

describe('worker', () => {
  it('pula o run quando outra réplica reclamou primeiro', async () => {
    prismaMock.flowRun.findMany.mockResolvedValue([{ id: 'run-1', status: 'buffering' }]);
    prismaMock.flowRun.updateMany
      .mockResolvedValueOnce({ count: 0 }) // resgate de órfãos
      .mockResolvedValueOnce({ count: 0 }); // claim perdido

    const r = await flowService.processDueRuns();

    expect(r).toEqual({ ok: 0, failed: 0 });
    expect(executeRunMock).not.toHaveBeenCalled();
  });

  it('claim é condicional a buffering — evita responder o lead duas vezes', async () => {
    prismaMock.flowRun.findMany.mockResolvedValue([{ id: 'run-1', status: 'buffering' }]);
    prismaMock.flowRun.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prismaMock.flowRun.findUnique.mockResolvedValue(null);

    await flowService.processDueRuns();

    // O claim é condicionado ao status que o worker LEU, não a 'buffering'
    // fixo — é o mesmo mecanismo que agora também reclama follow-up dormindo.
    const claim = prismaMock.flowRun.updateMany.mock.calls.find(
      (c) => c[0]?.where?.id === 'run-1'
    )![0];
    expect(claim.where).toEqual({ id: 'run-1', status: 'buffering' });
    expect(claim.data.status).toBe('running');
  });

  it('fluxo despublicado durante a espera não executa', async () => {
    prismaMock.flowRun.findMany.mockResolvedValue([{ id: 'run-1', status: 'buffering' }]);
    prismaMock.flowRun.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prismaMock.flowRun.findUnique.mockResolvedValue({
      id: 'run-1',
      accountId: 'acc-1',
      flowId: 'flow-1',
      conversationId: 'conv-1',
      shadow: false,
      context: {},
      flow: { ...FLUXO, status: 'draft' },
    });

    await flowService.processDueRuns();

    expect(executeRunMock).not.toHaveBeenCalled();
    const upd = prismaMock.flowRun.update.mock.calls.at(-1)![0];
    expect(upd.data.status).toBe('skipped');
    expect(upd.data.stopReason).toBe('fluxo_despublicado');
  });

  it('executa e grava o resultado, sem vazar o campo interno __edges', async () => {
    prismaMock.flowRun.findMany.mockResolvedValue([{ id: 'run-1', status: 'buffering' }]);
    prismaMock.flowRun.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prismaMock.flowRun.findUnique.mockResolvedValue({
      id: 'run-1',
      accountId: 'acc-1',
      flowId: 'flow-1',
      conversationId: 'conv-1',
      shadow: false,
      context: { mensagens: [] },
      flow: FLUXO,
    });
    executeRunMock.mockResolvedValue({
      status: 'done',
      steps: 4,
      stopReason: 'fim_do_fluxo',
      error: null,
      vars: { agente: { etapa: 'agendado' }, __edges: [{ source: 'a' }] },
    });

    const r = await flowService.processDueRuns();

    expect(r).toEqual({ ok: 1, failed: 0 });
    const salvo = prismaMock.flowRun.update.mock.calls.at(-1)![0].data;
    expect(salvo.status).toBe('done');
    expect(salvo.context.agente).toEqual({ etapa: 'agendado' });
    expect(salvo.context.__edges).toBeUndefined();
  });

  it('as duas memórias entram no contexto: longo prazo do contato, curto da conversa', async () => {
    prismaMock.flowRun.findMany.mockResolvedValue([{ id: 'run-1', status: 'buffering' }]);
    prismaMock.flowRun.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prismaMock.flowRun.findUnique.mockResolvedValue({
      id: 'run-1',
      accountId: 'acc-1',
      flowId: 'flow-1',
      conversationId: 'conv-1',
      shadow: false,
      context: { mensagens: [] },
      flow: FLUXO,
    });
    // Curto prazo: estado desta conversa.
    prismaMock.conversation.findFirst.mockResolvedValue({
      customAttributes: { etapa_roteiro: 'diagnostico' },
      contactId: 'contato-1',
    });
    // Longo prazo: fatos sobre a pessoa, que sobrevivem à conversa.
    prismaMock.contact.findFirst.mockResolvedValue({
      customAttributes: { faturamento: 'R$ 80 mil', segmento: 'clínica' },
    });
    executeRunMock.mockResolvedValue({
      status: 'done',
      steps: 3,
      stopReason: 'fim_do_fluxo',
      error: null,
      vars: { memoria: { faturamento: 'R$ 80 mil' }, sessao: { etapa_roteiro: 'diagnostico' } },
    });

    await flowService.processDueRuns();

    const vars = executeRunMock.mock.calls[0][0].vars;
    expect(vars.memoria).toEqual({ faturamento: 'R$ 80 mil', segmento: 'clínica' });
    expect(vars.sessao).toEqual({ etapa_roteiro: 'diagnostico' });
    expect(vars.__contactId).toBe('contato-1');

    // Nenhuma das duas é duplicada no contexto salvo: cada uma tem dono
    // (contato e conversa), e uma segunda cópia divergiria.
    const salvo = prismaMock.flowRun.update.mock.calls.at(-1)![0].data;
    expect(salvo.context.memoria).toBeUndefined();
    expect(salvo.context.sessao).toBeUndefined();
    expect(salvo.context.__contactId).toBeUndefined();
  });

  it('conversa sem contato vinculado roda com memória de longo prazo vazia', async () => {
    prismaMock.flowRun.findMany.mockResolvedValue([{ id: 'run-1', status: 'buffering' }]);
    prismaMock.flowRun.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prismaMock.flowRun.findUnique.mockResolvedValue({
      id: 'run-1',
      accountId: 'acc-1',
      flowId: 'flow-1',
      conversationId: 'conv-1',
      shadow: false,
      context: {},
      flow: FLUXO,
    });
    prismaMock.conversation.findFirst.mockResolvedValue({
      customAttributes: {},
      contactId: null,
    });
    executeRunMock.mockResolvedValue({
      status: 'done', steps: 1, stopReason: null, error: null, vars: {},
    });

    await flowService.processDueRuns();

    // Não vai atrás do contato quando não há — economiza a consulta.
    expect(prismaMock.contact.findFirst).not.toHaveBeenCalled();
    expect(executeRunMock.mock.calls[0][0].vars.memoria).toEqual({});
  });
});
