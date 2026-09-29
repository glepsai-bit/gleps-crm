/**
 * T-039 — a agenda como habilidade do agente, vista do `run()`.
 *
 * Duas coisas: o prompt passa a dizer QUE DIA É HOJE (o agente não sabia — e
 * "amanhã" sem referência vira reunião no dia errado), e com a agenda ligada
 * as seis ferramentas entram sozinhas, sem passar pela whitelist `tools`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  aiAgent: { findFirst: vi.fn(), findMany: vi.fn() },
  account: { findUnique: vi.fn() },
  conversation: { findFirst: vi.fn() },
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

const agendaMock = vi.hoisted(() => ({
  catalogoDoAgente: vi.fn(),
  consultarHorarios: vi.fn(),
  reservar: vi.fn(),
  agendar: vi.fn(),
  minhaReuniao: vi.fn(),
  remarcar: vi.fn(),
  cancelar: vi.fn(),
}));
vi.mock('./agenda.service', () => ({ agendaService: agendaMock }));

import { aiAgentService } from './ai-agent.service';

const ACC = 'acc-1';

const agente = (over: Record<string, unknown> = {}) => ({
  id: 'ag-1',
  accountId: ACC,
  name: 'Bia',
  description: null,
  role: 'responder',
  systemPrompt: 'Você é a Bia.',
  provider: 'openai',
  model: null,
  temperature: 0.7,
  maxTokens: 1024,
  historyLimit: 0,
  knowledgeBaseId: null,
  tools: [],
  outputSchema: null,
  subAgentIds: null,
  httpTools: null,
  memoryFields: [],
  agenda: null,
  active: true,
  knowledgeBase: null,
  ...over,
});

const respostaChat = (over: Record<string, unknown> = {}) => ({
  text: 'ok',
  toolCalls: [],
  model: 'gpt-4o-mini',
  provider: 'openai',
  usage: { inputTokens: 10, outputTokens: 5, usdEstimate: 0.0001, priced: true },
  finishReason: 'stop',
  ...over,
});

const catalogo = () => ({
  timezone: 'America/Sao_Paulo',
  configuracao: { antecedenciaMinimaMinutos: 120, janelaMaximaDias: 30, passoMinutos: 30, holdMinutos: 5, etapaAoAgendar: null },
  profissionais: [{ userId: 'u-marina', nome: 'Dra. Marina', horarios: {}, intervaloMinutos: 0, google: { conectado: true, email: null, podeEscrever: true, precisaReconectar: false, motivo: null } }],
  servicos: [{ id: 'p-botox', nome: 'Botox', duracaoMinutos: 30 }],
});

const AGENDA_LIGADA = { ativo: true, profissionalIds: ['u-marina'], produtoIds: ['p-botox'] };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.aiAgent.findFirst.mockResolvedValue(agente());
  prismaMock.aiAgent.findMany.mockResolvedValue([]);
  prismaMock.account.findUnique.mockResolvedValue({ timezone: 'America/Sao_Paulo' });
  agendaMock.catalogoDoAgente.mockResolvedValue(catalogo());
  chatMock.mockResolvedValue(respostaChat());
});

const toolsEnviadas = (n = 0) => (chatMock.mock.calls[n][0].tools ?? []) as { name: string }[];
const systemEnviado = (n = 0) => chatMock.mock.calls[n][0].system as string;

describe('que dia é hoje', () => {
  it('o prompt ganha o bloco AGORA no fuso da conta, sempre', async () => {
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });
    const system = systemEnviado();
    expect(system).toMatch(/AGORA\n\nHoje é [a-zç-]+-feira|AGORA\n\nHoje é (sábado|domingo)/);
    expect(system).toContain('(America/Sao_Paulo)');
    expect(system).toContain('Nunca invente data');
  });

  it('conta sem fuso gravado cai em São Paulo', async () => {
    prismaMock.account.findUnique.mockResolvedValue(null);
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });
    expect(systemEnviado()).toContain('(America/Sao_Paulo)');
  });
});

describe('a agenda como habilidade', () => {
  it('desligada: nenhuma ferramenta de agenda, e o catálogo nem é consultado', async () => {
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });
    expect(toolsEnviadas().map((t) => t.name)).toEqual(['lembrar']);
    expect(agendaMock.catalogoDoAgente).not.toHaveBeenCalled();
  });

  it('ligada: as seis entram sozinhas, sem passar pela whitelist tools', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ agenda: AGENDA_LIGADA }));
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'quero marcar botox' });
    expect(toolsEnviadas().map((t) => t.name)).toEqual([
      'lembrar',
      'consultar_horarios',
      'reservar',
      'agendar',
      'minha_reuniao',
      'remarcar',
      'cancelar',
    ]);
    expect(agendaMock.catalogoDoAgente).toHaveBeenCalledWith(ACC, AGENDA_LIGADA);
  });

  it('o modelo chama agendar: o efeito volta no resultado, com o shadow do run', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ agenda: AGENDA_LIGADA }));
    agendaMock.agendar.mockResolvedValue({
      ok: true,
      reuniao: { eventoId: 'ev-1', rotulo: 'quinta-feira, 01/10 às 14:00', profissional: 'Dra. Marina', servico: 'Botox', etapa: null },
      avisos: [],
    });
    chatMock
      .mockResolvedValueOnce(respostaChat({ text: '', toolCalls: [{ id: 't1', name: 'agendar', arguments: { id: 'h1' } }] }))
      .mockResolvedValueOnce(respostaChat({ text: 'Fechado, quinta às 14h!' }));

    const r = await aiAgentService.run({
      accountId: ACC,
      agentId: 'ag-1',
      userMessage: 'sim, confirmo',
      contactId: 'c-1',
      conversationId: 'conv-1',
      shadow: true,
    });

    expect(agendaMock.agendar.mock.calls[0][0]).toMatchObject({ ref: 'h1', contactId: 'c-1', conversationId: 'conv-1', shadow: true });
    expect(r.efeitos.agendou).toMatchObject({ eventoId: 'ev-1' });
    expect(r.text).toBe('Fechado, quinta às 14h!');
    // O modelo recebeu a frase da ferramenta na segunda rodada.
    const mensagens = chatMock.mock.calls[1][0].messages as { role: string; content: string }[];
    expect(mensagens.find((m) => m.role === 'tool')?.content).toContain('Marcado: quinta-feira, 01/10 às 14:00');
  });

  it('a ferramenta lançou: o modelo recebe uma frase, não um stack — e não há efeito', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ agenda: AGENDA_LIGADA }));
    agendaMock.agendar.mockRejectedValue(new Error('Google Calendar indisponível agora'));
    chatMock
      .mockResolvedValueOnce(respostaChat({ text: '', toolCalls: [{ id: 't1', name: 'agendar', arguments: { id: 'h1' } }] }))
      .mockResolvedValueOnce(respostaChat({ text: 'Um instante.' }));

    const r = await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'sim' });
    expect(r.efeitos.agendou).toBeUndefined();
    const mensagens = chatMock.mock.calls[1][0].messages as { role: string; content: string }[];
    expect(mensagens.find((m) => m.role === 'tool')?.content).toMatch(/Não consegui agora .*Não diga ao lead que está feito/);
  });

  it('o catálogo falhou ao montar: o agente segue sem agenda, em vez de derrubar o atendimento', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ agenda: AGENDA_LIGADA }));
    agendaMock.catalogoDoAgente.mockRejectedValue(new Error('banco'));
    const r = await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });
    expect(r.text).toBe('ok');
    expect(toolsEnviadas().map((t) => t.name)).toEqual(['lembrar']);
  });
});

describe('gravar a habilidade', () => {
  it('update valida a agenda antes de gravar', async () => {
    await expect(
      aiAgentService.update(ACC, 'ag-1', { agenda: { ativo: true, profissionalIds: [], produtoIds: ['p'] } })
    ).rejects.toThrow(/ao menos um profissional/);
  });
});
