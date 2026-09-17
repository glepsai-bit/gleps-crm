/**
 * T-037 — campos de memória declarados pelo admin.
 *
 * O que está sob teste tem dois lados, e o primeiro é o que não pode mudar:
 * agente SEM campos declarados é toda a produção de hoje, e continua com campo
 * livre gravando no contato. O segundo é o contrato novo — chave vinda de um
 * enum, descrição por chave, e o escopo decidindo se o fato mora na pessoa ou
 * na conversa.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  aiAgent: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
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
  loadOverview: vi.fn(async () => null),
  formatHitsForPrompt: vi.fn(() => ''),
  formatBusinessContext: vi.fn(() => ''),
  formatBaseIndex: vi.fn(() => ''),
}));

const chatMock = vi.hoisted(() => vi.fn());
vi.mock('./ai/chat', () => ({ chat: chatMock }));

import { aiAgentService, AVAILABLE_TOOLS } from './ai-agent.service';
import {
  lerCamposDeMemoria,
  validarCamposDeMemoria,
  definicaoDoLembrarDeclarado,
  type CampoDeMemoria,
} from './ai/memoria-declarada';

const ACC = 'acc-1';

const CAMPOS: CampoDeMemoria[] = [
  {
    chave: 'faturamento_mensal',
    descricao: 'Quanto o negócio do lead fatura por mês, como ele falou.',
    escopo: 'memoria',
  },
  { chave: 'decisor', descricao: 'Quem assina a decisão de compra.', escopo: 'memoria' },
  {
    chave: 'objecao_atual',
    descricao: 'A objeção que está travando ESTA conversa.',
    escopo: 'sessao',
  },
];

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
  tools: ['lembrar'],
  outputSchema: null,
  subAgentIds: null,
  httpTools: null,
  memoryFields: [],
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
  prismaMock.aiAgent.update.mockImplementation(async (a: { data: unknown }) => a.data);
  prismaMock.conversation.findFirst.mockResolvedValue({ id: 'conv-1', customAttributes: {} });
  prismaMock.contact.findFirst.mockResolvedValue({ customAttributes: {} });
  prismaMock.message.count.mockResolvedValue(0);
  prismaMock.message.findMany.mockResolvedValue([]);
  chatMock.mockResolvedValue(resposta());
});

const systemDe = (n = 0) => chatMock.mock.calls[n][0].system as string;
const lembrarEnviado = (n = 0) =>
  (chatMock.mock.calls[n][0].tools as { name: string; description: string; parameters: Record<string, unknown> }[]).find(
    (t) => t.name === 'lembrar'
  )!;

// ============================================
// REGRESSÃO — o agente que já existe em produção
// ============================================

describe('agente SEM campos declarados segue como hoje', () => {
  it('a ferramenta continua com campo livre, sem enum', async () => {
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });

    const lembrar = lembrarEnviado();
    const campo = (lembrar.parameters.properties as Record<string, Record<string, unknown>>).campo;
    expect(campo.type).toBe('string');
    expect(campo.enum).toBeUndefined();
    // A definição é a do catálogo, intocada.
    expect(lembrar.description).toBe(AVAILABLE_TOOLS.lembrar.definition.description);
  });

  it('grava no CONTATO qualquer campo que o modelo escolher', async () => {
    prismaMock.contact.findFirst.mockResolvedValue({ customAttributes: { segmento: 'clínica' } });

    const saida = await AVAILABLE_TOOLS.lembrar.execute(
      { campo: 'receita_mensal', valor: 'R$ 80 mil' },
      { accountId: ACC, agent: agente() as never, contactId: 'contato-1' }
    );

    expect(saida).toContain('Guardado');
    const gravado = prismaMock.contact.update.mock.calls[0][0].data.customAttributes;
    expect(gravado.segmento).toBe('clínica');
    expect(gravado.receita_mensal).toMatchObject({ v: 'R$ 80 mil', por: 'Marcus' });
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
  });

  it('o prompt não ganha bloco de ficha', async () => {
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });
    expect(systemDe()).not.toContain('FICHA QUE VOCÊ MANTÉM');
  });
});

// ============================================
// A FERRAMENTA, quando há campos declarados
// ============================================

describe('agente COM campos declarados', () => {
  beforeEach(() => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ memoryFields: CAMPOS }));
  });

  it('o enum com as chaves declaradas chega ao modelo', async () => {
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });

    const campo = (lembrarEnviado().parameters.properties as Record<string, Record<string, unknown>>)
      .campo;
    expect(campo.enum).toEqual(['faturamento_mensal', 'decisor', 'objecao_atual']);
  });

  it('a descrição lista cada chave com o que vai nela', async () => {
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });

    const d = lembrarEnviado().description;
    // O enum diz quais nomes existem; só a descrição diz QUANDO usar cada um.
    expect(d).toContain('faturamento_mensal');
    expect(d).toContain('Quanto o negócio do lead fatura por mês');
    expect(d).toContain('decisor');
    expect(d).toContain('Quem assina a decisão de compra.');
    expect(d).toContain('objecao_atual');
    // E o escopo aparece: o modelo precisa saber o que sobrevive à conversa.
    expect(d).toContain('só esta conversa');
    expect(d).toContain('vale entre conversas');
  });

  it('recusa chave fora do declarado e diz quais valem', async () => {
    // O enum barra no provider, mas nem todo modelo respeita enum — e chave
    // inventada é exatamente o que esta feature veio impedir.
    const saida = await AVAILABLE_TOOLS.lembrar.execute(
      { campo: 'receita_mensal', valor: 'R$ 80 mil' },
      { accountId: ACC, agent: agente() as never, contactId: 'contato-1', camposDeMemoria: CAMPOS }
    );

    expect(saida).toContain('não é um campo deste atendimento');
    expect(saida).toContain('faturamento_mensal');
    expect(prismaMock.contact.update).not.toHaveBeenCalled();
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
  });
});

// ============================================
// ESCOPO — onde o fato mora
// ============================================

describe('escopo decide o destino da gravação', () => {
  const ctx = {
    accountId: ACC,
    agent: agente() as never,
    contactId: 'contato-1',
    conversationId: 'conv-1',
    camposDeMemoria: CAMPOS,
  };

  it('campo de escopo "sessao" grava na CONVERSA, não no contato', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      customAttributes: { _resumo_conversa: { texto: 'x' } },
    });

    const saida = await AVAILABLE_TOOLS.lembrar.execute(
      { campo: 'objecao_atual', valor: 'achou caro' },
      ctx
    );

    expect(saida).toContain('nesta conversa');
    expect(prismaMock.contact.update).not.toHaveBeenCalled();

    const gravado = prismaMock.conversation.update.mock.calls[0][0].data.customAttributes;
    expect(gravado.objecao_atual).toMatchObject({ v: 'achou caro', por: 'Marcus' });
    expect(typeof gravado.objecao_atual.em).toBe('string');
    // Preserva o controle interno que já estava lá.
    expect(gravado._resumo_conversa).toEqual({ texto: 'x' });
    // Chave crua, sem o prefixo de rascunho privado `_agente.<id>.`: campo
    // declarado é dado do atendimento, tem que ser legível por outro agente.
    expect(Object.keys(gravado)).toContain('objecao_atual');
  });

  it('campo de escopo "memoria" grava no CONTATO', async () => {
    await AVAILABLE_TOOLS.lembrar.execute({ campo: 'decisor', valor: 'o sócio' }, ctx);

    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
    const gravado = prismaMock.contact.update.mock.calls[0][0].data.customAttributes;
    expect(gravado.decisor).toMatchObject({ v: 'o sócio', por: 'Marcus' });
  });

  it('campo de conversa sem conversa avisa em vez de gravar em outro lugar', async () => {
    const saida = await AVAILABLE_TOOLS.lembrar.execute(
      { campo: 'objecao_atual', valor: 'achou caro' },
      { ...ctx, conversationId: null }
    );
    expect(saida).toContain('não há conversa');
    expect(prismaMock.contact.update).not.toHaveBeenCalled();
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
  });

  it('a guarda do "_" continua valendo mesmo com campos declarados', async () => {
    const saida = await AVAILABLE_TOOLS.lembrar.execute(
      { campo: '_resumo_conversa', valor: 'apagado' },
      ctx
    );
    expect(saida).toContain('inválido');
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
  });
});

// ============================================
// O PROMPT — inclusive o que falta descobrir
// ============================================

describe('a ficha no prompt', () => {
  beforeEach(() => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ memoryFields: CAMPOS }));
  });

  it('mostra o preenchido e o que ainda falta', async () => {
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      memory: { faturamento_mensal: { v: 'R$ 80 mil', por: 'Marcus', em: 'x' } },
      session: { objecao_atual: 'achou caro' },
    });

    const s = systemDe();
    expect(s).toContain('FICHA QUE VOCÊ MANTÉM');
    expect(s).toContain('faturamento_mensal: R$ 80 mil');
    expect(s).toContain('objecao_atual: achou caro');
    // O buraco é metade do valor: sem isto o agente nunca sabe o que falta.
    expect(s).toContain('decisor: (ainda não sei)');
    expect(s).toContain('Quem assina a decisão de compra.');
  });

  it('não repete na ficha e no bloco de memória o mesmo fato', async () => {
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      memory: { faturamento_mensal: 'R$ 80 mil', segmento: 'clínica' },
    });

    const s = systemDe();
    // Uma vez só — o mesmo fato duas vezes custa token e sugere dois fatos.
    expect(s.match(/faturamento_mensal/g)?.length).toBe(1);
    // O que não é declarado segue no bloco genérico, como sempre.
    expect(s).toContain('SOBRE ESTA PESSOA');
    expect(s).toContain('clínica');
  });
});

// ============================================
// VALIDAÇÃO — o que o admin pode declarar
// ============================================

describe('validação dos campos declarados', () => {
  it('aceita o bem formado', () => {
    const { campos, erros } = validarCamposDeMemoria(CAMPOS);
    expect(erros).toEqual([]);
    expect(campos).toHaveLength(3);
    // Escopo omitido cai em `memoria`: fato sobre a pessoa é o caso comum.
    expect(validarCamposDeMemoria([{ chave: 'dor', descricao: 'A dor principal.' }]).campos[0])
      .toMatchObject({ escopo: 'memoria' });
  });

  it('recusa chave começando com "_" (reservado ao sistema)', () => {
    const { campos, erros } = validarCamposDeMemoria([
      { chave: '_resumo_conversa', descricao: 'sequestro do controle interno', escopo: 'sessao' },
    ]);
    expect(campos).toHaveLength(0);
    expect(erros.join(' ')).toContain('não pode começar com "_"');
  });

  it('recusa chave duplicada', () => {
    const { campos, erros } = validarCamposDeMemoria([
      { chave: 'decisor', descricao: 'Quem decide.', escopo: 'memoria' },
      { chave: 'decisor', descricao: 'Outra coisa qualquer.', escopo: 'sessao' },
    ]);
    // Duas declarações na mesma chave são uma memória com duas descrições.
    expect(erros.join(' ')).toContain('repetida');
    expect(campos).toHaveLength(1);
  });

  it('recusa chave com espaço, maiúscula ou acento, e campo sem descrição', () => {
    const { erros } = validarCamposDeMemoria([
      { chave: 'Faturamento Mensal', descricao: 'x' },
      { chave: 'objeção', descricao: 'x' },
      { chave: 'decisor', descricao: '   ' },
    ]);
    expect(erros).toHaveLength(3);
    expect(erros.join(' ')).toContain('descreva o que guardar');
  });

  it('o update do agente rejeita a declaração inválida', async () => {
    await expect(
      aiAgentService.update(ACC, 'ag-1', {
        memoryFields: [{ chave: '_interno', descricao: 'nope' }],
      })
    ).rejects.toThrow(/_/);
    expect(prismaMock.aiAgent.update).not.toHaveBeenCalled();
  });

  it('o update grava a lista normalizada', async () => {
    await aiAgentService.update(ACC, 'ag-1', {
      memoryFields: [{ chave: ' decisor ', descricao: ' Quem decide. ' }],
    });
    const data = prismaMock.aiAgent.update.mock.calls[0][0].data;
    expect(data.memoryFields).toEqual([
      { chave: 'decisor', descricao: 'Quem decide.', escopo: 'memoria' },
    ]);
  });
});

describe('leitura tolerante do que já está gravado', () => {
  it('registro torto não derruba o agente — volta ao campo livre', () => {
    expect(lerCamposDeMemoria(null)).toEqual([]);
    expect(lerCamposDeMemoria('faturamento')).toEqual([]);
    expect(lerCamposDeMemoria([{ chave: 'x' }, { descricao: 'sem chave' }, 42])).toEqual([]);
  });

  it('descarta o inválido e fica com a primeira das repetidas', () => {
    const campos = lerCamposDeMemoria([
      { chave: 'decisor', descricao: 'primeira', escopo: 'memoria' },
      { chave: 'decisor', descricao: 'segunda', escopo: 'sessao' },
      { chave: '_interno', descricao: 'reservado' },
    ]);
    expect(campos).toEqual([{ chave: 'decisor', descricao: 'primeira', escopo: 'memoria' }]);
  });

  it('a definição da ferramenta sai igual da lista lida', () => {
    const def = definicaoDoLembrarDeclarado(lerCamposDeMemoria(CAMPOS));
    expect(def.name).toBe('lembrar');
    expect((def.parameters.required as string[])).toEqual(['campo', 'valor']);
  });
});

// ============================================
// REGRESSÃO — o escopo declarado não pode ESCONDER o que já se sabe
// ============================================

describe('o valor gravado no escopo oposto continua visível', () => {
  const NOME_NA_SESSAO: CampoDeMemoria[] = [
    { chave: 'nome', descricao: 'Como o lead quer ser chamado.', escopo: 'sessao' },
    { chave: 'faturamento_mensal', descricao: 'Quanto fatura por mês.', escopo: 'memoria' },
  ];

  it('campo declarado como "sessao" não apaga o que está na memória do contato', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ memoryFields: NOME_NA_SESSAO }));

    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      memory: { nome: 'João' },
    });

    const s = systemDe();
    // O "João" ESTÁ gravado no contato. Sumir com ele do bloco da pessoa porque
    // a ficha "cuida" da chave — mas a ficha olha a conversa, onde não há nada —
    // faz o agente perguntar o nome de quem ele já conhece.
    expect(s).toContain('O QUE SABEMOS SOBRE ESTA PESSOA');
    expect(s).toContain('nome: João');
  });

  it('a ficha NÃO diz "ainda não sei" de um fato que está no outro escopo', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ memoryFields: NOME_NA_SESSAO }));

    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      memory: { nome: 'João' }, // gravado no contato; declarado como 'sessao'
    });

    const s = systemDe();
    // Mostrar "João" num bloco e "nome: (ainda não sei)" no outro é um prompt
    // que se contradiz — e quem decide o que fazer com a contradição passa a
    // ser o modelo. A ficha procura o fato nos dois escopos: o escopo diz onde
    // GRAVAR, não onde o fato pode estar.
    expect(s).not.toContain('nome: (ainda não sei)');
    expect(s).toContain('nome: João');
    // O campo que de fato ninguém preencheu continua sendo pedido.
    expect(s).toContain('faturamento_mensal: (ainda não sei)');
  });

  it('campo declarado como "memoria" não apaga o que está na conversa', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(
      agente({
        memoryFields: [
          { chave: 'objecao_atual', descricao: 'A objeção que trava.', escopo: 'memoria' },
        ],
      })
    );

    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      session: { objecao_atual: 'achou caro' },
    });

    const s = systemDe();
    expect(s).toContain('ONDE ESTAMOS NESTA CONVERSA');
    expect(s).toContain('objecao_atual: achou caro');
  });

  it('e no escopo em que foi declarado segue aparecendo uma vez só', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ memoryFields: NOME_NA_SESSAO }));

    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      // Cada um no seu escopo: a ficha mostra os dois, os blocos genéricos não
      // repetem nenhum. A correção do escopo não pode ressuscitar a duplicata.
      memory: { faturamento_mensal: 'R$ 80 mil' },
      session: { nome: 'João' },
    });

    const s = systemDe();
    expect(s.match(/faturamento_mensal/g)?.length).toBe(1);
    expect(s.match(/nome: João/g)?.length).toBe(1);
  });
});

// ============================================
// A FICHA E A FERRAMENTA — duas telas, um estado possível
// ============================================

/*
  C4 — MEMÓRIA É NATIVA.

  Antes, `lembrar` só ia ao modelo se estivesse na lista de ferramentas do
  agente, e a ficha tinha que descobrir isso pra não mandar usar o que não
  existia. Era um estado silencioso: campos declarados, ferramenta esquecida,
  nada gravado. Agora `lembrar` vai SEMPRE — anotar o que o lead disse não é
  opcional num atendimento — e a ficha sempre pode pedir.
*/
describe('`lembrar` é nativa: vai ao modelo mesmo fora da lista de ferramentas', () => {
  it('com tools: [] a ferramenta é enviada e a ficha pede o que falta', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(
      agente({ memoryFields: CAMPOS, tools: [] })
    );

    await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'oi',
      memory: { faturamento_mensal: { v: 'R$ 80 mil', por: 'Marcus', em: new Date().toISOString() } },
    });

    expect(lembrarEnviado()).toBeDefined();
    const s = systemDe();
    expect(s).toContain('FICHA QUE VOCÊ MANTÉM');
    expect(s).toContain('Use a ferramenta `lembrar`');
    expect(s).toContain('R$ 80 mil');
    expect(s).toContain('decisor: (ainda não sei)');
  });

  it('sem campos declarados e com tools: [], vai a definição livre do catálogo', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ tools: [] }));

    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });

    const lembrar = lembrarEnviado();
    expect(lembrar.description).toBe(AVAILABLE_TOOLS.lembrar.definition.description);
  });

  it('listar `lembrar` nas ferramentas não a duplica', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(
      agente({ memoryFields: CAMPOS, tools: ['lembrar', 'buscar_conhecimento'] })
    );

    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });

    const nomes = (chatMock.mock.calls[0][0].tools as { name: string }[]).map((t) => t.name);
    expect(nomes.filter((n) => n === 'lembrar')).toHaveLength(1);
    expect(nomes).toContain('buscar_conhecimento');
  });
});

