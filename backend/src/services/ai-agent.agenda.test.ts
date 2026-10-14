/**
 * T-039 — a agenda como habilidade do agente, vista do `run()`.
 *
 * Duas coisas: o prompt passa a dizer QUE DIA É HOJE (o agente não sabia — e
 * "amanhã" sem referência vira reunião no dia errado), e com a agenda ligada
 * as seis ferramentas entram sozinhas, sem passar pela whitelist `tools`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  aiAgent: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  account: { findUnique: vi.fn() },
  conversation: { findFirst: vi.fn() },
  message: { findMany: vi.fn(), count: vi.fn() },
}));
const exigirModeloMock = vi.hoisted(() => vi.fn());
vi.mock('./ai/modelos', () => ({ exigirModeloValido: exigirModeloMock }));
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
  reservaPendente: vi.fn(),
}));
vi.mock('./agenda.service', () => ({ agendaService: agendaMock }));

import { aiAgentService, TETO_DE_FERRAMENTAS, PRAZO_DO_TURNO_MS } from './ai-agent.service';

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
  raciocinio: null,
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
  prismaMock.aiAgent.update.mockImplementation(async (q: { data: Record<string, unknown> }) => ({ ...agente(), ...q.data }));
  prismaMock.account.findUnique.mockResolvedValue({ timezone: 'America/Sao_Paulo' });
  agendaMock.catalogoDoAgente.mockResolvedValue(catalogo());
  agendaMock.reservaPendente.mockResolvedValue(null);
  exigirModeloMock.mockResolvedValue({ ok: true, model: 'x', verificado: true });
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

/*
  ETAPA G — A RESERVA PENDENTE ENTRA NO PROMPT A CADA MENSAGEM.

  O modelo reservava num turno e no seguinte não lembrava o que tinha
  reservado. Agora o bloco AGORA diz: "reserva pendente: terça às 15h — se o
  lead confirmar, chame agendar (sem id)".
*/
describe('a reserva pendente no bloco AGORA', () => {
  const pendente = (over: Record<string, unknown> = {}) => ({
    reservaId: 'res-1',
    horarioId: 'h1',
    inicio: new Date('2026-10-14T18:00:00Z'),
    fim: new Date('2026-10-14T18:30:00Z'),
    rotulo: 'terça-feira, 14/10 às 15:00',
    profissional: 'Dr. Carlos',
    servico: 'Consulta clínica',
    expiraEm: new Date('2026-10-14T13:42:00Z'), // 10:42 em São Paulo
    vencida: false,
    ...over,
  });

  it('viva: o prompt diz o horário, até quando segura e manda chamar agendar sem id', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ agenda: AGENDA_LIGADA }));
    agendaMock.reservaPendente.mockResolvedValue(pendente());
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'sim', conversationId: 'conv-1' });
    const system = systemEnviado();
    expect(system).toContain('AGORA\n\nHoje é');
    expect(system).toContain('RESERVA PENDENTE nesta conversa: terça-feira, 14/10 às 15:00 com Dr. Carlos (Consulta clínica), segura até às 10:42.');
    expect(system).toContain('chame agendar (sem id)');
    expect(agendaMock.reservaPendente).toHaveBeenCalledWith({ accountId: ACC, conversationId: 'conv-1', chaveDeSombra: null, shadow: false });
  });

  it('vencida: o prompt diz que venceu e que ainda vale tentar', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ agenda: AGENDA_LIGADA }));
    agendaMock.reservaPendente.mockResolvedValue(pendente({ vencida: true }));
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'sim', conversationId: 'conv-1' });
    expect(systemEnviado()).toContain('havia uma reserva de terça-feira, 14/10 às 15:00 com Dr. Carlos (Consulta clínica) que venceu às 10:42');
    expect(systemEnviado()).toContain('chame agendar mesmo assim (sem id)');
  });

  it('sem conversa nem chave de sombra, nem consulta; em sombra a chave vai junto', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ agenda: AGENDA_LIGADA }));
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });
    expect(agendaMock.reservaPendente).not.toHaveBeenCalled();
    expect(systemEnviado()).not.toContain('RESERVA PENDENTE');

    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi', shadow: true, chaveDeSombra: 'sim:c1' });
    expect(agendaMock.reservaPendente).toHaveBeenCalledWith({ accountId: ACC, conversationId: null, chaveDeSombra: 'sim:c1', shadow: true });
  });

  it('a leitura falhou: o atendimento segue sem o bloco', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ agenda: AGENDA_LIGADA }));
    agendaMock.reservaPendente.mockRejectedValue(new Error('banco'));
    const r = await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'sim', conversationId: 'conv-1' });
    expect(r.text).toBe('ok');
  });
});

