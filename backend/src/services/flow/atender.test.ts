/**
 * T-035 — o bloco composto e a entrega grudenta.
 *
 * Dois comportamentos sob teste, e os dois são sobre CONTENÇÃO:
 *
 *   A trava de assunto sempre-humano descarta o texto que o agente escreveu.
 *   Não é exagero: o agente escreveu aquilo para ATENDER, e a decisão de
 *   negócio é que ninguém atende cobrança pela IA. Mandar o texto seria a IA
 *   respondendo sobre cobrança e depois transferindo — o pior dos dois mundos.
 *
 *   A posse da conversa gruda. Sem isso a próxima mensagem re-triaria alguém
 *   no meio de um agendamento.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  conversation: { findFirst: vi.fn() },
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

const sendMock = vi.hoisted(() => vi.fn());
vi.mock('../whatsapp-send.service', () => ({ whatsappSendService: { send: sendMock } }));

const addLabelMock = vi.hoisted(() => vi.fn());
const resolveTagMock = vi.hoisted(() => vi.fn());
vi.mock('../conversation.service', () => ({
  conversationService: { addLabel: addLabelMock, resolveOrCreateTagByLabel: resolveTagMock },
}));

vi.mock('../agent-availability.service', () => ({ agentAvailabilityService: {} }));
vi.mock('../attachment-storage.service', () => ({ attachmentStorageService: {} }));
vi.mock('../ai/transcription', () => ({ transcribe: vi.fn() }));

import { NODE_CATALOG } from './nodes';
import { executeRun } from './engine';
import type { FlowGraph, NodeContext } from './types';

const atender = NODE_CATALOG['ai.atender'];

const ctx = (over: Partial<NodeContext> = {}): NodeContext =>
  ({
    accountId: 'acc-1',
    runId: 'run-1',
    flowId: 'flow-1',
    conversationId: 'conv-1',
    shadow: false,
    actorId: 'flow:flow-1',
    vars: { mensagens: [{ content: 'oi' }] },
    ...over,
  }) as NodeContext;

const no = (config: Record<string, unknown> = {}) => ({
  id: 'atende',
  type: 'ai.atender',
  config: { agentId: 'ag-1', ...config },
});

const respostaAgente = (structured: Record<string, unknown> | null) => ({
  text: 'texto cru',
  structured,
  toolCalls: [],
  hits: [],
  attempts: 1,
  usage: { inputTokens: 10, outputTokens: 5, usdEstimate: 0.0002, priced: true },
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.conversation.findFirst.mockResolvedValue({ assigneeId: null });
  prismaMock.flowRunStep.create.mockResolvedValue({});
  prismaMock.flowRunStep.count.mockResolvedValue(0);
  sendMock.mockResolvedValue({ messageId: 'm1', status: 'sent' });
  resolveTagMock.mockResolvedValue('tag-1');
  addLabelMock.mockResolvedValue(undefined);
});

// ============================================
describe('o caminho normal', () => {
  it('responde, aplica a etapa e sai por "respondeu" — tudo num passo', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'Oi! Como posso ajudar?', etapa: 'novo-lead' })
    );

    const r = await atender.execute(no(), ctx());

    expect(r.branch).toBe('respondeu');
    expect(sendMock.mock.calls[0][1].content).toBe('Oi! Como posso ajudar?');
    expect(resolveTagMock).toHaveBeenCalledWith('acc-1', 'novo-lead', 'flow:flow-1');
    expect(addLabelMock).toHaveBeenCalled();
  });

  it('a saída do agente vira variável pros passos seguintes', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'oi', etapa: 'novo-lead' })
    );
    const r = await atender.execute(no(), ctx());
    expect((r.vars as Record<string, unknown>).agente).toMatchObject({ etapa: 'novo-lead' });
  });

  it('pediu humano vira a porta "humano", e a mensagem AINDA é enviada', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({
        mensagem_de_resposta: 'Vou te passar pro time, um instante.',
        transferir_para_humano: true,
      })
    );

    const r = await atender.execute(no(), ctx());

    expect(r.branch).toBe('humano');
    // O lead precisa saber que está sendo transferido — silêncio aqui é pior.
    expect(sendMock).toHaveBeenCalled();
  });

  it('rota declarada pelo agente vence os sinais genéricos', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'ok', rota: 'agendamento' })
    );
    const r = await atender.execute(no(), ctx());
    expect(r.branch).toBe('agendamento');
  });

  it('em modo sombra nada sai e nada muda no funil', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'oi', etapa: 'novo-lead' })
    );

    const r = await atender.execute(no(), ctx({ shadow: true }));

    expect(sendMock).not.toHaveBeenCalled();
    expect(addLabelMock).not.toHaveBeenCalled();
    // Mas o passo registra o que TERIA feito — é o que o simulador mostra.
    expect(r.output).toMatchObject({ simulado: true, etapa: 'novo-lead' });
  });

  it('humano assumiu durante o agrupamento: não fala por cima', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({ assigneeId: 'user-1' });
    runAgentMock.mockResolvedValue(respostaAgente({ mensagem_de_resposta: 'oi' }));

    const r = await atender.execute(no(), ctx());

    expect(r.stop).toBe(true);
    expect(r.stopReason).toBe('humano_assumiu_durante_o_fluxo');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sem agente escolhido para antes de gastar token', async () => {
    const r = await atender.execute({ id: 'a', type: 'ai.atender', config: {} }, ctx());
    expect(r.stopReason).toBe('agente_nao_configurado');
    expect(runAgentMock).not.toHaveBeenCalled();
  });
});

// ============================================
describe('trava de assunto sempre-humano', () => {
  const comTrava = () => no({ rotasSempreHumano: ['cobranca', 'juridico'] });

  it('DESCARTA o texto do agente e transfere', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({
        mensagem_de_resposta: 'Seu boleto vence dia 10 e o valor é R$ 179.',
        rota: 'cobranca',
      })
    );

    const r = await atender.execute(comTrava(), ctx());

    expect(r.branch).toBe('humano');
    // O ponto inteiro: a resposta sobre cobrança NÃO chega ao lead.
    expect(sendMock).not.toHaveBeenCalled();
    expect(r.output).toMatchObject({ motivo: 'assunto_sempre_humano' });
  });

  it('a resposta descartada fica registrada — dá pra auditar o que ela ia dizer', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'Seu boleto vence dia 10.', rota: 'cobranca' })
    );
    const r = await atender.execute(comTrava(), ctx());
    expect((r.output as Record<string, string>).respostaDescartada).toContain('boleto');
  });

  it('com aviso configurado, manda só o aviso', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'Seu boleto vence dia 10.', rota: 'cobranca' })
    );

    await atender.execute(
      no({ rotasSempreHumano: ['cobranca'], mensagemAoTransferir: 'Vou te passar pro financeiro.' }),
      ctx()
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1].content).toBe('Vou te passar pro financeiro.');
  });

  it('rota fora da lista segue normal', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'Temos turma às 6h.', rota: 'agendamento' })
    );
    const r = await atender.execute(comTrava(), ctx());
    expect(r.branch).toBe('agendamento');
    expect(sendMock).toHaveBeenCalled();
  });

  it('a trava não depende de caixa alta ou baixa', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'x', rota: 'Cobranca' })
    );
    const r = await atender.execute(comTrava(), ctx());
    expect(r.branch).toBe('humano');
  });

  it('a etapa NÃO é aplicada quando a trava dispara', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'x', rota: 'cobranca', etapa: 'em-atendimento' })
    );
    await atender.execute(comTrava(), ctx());
    // A classificação do agente não vale quando a decisão dele foi vetada.
    expect(addLabelMock).not.toHaveBeenCalled();
  });
});

// ============================================
describe('posse da conversa (entrega grudenta)', () => {
  const grafo = (extra: Partial<FlowGraph> = {}): FlowGraph => ({
    nodes: [
      { id: 'gatilho', type: 'trigger.message_received' },
      { id: 'triagem', type: 'ai.atender', config: { agentId: 'ag-1' } },
      { id: 'agendamento', type: 'ai.atender', config: { agentId: 'ag-2' } },
      { id: 'fim', type: 'chat.resolve', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'gatilho', target: 'triagem' },
      { id: 'e2', source: 'triagem', target: 'agendamento', branch: 'agendamento' },
      { id: 'e3', source: 'triagem', target: 'fim', branch: 'encerrou' },
    ],
    ...extra,
  });

  const rodar = (over: Record<string, unknown> = {}) =>
    executeRun({
      runId: 'run-1',
      accountId: 'acc-1',
      flowId: 'flow-1',
      conversationId: 'conv-1',
      shadow: true, // sombra: o teste é sobre roteamento, não sobre envio
      graph: grafo(),
      vars: { mensagens: [{ content: 'oi' }] },
      ...over,
    });

  it('entregar a outro agente grava a posse', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'te passo pro agendamento', rota: 'agendamento' })
    );

    const r = await rodar();

    expect(r.vars.__blocoAtivo).toBe('agendamento');
  });

  it('encerrar limpa a posse', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'tchau', resolver_conversa: true })
    );
    const r = await rodar();
    expect(r.vars.__blocoAtivo).toBeNull();
  });

  it('passar pra humano limpa a posse', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'um instante', transferir_para_humano: true })
    );
    const r = await rodar();
    expect(r.vars.__blocoAtivo).toBeNull();
  });

  it('só responder NÃO mexe na posse — o especialista continua dono', async () => {
    runAgentMock.mockResolvedValue(respostaAgente({ mensagem_de_resposta: 'temos às 6h' }));

    // Retomando no agendamento, como aconteceria na segunda mensagem.
    const r = await rodar({ resumeNodeId: 'agendamento' });

    // Ausente, não nulo: "o fluxo não se pronunciou" é diferente de "solte".
    expect('__blocoAtivo' in r.vars).toBe(false);
  });

  it('retomar no especialista não refaz a triagem', async () => {
    runAgentMock.mockResolvedValue(respostaAgente({ mensagem_de_resposta: 'temos às 6h' }));

    await rodar({ resumeNodeId: 'agendamento' });

    // Um run só do especialista: se a triagem tivesse rodado, seriam dois.
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock.mock.calls[0][0].agentId).toBe('ag-2');
  });
});
