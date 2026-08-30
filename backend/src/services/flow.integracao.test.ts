/**
 * T-033 — teste de INTEGRAÇÃO do follow-up, contra o Postgres de verdade.
 *
 * Por que existe: os outros testes do follow-up mockam o Prisma. Eles provam a
 * lógica, e não provam nada sobre o banco — se a coluna `resume_node_id` não
 * existisse, ou o índice de idempotência não tivesse sido criado, todos eles
 * continuariam verdes e a plataforma quebraria no primeiro follow-up real.
 *
 * Aqui o motor roda de ponta a ponta com dados reais. Só duas coisas ficam
 * mockadas, e por motivo óbvio: o envio no WhatsApp e a chamada de IA.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Só o mundo externo é mockado. Banco, motor, nós e worker são reais.
const sendMock = vi.hoisted(() => vi.fn());
vi.mock('./whatsapp-send.service', () => ({
  whatsappSendService: { send: sendMock },
}));

const runAgentMock = vi.hoisted(() => vi.fn());
vi.mock('./ai-agent.service', () => ({
  aiAgentService: { run: runAgentMock },
  AVAILABLE_TOOLS: {},
}));

import { prisma } from '../config/database';
import { flowService } from './flow.service';
import { inboundIntegrationService } from './inbound-integration.service';
import { buildFollowupGraph } from './flow/followup-graph';
import type { FlowGraph } from './flow/types';

/**
 * Repete a operação enquanto o banco ainda não enxerga o que acabou de ser
 * gravado.
 *
 * Causa (a mesma já documentada no multi-tenant.test.ts): dois PrismaClient
 * conversam com o mesmo banco — o `prismaTest` do setup, que dá TRUNCATE entre
 * casos, e o singleton que os services usam. Depois do TRUNCATE, alguma
 * conexão do pool pode carregar snapshot defasado e não ver a linha recém
 * criada — aparece como violação de FK ou "registro não encontrado" em cima de
 * um id que existe. Não é bug do produto; é do arranjo de teste.
 *
 * Só tolera esses dois erros. P2002 (unicidade) passa direto, porque é
 * justamente o que alguns casos aqui verificam.
 */
async function comRetry<T>(fn: () => Promise<T>, tentativas = 12): Promise<T> {
  let ultimo: unknown;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      const codigo = (err as { code?: string }).code;
      if (codigo !== 'P2003' && codigo !== 'P2025') throw err;
      ultimo = err;
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  throw ultimo;
}

/** Grafo mínimo que exercita o ciclo: responde, dorme um dia, responde de novo. */
const GRAFO_CADENCIA: FlowGraph = {
  nodes: [
    { id: 'gatilho', type: 'trigger.message_received' },
    { id: 'resposta1', type: 'chat.reply', config: { texto: 'primeira resposta' } },
    { id: 'dorme', type: 'flow.aguardar', config: { valor: 1, unidade: 'dias' } },
    { id: 'guarda', type: 'guard.conditions', config: { leadFalouPorUltimo: true, maxToques: 3 } },
    { id: 'resposta2', type: 'chat.reply', config: { texto: 'toque de follow-up' } },
  ],
  edges: [
    { id: 'e1', source: 'gatilho', target: 'resposta1' },
    { id: 'e2', source: 'resposta1', target: 'dorme' },
    { id: 'e3', source: 'dorme', target: 'guarda' },
    { id: 'e4', source: 'guarda', target: 'resposta2' },
  ],
};

async function montarCenario(graph: FlowGraph = GRAFO_CADENCIA, status = 'active') {
  const account = await comRetry(() =>
    prisma.account.create({ data: { nome: 'Academia Teste' } })
  );
  const inbox = await comRetry(() =>
    prisma.inbox.create({
      data: { accountId: account.id, name: 'WhatsApp', channelType: 'whatsapp', active: true },
    })
  );
  const contact = await comRetry(() =>
    prisma.contact.create({
      data: { accountId: account.id, nome: 'Aluno', telefone: '5511999990000' },
    })
  );
  const conversation = await comRetry(() =>
    prisma.conversation.create({
      data: { accountId: account.id, inboxId: inbox.id, contactId: contact.id, status: 'open' },
    })
  );
  const flow = await comRetry(() =>
    prisma.flow.create({
    data: {
      accountId: account.id,
      name: 'Atendimento',
      status,
      graph: graph as never,
    },
    })
  );
  return { account, inbox, contact, conversation, flow };
}

