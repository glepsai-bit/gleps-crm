/**
 * T-030 — arquitetura multi-agente.
 *
 * Duas peças novas, e as duas são fáceis de quebrar em silêncio:
 *  - a MEMÓRIA (o que já se sabe do lead) precisa chegar no prompt, senão cada
 *    agente recomeça do zero a cada mensagem;
 *  - a DELEGAÇÃO precisa parar num nível, senão dois agentes que se consultam
 *    entram em laço queimando token.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  aiAgent: { findFirst: vi.fn(), findMany: vi.fn() },
  conversation: { findFirst: vi.fn() },
  message: { findMany: vi.fn() },
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

import { aiAgentService } from './ai-agent.service';

const ACC = 'acc-1';

const agente = (over: Record<string, unknown> = {}) => ({
  id: 'coord-1',
  accountId: ACC,
  name: 'Marcus',
  description: 'SDR',
  role: 'responder',
  systemPrompt: 'Você é o Marcus.',
  provider: 'openai',
  model: null,
  temperature: 0.7,
  maxTokens: 1024,
  historyLimit: 0,
  knowledgeBaseId: null,
  tools: [],
  outputSchema: null,
  subAgentIds: null,
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

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.aiAgent.findFirst.mockResolvedValue(agente());
  prismaMock.aiAgent.findMany.mockResolvedValue([]);
  chatMock.mockResolvedValue(respostaChat());
});

const systemEnviado = (n = 0) => chatMock.mock.calls[n][0].system as string;
const toolsEnviadas = (n = 0) =>
  (chatMock.mock.calls[n][0].tools ?? []) as {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }[];

describe('memória entre mensagens', () => {
  it('o que já se sabe do lead entra no prompt', async () => {
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'coord-1',
      userMessage: 'quanto custa?',
      memory: { faturamento: 'R$ 80 mil/mês', segmento: 'clínica' },
    });

    const system = systemEnviado();
    expect(system).toContain('JÁ SABEMOS');
    expect(system).toContain('R$ 80 mil/mês');
    expect(system).toContain('clínica');
    // A instrução importa tanto quanto o dado: sem ela o agente repergunta.
    expect(system).toContain('Não pergunte de novo');
  });

  it('campo vazio não vira "não informado" no prompt', async () => {
    await aiAgentService.run({
      accountId: ACC,
      agentId: 'coord-1',
      userMessage: 'oi',
      memory: { faturamento: 'R$ 80 mil', email: '', telefone: null, obs: '   ' },
    });

    const system = systemEnviado();
    expect(system).toContain('faturamento');
    // Dizer "email: (vazio)" faz o agente tratar a ausência como fato apurado.
    expect(system).not.toContain('email');
    expect(system).not.toContain('telefone');
  });

  it('sem memória, o prompt não ganha bloco nenhum', async () => {
    await aiAgentService.run({ accountId: ACC, agentId: 'coord-1', userMessage: 'oi' });
    expect(systemEnviado()).not.toContain('JÁ SABEMOS');
  });
});

describe('delegação entre agentes', () => {
  it('coordenador com especialistas ganha a ferramenta de consulta', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ subAgentIds: ['esp-1', 'esp-2'] }));
    prismaMock.aiAgent.findMany.mockResolvedValue([
      { id: 'esp-1', name: 'Especialista Fiscal', description: 'tributos' },
      { id: 'esp-2', name: 'Especialista Técnico', description: 'integrações' },
    ]);

    await aiAgentService.run({ accountId: ACC, agentId: 'coord-1', userMessage: 'oi' });

    const consulta = toolsEnviadas().find((t) => t.name === 'consultar_especialista');
    expect(consulta).toBeDefined();
    // O enum é o que impede o modelo de inventar um especialista que não existe.
    const props = consulta!.parameters.properties as Record<string, { enum?: string[] }>;
    expect(props.especialista.enum).toEqual(['Especialista Fiscal', 'Especialista Técnico']);
    // A descrição carrega o "quando usar cada um".
    expect(consulta!.description).toContain('tributos');
  });

  it('sem especialistas, a ferramenta não aparece', async () => {
    await aiAgentService.run({ accountId: ACC, agentId: 'coord-1', userMessage: 'oi' });
    expect(toolsEnviadas().find((t) => t.name === 'consultar_especialista')).toBeUndefined();
  });

  it('o especialista consultado NÃO pode consultar outro — trava o laço', async () => {
    // Mesmo tendo roster próprio, ele roda em depth=1 e não recebe a ferramenta.
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ subAgentIds: ['outro'] }));
    prismaMock.aiAgent.findMany.mockResolvedValue([
      { id: 'outro', name: 'Outro', description: null },
    ]);

    await aiAgentService.run({
      accountId: ACC,
      agentId: 'esp-1',
      userMessage: 'pergunta',
      depth: 1,
    });

    expect(toolsEnviadas().find((t) => t.name === 'consultar_especialista')).toBeUndefined();
    // Nem chega a buscar o roster — economiza a consulta ao banco.
    expect(prismaMock.aiAgent.findMany).not.toHaveBeenCalled();
  });

  it('a resposta do especialista volta para o coordenador continuar', async () => {
    prismaMock.aiAgent.findFirst
      .mockResolvedValueOnce(agente({ subAgentIds: ['esp-1'] })) // coordenador
      .mockResolvedValueOnce(agente({ id: 'esp-1', name: 'Fiscal', subAgentIds: null })); // especialista
    prismaMock.aiAgent.findMany.mockResolvedValue([
      { id: 'esp-1', name: 'Fiscal', description: 'tributos' },
    ]);

    chatMock
      // 1ª: o coordenador decide consultar
      .mockResolvedValueOnce(
        respostaChat({
          text: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'consultar_especialista',
              arguments: { especialista: 'Fiscal', pergunta: 'Incide ISS?' },
            },
          ],
        })
      )
      // 2ª: o especialista responde
      .mockResolvedValueOnce(respostaChat({ text: 'Sim, 5% de ISS.' }))
      // 3ª: o coordenador compõe a resposta final
      .mockResolvedValueOnce(respostaChat({ text: 'Tem ISS de 5%, sim.' }));

    const r = await aiAgentService.run({
      accountId: ACC,
      agentId: 'coord-1',
      userMessage: 'tem imposto?',
    });

    expect(r.text).toBe('Tem ISS de 5%, sim.');
    // A resposta do especialista chegou como resultado de ferramenta.
    const msgsFinais = chatMock.mock.calls[2][0].messages as { role: string; content: string }[];
    expect(msgsFinais.some((m) => m.role === 'tool' && m.content.includes('5% de ISS'))).toBe(true);
    // E o custo da consulta foi somado ao do coordenador.
    expect(r.usage.usdEstimate).toBeGreaterThan(0.0001);
  });

  it('especialista inexistente devolve aviso, não derruba o atendimento', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ subAgentIds: ['esp-1'] }));
    prismaMock.aiAgent.findMany.mockResolvedValue([
      { id: 'esp-1', name: 'Fiscal', description: null },
    ]);
    chatMock
      .mockResolvedValueOnce(
        respostaChat({
          toolCalls: [
            {
              id: 'c1',
              name: 'consultar_especialista',
              arguments: { especialista: 'Jurídico', pergunta: 'x' },
            },
          ],
        })
      )
      .mockResolvedValueOnce(respostaChat({ text: 'sigo sem isso' }));

    const r = await aiAgentService.run({
      accountId: ACC,
      agentId: 'coord-1',
      userMessage: 'oi',
    });

    expect(r.text).toBe('sigo sem isso');
    const msgs = chatMock.mock.calls[1][0].messages as { role: string; content: string }[];
    const aviso = msgs.find((m) => m.role === 'tool');
    expect(aviso?.content).toContain('não está disponível');
    expect(aviso?.content).toContain('Fiscal'); // lista o que existe
  });
});

describe('validação do roster', () => {
  it('recusa especialista de outra conta', async () => {
    prismaMock.aiAgent.findMany.mockResolvedValue([]); // nenhum encontrado nesta conta
    await expect(
      aiAgentService.create(ACC, {
        name: 'Coord',
        systemPrompt: 'x',
        subAgentIds: ['de-outra-conta'],
      })
    ).rejects.toThrow(/não existe nesta conta/i);
  });

  it('recusa agente que consulta a si mesmo', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente());
    prismaMock.aiAgent.findMany.mockResolvedValue([{ id: 'coord-1' }]);
    await expect(
      aiAgentService.update(ACC, 'coord-1', { subAgentIds: ['coord-1'] })
    ).rejects.toThrow(/a si mesmo/i);
  });
});
