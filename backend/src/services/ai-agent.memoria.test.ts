/**
 * T-030b — memória de curto e longo prazo.
 *
 * A distinção não é acadêmica: se a memória de longo prazo morasse na conversa,
 * ela sumiria quando a conversa fosse resolvida — e o lead que volta em março
 * seria tratado como desconhecido. E sem o resumo, conversa longa perde o
 * começo, que é justamente onde a qualificação acontece.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  aiAgent: { findFirst: vi.fn(), findMany: vi.fn() },
  conversation: { findFirst: vi.fn(), update: vi.fn() },
  contact: { findFirst: vi.fn(), update: vi.fn() },
  message: { findMany: vi.fn(), count: vi.fn() },
}));

vi.mock('../config/database', () => ({ prisma: prismaMock }));
vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./ai/knowledge-index', () => ({
  search: vi.fn(async () => []),
  formatHitsForPrompt: vi.fn(() => ''),
}));

const chatMock = vi.hoisted(() => vi.fn());
vi.mock('./ai/chat', () => ({ chat: chatMock }));

import { aiAgentService, AVAILABLE_TOOLS } from './ai-agent.service';

const ACC = 'acc-1';

const agente = (over: Record<string, unknown> = {}) => ({
  id: 'ag-1',
  accountId: ACC,
  name: 'Marcus',
  description: null,
  role: 'responder',
  systemPrompt: 'Você é o Marcus.',
  provider: 'openai',
  model: null,
  temperature: 0.7,
  maxTokens: 1024,
  historyLimit: 20,
  knowledgeBaseId: null,
  tools: [],
  outputSchema: null,
  subAgentIds: null,
  active: true,
  knowledgeBase: null,
  ...over,
});

const resposta = (over: Record<string, unknown> = {}) => ({
  text: 'ok',
  toolCalls: [],
  model: 'gpt-4o-mini',
  provider: 'openai',
  usage: { inputTokens: 10, outputTokens: 5, usdEstimate: 0.0001, priced: true },
  finishReason: 'stop',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.aiAgent.findFirst.mockResolvedValue(agente());
  prismaMock.aiAgent.findMany.mockResolvedValue([]);
  prismaMock.conversation.findFirst.mockResolvedValue({ id: 'conv-1', customAttributes: {} });
  prismaMock.message.count.mockResolvedValue(0);
  prismaMock.message.findMany.mockResolvedValue([]);
  chatMock.mockResolvedValue(resposta());
});

const systemDe = (n = 0) => chatMock.mock.calls[n][0].system as string;

describe('as duas memórias chegam separadas no prompt', () => {
  it('longo prazo fala da pessoa, curto prazo fala da conversa', async () => {
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      memory: { faturamento: 'R$ 80 mil' },
      session: { etapa_roteiro: 'aguardando confirmação de horário' },
    });

    const s = systemDe();
    expect(s).toContain('SOBRE ESTA PESSOA');
    expect(s).toContain('vale entre conversas');
    expect(s).toContain('R$ 80 mil');

    expect(s).toContain('NESTA CONVERSA');
    expect(s).toContain('não recomece o roteiro');
    expect(s).toContain('aguardando confirmação de horário');

    // O longo prazo vem antes: fato sobre a pessoa pesa mais que estado do papo.
    expect(s.indexOf('SOBRE ESTA PESSOA')).toBeLessThan(s.indexOf('NESTA CONVERSA'));
  });

  it('chave de controle interno não vaza pro prompt', async () => {
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      session: { _resumo_conversa: { texto: 'x' }, etapa: 'diagnostico' },
    });

    const s = systemDe();
    expect(s).toContain('diagnostico');
    expect(s).not.toContain('_resumo_conversa');
  });
});

describe('as duas formas de memória convivem', () => {
  it('lê valor antigo (cru) e novo (com autoria) no mesmo prompt', async () => {
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      memory: {
        // Como estava gravado antes desta mudança.
        segmento: 'clínica',
        // Como passa a ser gravado. Migrar dado de cliente em produção seria
        // risco desnecessário — as duas formas coexistem.
        faturamento: { v: 'R$ 80 mil', por: 'Marcus', em: '2026-09-15T10:00:00Z' },
      },
    });

    const s = systemDe();
    expect(s).toContain('clínica');
    expect(s).toContain('R$ 80 mil');
    // O envelope não vaza pro prompt — o agente vê o fato, não o metadado.
    expect(s).not.toContain('"por"');
    expect(s).not.toContain('Marcus\"');
  });
});

describe('escopo por agente na memória de conversa', () => {
  it('o agente vê o que é de todos e o que é dele', async () => {
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      session: {
        etapa_roteiro: 'diagnostico',
        '_agente.ag-1.passo_interno': 'confirmando horário',
      },
    });

    const s = systemDe();
    expect(s).toContain('diagnostico');
    expect(s).toContain('confirmando horário');
    // O prefixo some: dentro do prompt é só o nome do campo.
    expect(s).not.toContain('_agente.ag-1');
  });

  it('NÃO vê o rascunho de trabalho de outro agente', async () => {
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      session: {
        etapa_roteiro: 'diagnostico',
        '_agente.ag-2.passo_interno': 'escolhendo horário',
      },
    });

    const s = systemDe();
    expect(s).toContain('diagnostico');
    // Com quatro agentes, sem isto o prompt de cada um enche do rascunho
    // dos outros — ruído que custa token e confunde.
    expect(s).not.toContain('escolhendo horário');
  });
});

describe('resumo do histórico', () => {
  const conversaCom = (attrs: Record<string, unknown>) =>
    prismaMock.conversation.findFirst.mockResolvedValue({ id: 'conv-1', customAttributes: attrs });

  it('conversa curta não gasta chamada resumindo', async () => {
    prismaMock.message.count.mockResolvedValue(5); // cabe na janela de 20
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      conversationId: 'conv-1',
    });
    // Uma chamada só: a do próprio agente.
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(systemDe()).not.toContain('RESUMO');
  });

  it('quando passa da janela, resume o que saiu e guarda', async () => {
    prismaMock.message.count.mockResolvedValue(40); // 20 fora da janela
    prismaMock.message.findMany
      .mockResolvedValueOnce([{ senderType: 'customer', content: 'oi' }]) // janela
      .mockResolvedValueOnce([
        { senderType: 'customer', content: 'faturo 80 mil' },
        { senderType: 'agent', content: 'entendi' },
      ]); // trecho antigo
    chatMock
      .mockResolvedValueOnce(resposta({ text: 'Lead fatura 80 mil.' })) // resumo
      .mockResolvedValueOnce(resposta({ text: 'resposta ao lead' })); // agente

    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'e aí?',
      conversationId: 'conv-1',
    });

    // Guardou junto com quantas mensagens já cobre — é o que evita resumir de novo.
    const salvo = prismaMock.conversation.update.mock.calls[0][0].data.customAttributes;
    expect(salvo._resumo_conversa.texto).toBe('Lead fatura 80 mil.');
    expect(salvo._resumo_conversa.cobertas).toBe(20);

    // E o resumo entrou no prompt do agente.
    expect(systemDe(1)).toContain('RESUMO DO QUE JÁ FOI CONVERSADO');
    expect(systemDe(1)).toContain('Lead fatura 80 mil.');
  });

  it('resumo ainda em dia é reaproveitado sem nova chamada', async () => {
    prismaMock.message.count.mockResolvedValue(45); // 25 fora da janela
    conversaCom({ _resumo_conversa: { texto: 'Já resumido.', cobertas: 20 } });

    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      conversationId: 'conv-1',
    });

    // Só 5 mensagens novas saíram da janela — abaixo do limiar de 10.
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
    expect(systemDe()).toContain('Já resumido.');
  });

  it('resumo acumula: o anterior entra como base do novo', async () => {
    prismaMock.message.count.mockResolvedValue(55); // 35 fora, resumo cobre 20
    conversaCom({ _resumo_conversa: { texto: 'Parte 1.', cobertas: 20 } });
    prismaMock.message.findMany
      .mockResolvedValueOnce([{ senderType: 'customer', content: 'recente' }])
      .mockResolvedValueOnce([{ senderType: 'customer', content: 'trecho novo' }]);
    chatMock
      .mockResolvedValueOnce(resposta({ text: 'Parte 1 + 2.' }))
      .mockResolvedValueOnce(resposta({ text: 'ok' }));

    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      conversationId: 'conv-1',
    });

    // O pedido de resumo carrega o resumo anterior — nada se perde a cada compressão.
    const pedido = chatMock.mock.calls[0][0].messages[0].content as string;
    expect(pedido).toContain('Parte 1.');
    expect(pedido).toContain('trecho novo');
  });

  it('falha ao resumir não derruba o atendimento', async () => {
    prismaMock.message.count.mockResolvedValue(40);
    prismaMock.message.findMany
      .mockResolvedValueOnce([{ senderType: 'customer', content: 'oi' }])
      .mockResolvedValueOnce([{ senderType: 'customer', content: 'antigo' }]);
    chatMock
      .mockRejectedValueOnce(new Error('cota estourada')) // resumo falha
      .mockResolvedValueOnce(resposta({ text: 'atendo assim mesmo' })); // agente segue

    const r = await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      conversationId: 'conv-1',
    });

    expect(r.text).toBe('atendo assim mesmo');
  });
});

describe('ferramenta lembrar — o agente decide o que guardar', () => {
  const ctx = { accountId: ACC, agent: agente() as never, contactId: 'contato-1' };

  it('grava no CONTATO, que é o que sobrevive à conversa', async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ customAttributes: { segmento: 'clínica' } });

    const saida = await AVAILABLE_TOOLS.lembrar.execute(
      { campo: 'faturamento_mensal', valor: 'R$ 80 mil' },
      ctx
    );

    expect(saida).toContain('Guardado');
    const gravado = prismaMock.contact.update.mock.calls[0][0].data.customAttributes;
    // Preserva o que já existia — não sobrescreve a memória inteira.
    expect(gravado.segmento).toBe('clínica');
    // E grava COM AUTORIA: com vários agentes escrevendo, um fato errado
    // contamina todos, e sem isto não há como saber de qual deles veio.
    expect(gravado.faturamento_mensal).toMatchObject({ v: 'R$ 80 mil', por: 'Marcus' });
    expect(typeof gravado.faturamento_mensal.em).toBe('string');
  });

  it('sem contato vinculado, avisa em vez de gravar em lugar nenhum', async () => {
    const saida = await AVAILABLE_TOOLS.lembrar.execute(
      { campo: 'x', valor: 'y' },
      { ...ctx, contactId: null }
    );
    expect(saida).toContain('não tem contato vinculado');
    expect(prismaMock.contact.update).not.toHaveBeenCalled();
  });

  it('não deixa o modelo sobrescrever chave de controle interno', async () => {
    const saida = await AVAILABLE_TOOLS.lembrar.execute(
      { campo: '_resumo_conversa', valor: 'apagado' },
      ctx
    );
    expect(saida).toContain('inválido');
    expect(prismaMock.contact.update).not.toHaveBeenCalled();
  });

  it('campo ou valor vazio não vira memória', async () => {
    expect(await AVAILABLE_TOOLS.lembrar.execute({ campo: '  ', valor: 'y' }, ctx)).toContain(
      'Informe'
    );
    expect(prismaMock.contact.update).not.toHaveBeenCalled();
  });
});