/** Simula o lead escrevendo e roda o worker até o fim da rodada. */
async function leadEscreve(c: Awaited<ReturnType<typeof montarCenario>>, texto = 'oi') {
  const msg = await comRetry(() =>
    prisma.message.create({
      data: {
        conversationId: c.conversation.id,
        senderType: 'customer',
        content: texto,
        contentType: 'text',
      },
    })
  );
  await flowService.onInboundMessage({
    accountId: c.account.id,
    conversationId: c.conversation.id,
    inboxId: c.inbox.id,
    messageId: msg.id,
    content: texto,
    contentType: 'text',
  });
  // O agrupamento agenda pra frente; aqui não vamos esperar 15s.
  await prisma.flowRun.updateMany({
    where: { conversationId: c.conversation.id, status: 'buffering' },
    data: { runAfter: new Date(Date.now() - 1000) },
  });
  await flowService.processDueRuns();
}

const runDa = (conversationId: string) =>
  prisma.flowRun.findFirst({ where: { conversationId }, orderBy: { createdAt: 'desc' } });

/**
 * Vários services do CRM disparam trabalho de fundo sem await — foto de perfil
 * do contato, distribuição por time, registro de evento. Em produção isso é
 * desejável: o webhook responde rápido e o resto acontece depois. Em teste de
 * integração é veneno: esse trabalho ainda está indo ao banco quando o
 * TRUNCATE do caso seguinte executa, e o erro aparece num teste que não tem
 * nada a ver com a causa.
 *
 * Deixar assentar de verdade (não só ceder o event loop — são idas ao banco)
 * é o preço de testar contra o Postgres real em vez de mock. Vale pagar: foi
 * exatamente isto que revelou dois defeitos que os testes mockados não viam.
 */
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 1000));
});

beforeEach(() => {
  vi.clearAllMocks();
  sendMock.mockResolvedValue({ messageId: 'm1', status: 'sent' });
  runAgentMock.mockResolvedValue({
    text: 'resposta da ia',
    structured: null,
    usage: { inputTokens: 1, outputTokens: 1, usdEstimate: 0, priced: true },
  });
});

