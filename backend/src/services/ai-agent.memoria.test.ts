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
  // As etapas reais do funil — lidas quando o schema do agente pede `etapa`.
  tag: { findMany: vi.fn() },
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
import { MEMORIA_LONGA_DIAS, memoriaExpirada, semExpiradas } from './ai/memoria';

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
  prismaMock.tag.findMany.mockResolvedValue([]);
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

/*
  C4 — A MEMÓRIA LONGA TEM VALIDADE.

  O fato sobre a pessoa envelhece. Passado o prazo, a entrada é tratada como
  ausente NA LEITURA — nada é apagado: `lembrar` gravando o mesmo campo renova.
  Valor cru (formato antigo) não tem data, então continua valendo: não dá pra
  saber a idade do que não foi datado.
*/
describe('validade da memória longa', () => {
  const dias = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  it('entrada com mais de 60 dias NÃO entra no prompt', async () => {
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      memory: {
        faturamento: { v: 'R$ 80 mil', por: 'Marcus', em: dias(MEMORIA_LONGA_DIAS + 1) },
        segmento: { v: 'clínica', por: 'Marcus', em: dias(3) },
      },
    });

    const s = systemDe();
    expect(s).not.toContain('R$ 80 mil');
    expect(s).toContain('clínica');
  });

  it('entrada legada (valor cru, sem data) continua entrando', async () => {
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      memory: { faturamento: 'R$ 80 mil' },
    });
    expect(systemDe()).toContain('R$ 80 mil');
  });

  it('a ficha dos campos declarados também trata a vencida como buraco', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(
      agente({
        memoryFields: [{ chave: 'faturamento', descricao: 'Quanto fatura.', escopo: 'memoria' }],
      })
    );
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      memory: { faturamento: { v: 'R$ 80 mil', por: 'Marcus', em: dias(90) } },
    });
    const s = systemDe();
    expect(s).toContain('faturamento: (ainda não sei)');
    expect(s).not.toContain('R$ 80 mil');
  });

  it('o helper: só a entrada datada e velha expira; nada é apagado', () => {
    expect(memoriaExpirada({ v: 'x', por: 'M', em: dias(61) })).toBe(true);
    expect(memoriaExpirada({ v: 'x', por: 'M', em: dias(59) })).toBe(false);
    expect(memoriaExpirada('cru')).toBe(false);
    expect(memoriaExpirada({ v: 'x', por: 'M', em: 'data-ilegível' })).toBe(false);
    const original = { a: { v: 1, em: dias(100) }, b: 'cru' };
    expect(semExpiradas(original)).toEqual({ b: 'cru' });
    expect(original.a).toBeDefined(); // o mapa de origem não é mutado
  });
});

/*
  C4 — QUEM É ESTA PESSOA.

  Cadastro e histórico que o CRM já tem, sem ninguém ter anotado nada. É o que
  faz o lead que sumiu e voltou ser recebido como quem volta.
*/
describe('o bloco "QUEM É ESTA PESSOA"', () => {
  it('lead que volta: cadastro, conversas anteriores e como terminou a última', async () => {
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi de novo',
      memory: { faturamento: 'R$ 80 mil' },
      contato: {
        nome: 'Ana',
        telefone: '5511999990000',
        cidade: 'Campinas',
        estado: 'SP',
        nicho: 'clínica',
        origem: 'whatsapp',
        clienteDesde: new Date('2026-03-12T12:00:00Z'),
        conversasAnteriores: 2,
        ultimaConversa: { em: '2026-09-01T12:00:00Z', etapa: 'agendado', resumo: 'Marcou aula experimental.' },
      },
    });

    const s = systemDe();
    expect(s).toContain('QUEM É ESTA PESSOA');
    expect(s).toContain('nome: Ana');
    expect(s).toContain('Campinas / SP');
    expect(s).toContain('conversas anteriores: 2');
    expect(s).toContain('etapa "agendado"');
    expect(s).toContain('Marcou aula experimental.');
    expect(s).toContain('receba como quem volta');
    // Vem ANTES da memória longa: quem é a pessoa, depois o que anotamos dela.
    expect(s.indexOf('QUEM É ESTA PESSOA')).toBeLessThan(s.indexOf('SOBRE ESTA PESSOA'));
  });

  it('só campos preenchidos entram — sem "(não informado)"', async () => {
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      contato: { nome: 'Ana', telefone: null, cidade: '', conversasAnteriores: 0, ultimaConversa: null },
    });
    const s = systemDe();
    expect(s).toContain('nome: Ana');
    expect(s).not.toContain('telefone');
    expect(s).not.toContain('cidade');
    expect(s).not.toContain('conversas anteriores');
    expect(s).not.toContain('quem volta');
  });

  it('sem contato, nenhum bloco', async () => {
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });
    expect(systemDe()).not.toContain('QUEM É ESTA PESSOA');
  });
});