/*
  ETAPA G — TETO DE FERRAMENTAS: 8 CONTADAS, NÃO 3 RODADAS.

  Um agendamento normal gasta consultar + reservar + lembrar + agendar; com 3
  rodadas o piloto respondia sem marcar. `lembrar` e consultas com parâmetros
  novos não contam. No teto, o modelo recebe o aviso e responde SEM
  ferramentas — antes devolvia outra chamada e o lead recebia texto vazio.
*/
describe('teto de ferramentas', () => {
  const chamada = (name: string, args: Record<string, unknown> = {}) =>
    respostaChat({ text: '', toolCalls: [{ id: `t-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }] });

  beforeEach(() => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ agenda: AGENDA_LIGADA }));
  });

  it('a ferramenta falha 8 vezes, o modelo tenta de novo 8 vezes; na nona recebe o aviso e responde sem ferramentas', async () => {
    agendaMock.agendar.mockResolvedValue({ ok: false, motivo: 'esse horário acabou de ser ocupado' });
    chatMock.mockImplementation(async (req: { toolChoice?: string }) =>
      req.toolChoice === 'none' ? respostaChat({ text: 'Esse horário foi ocupado — te passo outro.' }) : chamada('agendar', { id: 'h1' })
    );

    const r = await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'sim', conversationId: 'conv-1' });

    expect(TETO_DE_FERRAMENTAS).toBe(8);
    expect(agendaMock.agendar).toHaveBeenCalledTimes(8);
    expect(r.toolCalls).toHaveLength(8);
    expect(r.execucoesDeFerramentas).toHaveLength(8);
    expect(r.execucoesDeFerramentas[0]).toMatchObject({ nome: 'agendar', argumentos: { id: 'h1' }, resultado: expect.stringContaining('NÃO marquei: esse horário acabou de ser ocupado') });
    expect(r.text).toBe('Esse horário foi ocupado — te passo outro.');
    // 1 inicial + 8 depois de cada rodada + 1 final sem ferramentas.
    expect(chatMock).toHaveBeenCalledTimes(10);
    const ultima = chatMock.mock.calls.at(-1)![0] as { toolChoice?: string; tools?: unknown[]; messages: { role: string; content: string }[] };
    expect(ultima.toolChoice).toBe('none');
    expect(ultima.tools?.length).toBeGreaterThan(0); // as definições continuam (a Anthropic exige)
    expect(ultima.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('Limite de ferramentas desta mensagem atingido') });
  });

  it('lembrar não conta no teto', async () => {
    let n = 0;
    chatMock.mockImplementation(async () => (n++ < 10 ? chamada('lembrar', { campo: 'nome', valor: 'Ana' }) : respostaChat({ text: 'Prazer, Ana!' })));
    const r = await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'sou a Ana' });
    expect(r.text).toBe('Prazer, Ana!');
    expect(r.toolCalls).toHaveLength(10);
    const avisos = chatMock.mock.calls.flatMap((c) => (c[0] as { messages: { content: string }[] }).messages).filter((m) => m.content?.includes('Limite de ferramentas'));
    expect(avisos).toHaveLength(0);
  });

  it('consultar_horarios com parâmetros NOVOS não conta; a mesma consulta repetida conta', async () => {
    agendaMock.consultarHorarios.mockResolvedValue({ horarios: [], avisos: [] });
    const sequencia = [
      chamada('consultar_horarios', { servico: 'Botox', periodo: 'manha' }),
      chamada('consultar_horarios', { servico: 'Botox', periodo: 'tarde' }),
      ...Array.from({ length: 9 }, () => chamada('consultar_horarios', { periodo: 'tarde', servico: 'Botox' })),
    ];
    let n = 0;
    chatMock.mockImplementation(async (req: { toolChoice?: string }) =>
      req.toolChoice === 'none' ? respostaChat({ text: 'Não achei horário à tarde.' }) : sequencia[n++]
    );
    const r = await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'de tarde' });
    // 2 novas (não contam) + 8 repetidas (contam) = 10 executadas; a 11ª bate no teto.
    expect(agendaMock.consultarHorarios).toHaveBeenCalledTimes(10);
    expect(r.text).toBe('Não achei horário à tarde.');
  });
});

/*
  ETAPA G (revisão) — ESPECIALISTA EM SOMBRA.

  O coordenador em sombra consultava o especialista com shadow=false e sem a
  chave do calendário fingido: a reserva/agenda do especialista saía DE VERDADE
  no meio da simulação.
*/
describe('especialista consultado em sombra', () => {
  const consulta = () =>
    respostaChat({ text: '', toolCalls: [{ id: 'c1', name: 'consultar_especialista', arguments: { especialista: 'Agenda', pergunta: 'reserve o horário h1' } }] });

  beforeEach(() => {
    prismaMock.aiAgent.findFirst
      .mockResolvedValueOnce(agente({ id: 'coord-1', name: 'Coord', subAgentIds: ['esp-1'] }))
      .mockResolvedValueOnce(agente({ id: 'esp-1', name: 'Agenda', agenda: AGENDA_LIGADA }));
    prismaMock.aiAgent.findMany.mockResolvedValue([{ id: 'esp-1', name: 'Agenda', description: 'marca horários' }]);
    agendaMock.reservar.mockResolvedValue({ ok: true, reservaId: 'sim:h1', rotulo: 'quinta-feira, 01/10 às 14:00', profissional: 'Dra. Marina', servico: 'Botox', expiraEm: new Date(Date.now() + 5 * 60_000), simulado: true });
    chatMock
      .mockResolvedValueOnce(consulta()) // coordenador
      .mockResolvedValueOnce(respostaChat({ text: '', toolCalls: [{ id: 'e1', name: 'reservar', arguments: { horario_id: 'h1' } }] })) // especialista pede reservar
      .mockResolvedValueOnce(respostaChat({ text: 'Reservado.' })) // especialista, final
      .mockResolvedValueOnce(respostaChat({ text: 'Reservei pra você!' })); // coordenador, final
  });

  it('em sombra, o especialista herda shadow e a chave do calendário: a reserva dele é de mentira', async () => {
    await aiAgentService.run({ accountId: ACC, agentId: 'coord-1', userMessage: 'quero às 14h', conversationId: 'conv-1', shadow: true, chaveDeSombra: 'sim:conv-1' });
    expect(agendaMock.reservar).toHaveBeenCalledTimes(1);
    expect(agendaMock.reservar.mock.calls[0][0]).toMatchObject({ shadow: true, chaveDeSombra: 'sim:conv-1', conversationId: 'conv-1' });
  });

  it('fora da sombra continua real (shadow false, sem chave)', async () => {
    await aiAgentService.run({ accountId: ACC, agentId: 'coord-1', userMessage: 'quero às 14h', conversationId: 'conv-1' });
    expect(agendaMock.reservar.mock.calls[0][0]).toMatchObject({ shadow: false, chaveDeSombra: null });
  });
});

/*
  ETAPA G (revisão) — PRAZO DO TURNO.

  O nó do fluxo desiste aos 120 s mas não cancela: o turno órfão enviava e
  agendava depois de o run ser marcado como falho. Aos 100 s `run` não inicia
  ferramenta nem rodada com ferramentas — a rodada final vai sem ferramentas.
  Relógio controlado: só `Date` é falsificado, e o avanço acontece DENTRO do
  mock (a ferramenta ou o modelo "demora" 101 s).
*/
describe('prazo do turno', () => {
  const T0 = new Date('2026-10-14T15:00:00Z');
  const andar = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const reuniao = { eventoId: 'ev-1', rotulo: 'quinta-feira, 01/10 às 14:00', profissional: 'Dra. Marina', servico: 'Botox', etapa: null };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ agenda: AGENDA_LIGADA }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('o prazo é de 100 s', () => {
    expect(PRAZO_DO_TURNO_MS).toBe(100_000);
  });

  it('acabou no MEIO da rodada (ferramenta lenta): a que faltava não começa, e a rodada final vai sem ferramentas', async () => {
    agendaMock.reservar.mockImplementation(async () => {
      andar(101_000);
      return { ok: true, reservaId: 'r1', rotulo: 'quinta-feira, 01/10 às 14:00', profissional: 'Dra. Marina', servico: 'Botox', expiraEm: new Date(Date.now() + 5 * 60_000) };
    });
    chatMock
      .mockResolvedValueOnce(
        respostaChat({
          text: '',
          toolCalls: [
            { id: 't1', name: 'reservar', arguments: { horario_id: 'h1' } },
            { id: 't2', name: 'agendar', arguments: { id: 'h1' } },
          ],
        })
      )
      .mockResolvedValueOnce(respostaChat({ text: 'Reservei — me confirma?' }));

    const r = await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'quero', conversationId: 'conv-1' });

    expect(agendaMock.reservar).toHaveBeenCalledTimes(1);
    expect(agendaMock.agendar).not.toHaveBeenCalled(); // não iniciou ferramenta nova depois do prazo
    expect(r.toolCalls.map((t) => t.name)).toEqual(['reservar']);
    expect(r.execucoesDeFerramentas).toHaveLength(1);
    expect(r.text).toBe('Reservei — me confirma?');
    expect(chatMock).toHaveBeenCalledTimes(2);
    const final = chatMock.mock.calls[1][0] as { toolChoice?: string; messages: { role: string; content: string }[] };
    expect(final.toolChoice).toBe('none');
    const resultados = final.messages.filter((m) => m.role === 'tool');
    expect(resultados).toHaveLength(2); // toda chamada tem o seu resultado (a API exige)
    expect(resultados[1].content).toContain('O tempo desta mensagem acabou');
  });

  it('acabou DURANTE o modelo: a rodada seguinte não executa a ferramenta pedida — vai direto à resposta final', async () => {
    chatMock.mockImplementation(async (req: { toolChoice?: string }) => {
      if (req.toolChoice === 'none') return respostaChat({ text: 'Confirmo na próxima mensagem.' });
      andar(101_000); // o modelo demorou
      return respostaChat({ text: '', toolCalls: [{ id: 't1', name: 'agendar', arguments: { id: 'h1' } }] });
    });

    const r = await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'sim', conversationId: 'conv-1' });

    expect(agendaMock.agendar).not.toHaveBeenCalled();
    expect(r.toolCalls).toHaveLength(0);
    expect(r.efeitos.agendou).toBeUndefined();
    expect(r.text).toBe('Confirmo na próxima mensagem.');
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(chatMock.mock.calls[1][0].toolChoice).toBe('none');
  });

  it('dentro do prazo nada muda: a ferramenta roda e a rodada seguinte ainda pode usar ferramentas', async () => {
    agendaMock.agendar.mockResolvedValue({ ok: true, reuniao, avisos: [] });
    chatMock
      .mockResolvedValueOnce(respostaChat({ text: '', toolCalls: [{ id: 't1', name: 'agendar', arguments: { id: 'h1' } }] }))
      .mockResolvedValueOnce(respostaChat({ text: 'Fechado!' }));
    const r = await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'sim', conversationId: 'conv-1' });
    expect(agendaMock.agendar).toHaveBeenCalledTimes(1);
    expect(r.text).toBe('Fechado!');
    expect(chatMock.mock.calls[1][0].toolChoice).toBeUndefined();
  });

  it('o prazo é do TURNO: o especialista consultado herda o do coordenador', async () => {
    prismaMock.aiAgent.findFirst.mockReset();
    prismaMock.aiAgent.findFirst
      .mockResolvedValueOnce(agente({ id: 'coord-1', name: 'Coord', subAgentIds: ['esp-1'] }))
      .mockResolvedValueOnce(agente({ id: 'esp-1', name: 'Agenda', agenda: AGENDA_LIGADA }));
    prismaMock.aiAgent.findMany.mockResolvedValue([{ id: 'esp-1', name: 'Agenda', description: 'marca horários' }]);
    chatMock
      .mockResolvedValueOnce(respostaChat({ text: '', toolCalls: [{ id: 'c1', name: 'consultar_especialista', arguments: { especialista: 'Agenda', pergunta: 'marque o h1' } }] }))
      // O especialista demora 101 s e pede para agendar: com o prazo do coordenador, não começa.
      .mockImplementationOnce(async () => {
        andar(101_000);
        return respostaChat({ text: '', toolCalls: [{ id: 'e1', name: 'agendar', arguments: { id: 'h1' } }] });
      })
      .mockResolvedValueOnce(respostaChat({ text: 'Não consegui marcar agora.' })) // especialista, final
      .mockResolvedValueOnce(respostaChat({ text: 'Já te confirmo.' })); // coordenador, final

    const r = await aiAgentService.run({ accountId: ACC, agentId: 'coord-1', userMessage: 'marque', conversationId: 'conv-1' });

    expect(agendaMock.agendar).not.toHaveBeenCalled();
    expect(chatMock.mock.calls[2][0].toolChoice).toBe('none'); // o especialista fechou sem ferramentas
    expect(chatMock.mock.calls[3][0].toolChoice).toBe('none'); // e o coordenador também
    expect(r.text).toBe('Já te confirmo.');
  });
});

/*
  ETAPA G — RACIOCÍNIO E MODELO.
*/
describe('raciocínio e validação do modelo', () => {
  it('o esforço de raciocínio do agente vai na chamada; sem ele vai null', async () => {
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ model: 'gpt-5-mini', raciocinio: 'low' }));
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });
    expect(chatMock.mock.calls[0][0]).toMatchObject({ model: 'gpt-5-mini', reasoningEffort: 'low' });

    prismaMock.aiAgent.findFirst.mockResolvedValue(agente());
    await aiAgentService.run({ accountId: ACC, agentId: 'ag-1', userMessage: 'oi' });
    expect(chatMock.mock.calls[1][0].reasoningEffort).toBeNull();
  });

  it('update: raciocinio fora da lista é recusado; válido ou null é gravado', async () => {
    await expect(aiAgentService.update(ACC, 'ag-1', { raciocinio: 'turbo' as 'low' })).rejects.toThrow(/raciocinio precisa ser um de: minimal, low, medium, high/);
    await aiAgentService.update(ACC, 'ag-1', { raciocinio: 'high' });
    expect(prismaMock.aiAgent.update.mock.calls[0][0].data).toEqual({ raciocinio: 'high' });
    await aiAgentService.update(ACC, 'ag-1', { raciocinio: null });
    expect(prismaMock.aiAgent.update.mock.calls[1][0].data).toEqual({ raciocinio: null });
  });

  it('update: o modelo é conferido no provider quando MUDA, e recusado com 400 quando não existe', async () => {
    await aiAgentService.update(ACC, 'ag-1', { model: 'gpt-5-mini' });
    expect(exigirModeloMock).toHaveBeenCalledWith({ accountId: ACC, provider: 'openai', model: 'gpt-5-mini' });

    // Mesmo modelo de antes: não confere de novo.
    prismaMock.aiAgent.findFirst.mockResolvedValue(agente({ model: 'gpt-5-mini' }));
    await aiAgentService.update(ACC, 'ag-1', { model: 'gpt-5-mini', systemPrompt: 'novo' });
    expect(exigirModeloMock).toHaveBeenCalledTimes(1);

    exigirModeloMock.mockRejectedValue(new Error('Modelo "gpt-9" não existe ou a chave não tem acesso'));
    await expect(aiAgentService.update(ACC, 'ag-1', { model: 'gpt-9' })).rejects.toThrow(/não existe ou a chave não tem acesso/);
    expect(prismaMock.aiAgent.update).toHaveBeenCalledTimes(2);
  });
});
