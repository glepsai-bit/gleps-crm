/**
 * T-032 — orientação da base de conhecimento.
 *
 * O agente recebia 6 trechos escolhidos por cosseno, ou nada. Nunca sabia O QUE
 * a base cobre, então não distinguia "isso não existe" de "busquei com as
 * palavras erradas" — e dizia que ia confirmar sobre coisa que estava lá.
 *
 * Pior: a instrução anti-invenção morava DENTRO do bloco de trechos, que não
 * era montado quando a busca voltava vazia. A trava existia exatamente quando
 * era menos necessária e sumia quando era mais. Estes testes travam as duas
 * coisas no lugar.
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

const searchMock = vi.hoisted(() => vi.fn());
const overviewMock = vi.hoisted(() => vi.fn());
vi.mock('./ai/knowledge-index', async () => {
  // Os formatadores REAIS: é o texto que eles produzem que está sob teste.
  const real = await vi.importActual<typeof import('./ai/knowledge-index')>(
    './ai/knowledge-index'
  );
  return { ...real, search: searchMock, loadOverview: overviewMock };
});

const chatMock = vi.hoisted(() => vi.fn());
vi.mock('./ai/chat', () => ({ chat: chatMock }));

import { aiAgentService } from './ai-agent.service';

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
  historyLimit: 0,
  knowledgeBaseId: 'base-1',
  tools: [],
  outputSchema: null,
  subAgentIds: null,
  active: true,
  knowledgeBase: null,
  ...over,
});

const overview = (over: Record<string, unknown> = {}) => ({
  businessContext: null,
  docs: [],
  ...over,
});

const trecho = (over: Record<string, unknown> = {}) => ({
  chunkId: 'c1',
  docId: 'd1',
  docTitle: 'Tabela de preços',
  content: 'O plano Pro custa R$ 297 por mês.',
  score: 0.71,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.aiAgent.findFirst.mockResolvedValue(agente());
  prismaMock.aiAgent.findMany.mockResolvedValue([]);
  prismaMock.message.count.mockResolvedValue(0);
  prismaMock.message.findMany.mockResolvedValue([]);
  searchMock.mockResolvedValue([]);
  overviewMock.mockResolvedValue(overview());
  chatMock.mockResolvedValue({
    text: 'ok',
    toolCalls: [],
    model: 'gpt-4o-mini',
    provider: 'openai',
    usage: { inputTokens: 10, outputTokens: 5, usdEstimate: 0.0001, priced: true },
    finishReason: 'stop',
  });
});

const rodar = (over: Record<string, unknown> = {}) =>
  aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'quanto custa?', ...over });

const system = () => chatMock.mock.calls[0][0].system as string;

describe('nível 1 — a trava anti-invenção não depende da busca dar certo', () => {
  it('busca vazia AINDA instrui a não inventar — era o furo', async () => {
    searchMock.mockResolvedValue([]);
    await rodar();

    const s = system();
    expect(s).toContain('nenhum trecho relevante');
    expect(s).toContain('nunca invente preço, prazo ou política');
  });

  it('busca vazia avisa que pode ser a pergunta, não a ausência do dado', async () => {
    await rodar();
    // Sem isto o agente conclui "não existe" e encerra o assunto.
    expect(system()).toContain('não quer dizer que a informação não exista');
  });

  it('busca que FALHOU diz outra coisa: indisponível, não inexistente', async () => {
    searchMock.mockRejectedValue(new Error('cota estourada'));
    await rodar();

    const s = system();
    expect(s).toContain('indisponível nesta mensagem');
    expect(s).toContain('NÃO afirme preço');
    // Não pode dizer que não achou: seria mentira, nem chegou a procurar.
    expect(s).not.toContain('nenhum trecho relevante');
  });

  it('com trechos, o bloco normal volta com a instrução de sempre', async () => {
    searchMock.mockResolvedValue([trecho()]);
    await rodar();

    const s = system();
    expect(s).toContain('R$ 297');
    expect(s).toContain('diga que vai verificar em vez de inventar');
    expect(s).not.toContain('nenhum trecho relevante');
  });

  it('agente SEM base não recebe bloco nenhum — não há base para consultar', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ knowledgeBaseId: null }));
    await rodar();

    const s = system();
    expect(s).not.toContain('BASE DE CONHECIMENTO');
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe('nível 2 — o índice da base', () => {
  const comIndice = () =>
    overviewMock.mockResolvedValue(
      overview({
        docs: [
          { title: 'Tabela de preços', summary: 'preços dos 3 planos e regras de desconto' },
          { title: 'Cancelamento', summary: 'prazos e multa por rescisão' },
        ],
      })
    );

  it('lista o que a base cobre, mesmo quando a busca não trouxe nada', async () => {
    comIndice();
    searchMock.mockResolvedValue([]);
    await rodar();

    const s = system();
    expect(s).toContain('O QUE A BASE DE CONHECIMENTO COBRE');
    expect(s).toContain('Tabela de preços: preços dos 3 planos');
    expect(s).toContain('Cancelamento: prazos e multa');
  });

  it('manda usar a ferramenta de busca antes de desistir', async () => {
    comIndice();
    await rodar();
    // É o que transforma busca cega em dirigida.
    expect(system()).toContain('use a ferramenta de busca com outras palavras');
  });

  it('o índice vem ANTES dos trechos — a instrução do bloco seguinte cita ele', async () => {
    comIndice();
    searchMock.mockResolvedValue([trecho()]);
    await rodar();

    const s = system();
    expect(s.indexOf('O QUE A BASE DE CONHECIMENTO COBRE')).toBeLessThan(
      s.indexOf('trechos relevantes para esta mensagem')
    );
  });

  it('documento sem resumo entra só pelo título, não some do índice', async () => {
    overviewMock.mockResolvedValue(
      overview({ docs: [{ title: 'Contrato padrão', summary: null }] })
    );
    await rodar();

    const s = system();
    expect(s).toContain('- Contrato padrão');
    expect(s).not.toContain('Contrato padrão:');
  });

  it('base sem documento pronto não gera bloco de índice vazio', async () => {
    overviewMock.mockResolvedValue(overview({ docs: [] }));
    await rodar();
    expect(system()).not.toContain('O QUE A BASE DE CONHECIMENTO COBRE');
  });
});

describe('nível 3 — sobre o negócio', () => {
  it('entra no prompt mesmo sem nenhum trecho recuperado', async () => {
    overviewMock.mockResolvedValue(
      overview({ businessContext: 'A Gleps vende CRM para clínicas de estética.' })
    );
    searchMock.mockResolvedValue([]);
    await rodar();

    const s = system();
    expect(s).toContain('SOBRE O NEGÓCIO');
    expect(s).toContain('clínicas de estética');
  });

  it('vem depois do prompt do agente e da memória — do específico ao genérico', async () => {
    overviewMock.mockResolvedValue(overview({ businessContext: 'A Gleps vende CRM.' }));
    await rodar({ memory: { faturamento: 'R$ 80 mil' } });

    const s = system();
    expect(s.indexOf('Você é o Marcus.')).toBeLessThan(s.indexOf('SOBRE ESTA PESSOA'));
    expect(s.indexOf('SOBRE ESTA PESSOA')).toBeLessThan(s.indexOf('SOBRE O NEGÓCIO'));
  });

  it('base sem contexto preenchido não gera cabeçalho solto', async () => {
    overviewMock.mockResolvedValue(overview({ businessContext: null }));
    await rodar();
    expect(system()).not.toContain('SOBRE O NEGÓCIO');
  });
});