/*
  C2 — O ENUM DE ETAPA VEM DO KANBAN REAL.

  O schema gravado no agente trazia seis slugs fixos que não existiam em conta
  nenhuma. Em runtime o enum é trocado pelas etapas cadastradas; sem etapa
  cadastrada a propriedade some — o modelo não pode inventar.
*/
describe('etapas reais do funil no schema e no prompt', () => {
  const SCHEMA = {
    type: 'object',
    properties: {
      mensagem_de_resposta: { type: 'string' },
      etapa: { type: 'string', enum: ['novo-lead', 'agendado', 'perdido'] },
    },
    required: ['mensagem_de_resposta', 'etapa'],
  };
  const schemaEnviado = () =>
    chatMock.mock.calls[0][0].jsonSchema.schema as {
      properties: Record<string, { enum?: string[] }>;
      required?: string[];
    };

  it('troca o enum pelos slugs da conta, na ordem do funil, e lista no prompt', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ outputSchema: SCHEMA }));
    prismaMock.tag.findMany.mockResolvedValue([
      { slug: 'contato-inicial', name: 'Contato inicial' },
      { slug: 'aula-marcada', name: 'Aula marcada' },
    ]);
    chatMock.mockResolvedValue(
      resposta({ text: '{"mensagem_de_resposta":"oi","etapa":"aula-marcada"}' })
    );

    const r = await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });

    expect(prismaMock.tag.findMany.mock.calls[0][0].where).toMatchObject({
      accountId: ACC,
      type: 'stage',
      ativo: true,
    });
    expect(schemaEnviado().properties.etapa.enum).toEqual(['contato-inicial', 'aula-marcada']);
    const s = systemDe();
    expect(s).toContain('ETAPAS DO FUNIL (use o nome exato)');
    expect(s).toContain('- contato-inicial — Contato inicial');
    expect(s).toContain('- aula-marcada — Aula marcada');
    expect(r.structured).toMatchObject({ etapa: 'aula-marcada' });
  });

  it('sem etapa cadastrada, a propriedade SOME do schema — nada de inventar', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ outputSchema: SCHEMA }));
    prismaMock.tag.findMany.mockResolvedValue([]);
    chatMock.mockResolvedValue(resposta({ text: '{"mensagem_de_resposta":"oi"}' }));

    const r = await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });

    expect(schemaEnviado().properties.etapa).toBeUndefined();
    expect(schemaEnviado().required).toEqual(['mensagem_de_resposta']);
    expect(systemDe()).not.toContain('ETAPAS DO FUNIL');
    expect(r.structured).toEqual({ mensagem_de_resposta: 'oi' });
  });

  it('o schema gravado no agente não é alterado', async () => {
    const gravado = agente({ outputSchema: SCHEMA });
    prismaMock.aiAgent.findFirst.mockResolvedValue(gravado);
    prismaMock.tag.findMany.mockResolvedValue([{ slug: 'x', name: 'X' }]);
    chatMock.mockResolvedValue(resposta({ text: '{"mensagem_de_resposta":"oi","etapa":"x"}' }));

    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });

    expect((gravado.outputSchema as unknown as typeof SCHEMA).properties.etapa.enum).toEqual([
      'novo-lead',
      'agendado',
      'perdido',
    ]);
  });

  it('agente sem `etapa` no schema não vai ao funil', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(
      agente({ outputSchema: { type: 'object', properties: { texto: { type: 'string' } } } })
    );
    chatMock.mockResolvedValue(resposta({ text: '{"texto":"oi"}' }));
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });
    expect(prismaMock.tag.findMany).not.toHaveBeenCalled();
  });
});

describe('`lembrar` sempre vai ao modelo', () => {
  it('mesmo com tools: [], a ferramenta é enviada', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ tools: [] }));
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });
    const nomes = (chatMock.mock.calls[0][0].tools as { name: string }[]).map((t) => t.name);
    expect(nomes).toContain('lembrar');
  });
});