describe('ciclo completo contra o banco real', () => {
  it('o atendimento responde e ADORMECE, com o ponto de retomada gravado', async () => {
    const c = await montarCenario();
    await leadEscreve(c);

    const run = await runDa(c.conversation.id);
    expect(run!.status).toBe('sleeping');
    // As colunas da migration existem e foram gravadas — é o que os testes
    // mockados não conseguem provar.
    expect(run!.resumeNodeId).toBe('guarda');
    expect(run!.runAfter!.getTime()).toBeGreaterThan(Date.now());
    // Não pode parecer concluído: o atendimento vai continuar.
    expect(run!.finishedAt).toBeNull();

    // A primeira resposta saiu; a do follow-up ainda não.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1].content).toBe('primeira resposta');
  });

  it('quando a hora chega, RETOMA do ponto guardado e manda o toque', async () => {
    const c = await montarCenario();
    await leadEscreve(c);

    // Um dia depois. Nossa resposta foi a última mensagem, então cabe follow-up.
    await comRetry(() =>
      prisma.message.create({
        data: {
          conversationId: c.conversation.id,
          senderType: 'ai_bot',
          content: 'primeira resposta',
          contentType: 'text',
        },
      })
    );
    await prisma.flowRun.updateMany({
      where: { conversationId: c.conversation.id, status: 'sleeping' },
      data: { runAfter: new Date(Date.now() - 1000) },
    });

    sendMock.mockClear();
    await flowService.processDueRuns();

    const run = await runDa(c.conversation.id);
    expect(run!.status).toBe('done');
    expect(run!.wakeCount).toBe(1);
    expect(run!.resumeNodeId).toBeNull();

    // Só o toque saiu — não repetiu a primeira resposta.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1].content).toBe('toque de follow-up');

    // A timeline ACUMULA no mesmo run: o follow-up é a continuação do mesmo
    // atendimento, e a tela de execuções mostra a conversa inteira em ordem.
    const passos = await prisma.flowRunStep.findMany({
      where: { runId: run!.id },
      orderBy: { ordem: 'asc' },
    });
    expect(passos.map((p) => p.nodeId)).toEqual([
      'gatilho',
      'resposta1',
      'dorme',
      'guarda',
      'resposta2',
    ]);
    // A ordem continua de onde parou. Se reiniciasse em zero, os passos do
    // follow-up colidiriam com os do atendimento e a tela embaralharia.
    expect(passos.map((p) => p.ordem)).toEqual([0, 1, 2, 3, 4]);
  });

  it('o lead responde durante o sono: a cadência MORRE, ninguém é cobrado', async () => {
    const c = await montarCenario();
    await leadEscreve(c);
    expect((await runDa(c.conversation.id))!.status).toBe('sleeping');

    sendMock.mockClear();
    // O lead volta a falar. Isto tem que matar o follow-up agendado.
    await leadEscreve(c, 'desculpa a demora, ainda tenho interesse');

    const dormindo = await prisma.flowRun.findMany({
      where: { conversationId: c.conversation.id, status: 'sleeping' },
    });
    const cancelado = await prisma.flowRun.findFirst({
      where: { conversationId: c.conversation.id, status: 'skipped' },
    });

    expect(cancelado?.stopReason).toBe('lead_respondeu');
    // O run novo dorme; o velho foi cancelado. Nunca dois dormindo.
    expect(dormindo).toHaveLength(1);
    expect(dormindo[0].id).not.toBe(cancelado!.id);
    // E nenhuma mensagem de cobrança saiu.
    expect(sendMock.mock.calls.every((c) => c[1].content !== 'toque de follow-up')).toBe(true);
  });

  it('lead esperando resposta: a guarda impede o toque ao acordar', async () => {
    const c = await montarCenario();
    await leadEscreve(c);

    // A última mensagem da conversa é do lead — ele espera resposta, não cobrança.
    await comRetry(() =>
      prisma.message.create({
        data: {
          conversationId: c.conversation.id,
          senderType: 'customer',
          content: 'e aí?',
          contentType: 'text',
        },
      })
    );
    await prisma.flowRun.updateMany({
      where: { conversationId: c.conversation.id, status: 'sleeping' },
      data: { runAfter: new Date(Date.now() - 1000) },
    });

    sendMock.mockClear();
    await flowService.processDueRuns();

    const run = await runDa(c.conversation.id);
    expect(run!.stopReason).toContain('lead_aguarda_resposta');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('atendente assumiu durante o sono: a IA cala', async () => {
    const c = await montarCenario();
    await leadEscreve(c);

    const user = await comRetry(() =>
      prisma.user.create({
      data: {
        accountId: c.account.id,
        nome: 'Atendente',
        email: `at-${Date.now()}@t.com`,
        passwordHash: 'x',
        role: 'agent',
          status: 'active',
        },
      })
    );
    await comRetry(() =>
      prisma.conversation.update({
        where: { id: c.conversation.id },
        data: { assigneeId: user.id },
      })
    );
    await prisma.flowRun.updateMany({
      where: { conversationId: c.conversation.id, status: 'sleeping' },
      data: { runAfter: new Date(Date.now() - 1000) },
    });

    sendMock.mockClear();
    await flowService.processDueRuns();

    expect((await runDa(c.conversation.id))!.stopReason).toContain('humano_atribuido');
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('cadência semeada roda de verdade', () => {
  it('o grafo do botão é válido e adormece no primeiro toque', async () => {
    const graph = buildFollowupGraph(null);
    // Costura na entrada: gatilho -> primeira espera.
    graph.nodes.unshift({ id: 'gatilho', type: 'trigger.message_received' });
    graph.edges.push({ id: 'entrada', source: 'gatilho', target: 'espera_t1' });

    const c = await montarCenario(graph);
    await leadEscreve(c);

    const run = await runDa(c.conversation.id);
    expect(run!.status).toBe('sleeping');
    expect(run!.resumeNodeId).toBe('guarda_t1');
    // Nada foi enviado ainda: o primeiro toque é só depois de um dia.
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('gatilho externo contra o banco real', () => {
  const corpo = (id: string) => ({
    evento: 'aniversario',
    id,
    data: { telefone: '5511988887777', nome: 'Ana' },
  });

  async function integracaoDe(flowId: string, accountId: string) {
    return comRetry(() =>
      prisma.inboundIntegration.create({
      data: {
        accountId,
        slug: 'pacto',
        handler: 'flow_trigger',
        secret: 'segredo',
        active: true,
        config: {
          flowId,
          campoTelefone: 'data.telefone',
          campoNome: 'data.nome',
            campoDedupe: 'id',
          },
        },
      })
    );
  }

  const GRAFO_EXTERNO: FlowGraph = {
    nodes: [
      { id: 'g', type: 'trigger.webhook' },
      { id: 'r', type: 'chat.reply', config: { texto: 'Parabéns, {{webhook.data.nome}}!' } },
    ],
    edges: [{ id: 'e', source: 'g', target: 'r' }],
  };

  it('a chamada externa cria conversa e o atendimento roda', async () => {
    const c = await montarCenario(GRAFO_EXTERNO);
    const integ = await integracaoDe(c.flow.id, c.account.id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (inboundIntegrationService as any).handleFlowTrigger(
      c.account.id,
      integ,
      corpo('evt-1')
    );
    expect(r.runId).toBeTruthy();

    await prisma.flowRun.update({
      where: { id: r.runId },
      data: { runAfter: new Date(Date.now() - 1000) },
    });
    await flowService.processDueRuns();

    const run = await prisma.flowRun.findUnique({ where: { id: r.runId } });
    expect(run!.status).toBe('done');
    // O corpo do webhook chegou até o nó de resposta e foi interpolado.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1].content).toBe('Parabéns, Ana!');
  });

  it('reentrega do MESMO evento não gera segundo disparo', async () => {
    const c = await montarCenario(GRAFO_EXTERNO);
    const integ = await integracaoDe(c.flow.id, c.account.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = inboundIntegrationService as any;

    const primeira = await svc.handleFlowTrigger(c.account.id, integ, corpo('evt-42'));
    const segunda = await svc.handleFlowTrigger(c.account.id, integ, corpo('evt-42'));

    expect(primeira.runId).toBeTruthy();
    // O índice único do banco é quem barra — não uma consulta prévia, que
    // perderia a corrida entre duas entregas simultâneas do Pacto.
    expect(segunda.duplicado).toBe(true);
    expect(segunda.runId).toBeNull();

    const runs = await prisma.flowRun.count({ where: { accountId: c.account.id } });
    expect(runs).toBe(1);
  });

  it('evento diferente NÃO é confundido com reentrega — falha alto', async () => {
    const c = await montarCenario(GRAFO_EXTERNO);
    const integ = await integracaoDe(c.flow.id, c.account.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = inboundIntegrationService as any;

    await svc.handleFlowTrigger(c.account.id, integ, corpo('evt-1'));

    // Segundo evento, mesmo contato, com o primeiro ainda pendente: bate no
    // índice parcial do agrupamento (um atendimento por conversa). É um
    // conflito REAL, e tratá-lo como duplicata faria o evento sumir calado.
    await expect(svc.handleFlowTrigger(c.account.id, integ, corpo('evt-2'))).rejects.toThrow(
      /atendimento pendente/i
    );
  });

  it('evento novo dispara depois que o anterior saiu da fila', async () => {
    const c = await montarCenario(GRAFO_EXTERNO);
    const integ = await integracaoDe(c.flow.id, c.account.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = inboundIntegrationService as any;

    const primeira = await svc.handleFlowTrigger(c.account.id, integ, corpo('evt-1'));
    await prisma.flowRun.update({
      where: { id: primeira.runId },
      data: { runAfter: new Date(Date.now() - 1000) },
    });
    await flowService.processDueRuns();

    const segunda = await svc.handleFlowTrigger(c.account.id, integ, corpo('evt-2'));
    expect(segunda.runId).toBeTruthy();
    expect(await prisma.flowRun.count({ where: { accountId: c.account.id } })).toBe(2);
  });
});