// ============================================
// NOMES RESERVADOS AO ATENDIMENTO — o circuit breaker
// ============================================

describe('chave reservada ao atendimento é recusada', () => {
  // Os nomes lidos por valor exato nos customAttributes da conversa. O pior é
  // `human_active`: gravar `{ v, por, em }` por cima do `true` faz a checagem
  // `=== true` dar falso — e a IA volta a responder por cima do atendente.
  const RESERVADAS = [
    'human_active',
    'human_intervened',
    'human_intervened_at',
    'human_active_at',
    'humanActiveAt',
    'handler_active',
    'ai_handled',
    'ai_handled_at',
    'resolved_by_attr',
  ];

  it.each(RESERVADAS)('recusa "%s" na validação, e diz por quê', (chave) => {
    const { campos, erros } = validarCamposDeMemoria([
      { chave, descricao: 'sequestro da bandeira do atendimento', escopo: 'sessao' },
    ]);
    expect(campos).toHaveLength(0);
    expect(erros.join(' ')).toContain('atendimento');
  });

  it('recusa no cadastro do agente (create e update)', async () => {
    await expect(
      aiAgentService.update(ACC, 'ag-1', {
        memoryFields: [{ chave: 'human_active', descricao: 'quem está atendendo' }],
      })
    ).rejects.toThrow(/atendimento/);
    expect(prismaMock.aiAgent.update).not.toHaveBeenCalled();

    prismaMock.aiAgent.findFirst.mockResolvedValue(null);
    await expect(
      aiAgentService.create(ACC, {
        name: 'Novo',
        systemPrompt: 'Você atende.',
        memoryFields: [{ chave: 'human_active', descricao: 'quem está atendendo' }],
      } as never)
    ).rejects.toThrow(/atendimento/);
    expect(prismaMock.aiAgent.create).not.toHaveBeenCalled();
  });

  it('a leitura tolerante descarta a reservada que já estiver gravada', () => {
    // A guarda nova não roda sobre o que já está no banco: se a chave entrou
    // antes dela existir, é aqui que ela para de virar campo gravável.
    expect(
      lerCamposDeMemoria([
        { chave: 'human_active', descricao: 'gravado antes da guarda', escopo: 'sessao' },
        { chave: 'decisor', descricao: 'Quem decide.', escopo: 'memoria' },
      ])
    ).toEqual([{ chave: 'decisor', descricao: 'Quem decide.', escopo: 'memoria' }]);
  });

  it('a ferramenta não grava numa reservada nem com campo livre', async () => {
    const saida = await AVAILABLE_TOOLS.lembrar.execute(
      { campo: 'human_active', valor: 'sim' },
      {
        accountId: ACC,
        agent: agente() as never,
        contactId: 'contato-1',
        conversationId: 'conv-1',
      }
    );

    expect(saida).toContain('atendimento');
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
    expect(prismaMock.contact.update).not.toHaveBeenCalled();
  });
});
