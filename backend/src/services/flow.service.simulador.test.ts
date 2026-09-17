/**
 * T-031 — simulador de atendimento.
 *
 * O simulador só tem valor se ele mentir zero: ele existe pra o usuário ajustar
 * o prompt olhando pro comportamento REAL. Por isso o que se testa aqui é
 * fidelidade (mesmo contexto que o worker monta, memória do contato e da
 * conversa) e contenção (nada sai pro WhatsApp, nada muda no funil, o reset não
 * alcança conversa de verdade).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  flow: { findFirst: vi.fn() },
  // findUnique: a posse da conversa (qual agente é dono) é lida daí, e o
  // caminho de execução é o MESMO do worker — que relê o run pelo id.
  conversation: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  contact: { findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
  inbox: { findFirst: vi.fn(), create: vi.fn() },
  message: { create: vi.fn() },
  flowRun: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  flowRunStep: { findMany: vi.fn() },
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

const ACC = 'acc-1';

/** Turno que executou na hora (fluxo sem janela de agrupamento). */
type PreviewExecutado = Extract<Awaited<ReturnType<typeof flowService.preview>>, { resposta: unknown }>;
/** Turno que ficou esperando a janela — quem executa é o worker. */
type PreviewAgendado = Extract<Awaited<ReturnType<typeof flowService.preview>>, { segundos: unknown }>;

/** Grafo mínimo que passa na validação: gatilho + resposta. */
const FLUXO = {
  id: 'flow-1',
  accountId: ACC,
  status: 'draft',
  inboxIds: null,
  graph: {
    nodes: [
      { id: 't', type: 'trigger.message_received' },
      { id: 'r', type: 'chat.reply', config: { texto: '{{agente.mensagem_de_resposta}}' } },
    ],
    edges: [{ id: 'e', source: 't', target: 'r' }],
  },
};

const passo = (over: Record<string, unknown> = {}) => ({
  id: 'st-1',
  nodeId: 'r',
  nodeType: 'chat.reply',
  status: 'ok',
  input: {},
  output: { simulado: true, texto: 'Oi! Como posso ajudar?' },
  ms: 120,
  error: null,
  ordem: 1,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.flow.findFirst.mockResolvedValue(FLUXO);
  // O run é relido do banco pelo executor — devolve o que o create gravou,
  // como o banco faria.
  prismaMock.flowRun.findUnique.mockImplementation(async () => ({
    id: 'run-1',
    wakeCount: 0,
    resumeNodeId: null,
    ...(prismaMock.flowRun.create.mock.calls[0]?.[0]?.data ?? {}),
    flow: prismaMock.flow.findFirst.mock.results[0]?.value
      ? await prismaMock.flow.findFirst.mock.results[0].value
      : FLUXO,
  }));
  prismaMock.flowRun.findMany.mockResolvedValue([]);
  prismaMock.flowRun.updateMany.mockResolvedValue({ count: 0 });
  // Conversa de teste sem dono: começa pela triagem.
  prismaMock.conversation.findUnique.mockResolvedValue({
    customAttributes: {},
    assigneeId: null,
    status: 'open',
  });
  prismaMock.conversation.update.mockResolvedValue({});
  // O preview valida o inbox antes de gravar, depois carrega as memórias — as
  // duas leituras usam o mesmo findFirst.
  prismaMock.conversation.findFirst.mockResolvedValue({
    id: 'conv-teste',
    contactId: 'contato-1',
    inbox: { name: 'Simulador de atendimento' },
    customAttributes: { etapa_roteiro: 'diagnostico' },
  });
  prismaMock.contact.findFirst.mockResolvedValue({
    customAttributes: { faturamento: 'R$ 80 mil' },
  });
  prismaMock.message.create.mockResolvedValue({ id: 'msg-1', createdAt: new Date() });
  prismaMock.flowRun.create.mockResolvedValue({ id: 'run-1' });
  prismaMock.flowRun.update.mockResolvedValue({ id: 'run-1' });
  prismaMock.flowRun.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.conversation.delete.mockResolvedValue({});
  prismaMock.contact.delete.mockResolvedValue({});
  prismaMock.flowRunStep.findMany.mockResolvedValue([passo()]);
  executeRunMock.mockResolvedValue({
    status: 'done',
    steps: 2,
    stopReason: null,
    error: null,
    vars: {},
  });
});

const preview = (over: Record<string, unknown> = {}) =>
  flowService.preview({
    accountId: ACC,
    flowId: 'flow-1',
    message: 'oi, quero saber do serviço',
    conversationId: 'conv-teste',
    ...over,
  }) as Promise<PreviewExecutado>;

describe('o simulador não toca no mundo real', () => {
  it('roda SEMPRE em modo sombra — é o que segura o envio no WhatsApp', async () => {
    await preview();
    expect(executeRunMock.mock.calls[0][0].shadow).toBe(true);
    expect(prismaMock.flowRun.create.mock.calls[0][0].data.shadow).toBe(true);
  });

  it('marca o run como do simulador — some da tela de Execuções', async () => {
    await preview();
    expect(prismaMock.flowRun.create.mock.calls[0][0].data.simulador).toBe(true);
  });

  it('mesmo num fluxo publicado o run é sombra, não vira atendimento de verdade', async () => {
    prismaMock.flow.findFirst.mockResolvedValue({ ...FLUXO, status: 'active' });
    await preview();
    expect(executeRunMock.mock.calls[0][0].shadow).toBe(true);
  });

  it('recusa fluxo quebrado antes de gastar token', async () => {
    prismaMock.flow.findFirst.mockResolvedValue({
      ...FLUXO,
      graph: { nodes: [{ id: 'r', type: 'chat.reply' }], edges: [] }, // sem gatilho
    });
    await expect(preview()).rejects.toThrow(/problemas/i);
    expect(executeRunMock).not.toHaveBeenCalled();
  });

  it('mensagem vazia não vira execução', async () => {
    await expect(preview({ message: '   ' })).rejects.toThrow(/Escreva a mensagem/i);
    expect(executeRunMock).not.toHaveBeenCalled();
  });
});

describe('fidelidade: o contexto é o mesmo que o worker monta', () => {
  it('leva as DUAS memórias — a do contato e a da conversa', async () => {
    await preview();
    const vars = executeRunMock.mock.calls[0][0].vars;
    expect(vars.memoria).toEqual({ faturamento: 'R$ 80 mil' }); // longo prazo, no contato
    expect(vars.sessao).toEqual({ etapa_roteiro: 'diagnostico' }); // curto prazo, na conversa
    expect(vars.__contactId).toBe('contato-1');
  });

  /*
    O que `lembrar` grava hoje é `{ v, por, em }` — o valor mais quem disse e
    quando. Mas o interpolador do fluxo faz JSON.stringify em tudo que não é
    string, então um bloco com "Olá {{memoria.nome}}" mandava ao CLIENTE o
    objeto inteiro: Olá {"v":"João","por":"Marcus","em":"..."}.

    O teste acima não pegava porque usa o formato antigo, de valor cru — que
    continua válido de propósito, e por isso está afirmado aqui também.
  */
  it('memória com autoria chega desembrulhada — senão o cliente recebe JSON', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({
      id: 'conv-teste',
      contactId: 'contato-1',
      inbox: { name: 'Simulador de atendimento' },
      customAttributes: {
        etapa_roteiro: { v: 'diagnostico', por: 'Triagem', em: '2026-09-16T12:00:00.000Z' },
      },
    });
    prismaMock.contact.findFirst.mockResolvedValue({
      customAttributes: {
        nome: { v: 'João', por: 'Marcus', em: '2026-09-16T12:00:00.000Z' },
        faturamento: 'R$ 80 mil', // formato antigo, sem autoria — tem que passar intacto
      },
    });

    await preview();
    const vars = executeRunMock.mock.calls[0][0].vars;
    expect(vars.memoria).toEqual({ nome: 'João', faturamento: 'R$ 80 mil' });
    expect(vars.sessao).toEqual({ etapa_roteiro: 'diagnostico' });
  });

  it('a mensagem chega no formato que o motor espera', async () => {
    await preview({ message: 'quanto custa?' });
    const [msg] = executeRunMock.mock.calls[0][0].vars.mensagens;
    expect(msg).toMatchObject({ id: 'msg-1', content: 'quanto custa?', contentType: 'text' });
  });

  it('a fala do lead é persistida — é o que faz histórico e resumo funcionarem', async () => {
    await preview({ message: 'bom dia' });
    const gravada = prismaMock.message.create.mock.calls[0][0].data;
    expect(gravada).toMatchObject({
      conversationId: 'conv-teste',
      senderType: 'customer',
      content: 'bom dia',
    });
  });

  it('a resposta da IA também é persistida, senão o turno seguinte se repetiria', async () => {
    await preview();
    const resposta = prismaMock.message.create.mock.calls[1][0].data;
    expect(resposta).toMatchObject({
      senderType: 'ai_bot',
      content: 'Oi! Como posso ajudar?',
    });
    // Marcada como do simulador — não polui métrica de atendimento.
    expect(resposta.metadata).toMatchObject({ simulador: true });
  });

  it('marca `__simulador` pra o nó de espera não segurar a tela', async () => {
    await preview();
    expect(executeRunMock.mock.calls[0][0].vars.__simulador).toBe(true);
  });
});

describe('o que volta pra tela', () => {
  it('devolve a resposta lida do passo de envio', async () => {
    const r = await preview();
    expect(r.resposta).toBe('Oi! Como posso ajudar?');
    expect(r.conversationId).toBe('conv-teste');
    expect(r.steps).toHaveLength(1);
  });

  /*
    Esta é a regressão que a suíte inteira deixou passar.

    O simulador procurava `chat.reply` literal. Quando o bloco composto
    `ai.atender` passou a enviar sozinho, o fluxo PADRÃO — o novo, o que a
    ferramenta semeia — virou mudo na tela de teste: dizia "parou antes de
    responder" enquanto em produção o lead teria recebido a mensagem. O antigo
    parecia o único que funcionava, e o teste acima seguia verde porque usava
    justamente `chat.reply`.
  */
  it('o bloco composto também responde — o simulador não pode enxergar só o bloco antigo', async () => {
    prismaMock.flowRunStep.findMany.mockResolvedValue([
      passo({
        nodeType: 'ai.atender',
        output: { simulado: true, texto: 'Claro, posso ajudar com a matrícula.', saiuPor: 'respondeu' },
      }),
    ]);

    const r = await preview();
    expect(r.resposta).toBe('Claro, posso ajudar com a matrícula.');
  });

  it('o aviso de transferência conta como fala — o lead recebe, então a tela mostra', async () => {
    prismaMock.flowRunStep.findMany.mockResolvedValue([
      passo({
        nodeType: 'ai.atender',
        output: {
          simulado: true,
          motivo: 'assunto_sempre_humano',
          texto: 'Vou te passar pra um atendente agora.',
          respostaDescartada: 'Posso verificar sua cobrança...',
        },
      }),
    ]);

    const r = await preview();
    // O que aparece é o aviso, NÃO o texto que a IA escreveu e foi descartado.
    expect(r.resposta).toBe('Vou te passar pra um atendente agora.');
  });

  it('fluxo que fala duas vezes grava as duas — senão o turno seguinte lê um histórico que não houve', async () => {
    prismaMock.flowRunStep.findMany.mockResolvedValue([
      passo({ id: 'st-1', ordem: 1, nodeType: 'chat.reply', output: { texto: 'Um instante.' } }),
      passo({ id: 'st-2', ordem: 2, nodeType: 'ai.atender', output: { texto: 'Achei aqui: sua aula é 19h.' } }),
    ]);

    const r = await preview();
    expect(r.resposta).toBe('Um instante.\n\nAchei aqui: sua aula é 19h.');
    // Uma do lead + as duas da IA.
    expect(prismaMock.message.create).toHaveBeenCalledTimes(3);
  });

  it('fluxo que para antes de responder devolve resposta nula e o motivo', async () => {
    prismaMock.flowRunStep.findMany.mockResolvedValue([
      passo({ nodeType: 'guard.conditions', output: { bloqueado: true } }),
    ]);
    executeRunMock.mockResolvedValue({
      status: 'done',
      steps: 1,
      stopReason: 'humano_atribuido',
      error: null,
      vars: {},
    });

    const r = await preview();
    expect(r.resposta).toBeNull();
    expect(r.stopReason).toBe('humano_atribuido');
    // Sem resposta, nada de mensagem da IA no histórico.
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
  });

  it('mostra a memória DEPOIS da execução — é como se vê a IA aprendendo', async () => {
    prismaMock.contact.findFirst
      .mockResolvedValueOnce({ customAttributes: {} }) // antes
      .mockResolvedValueOnce({ customAttributes: { nome_do_lead: 'Ana' } }); // depois
    const r = await preview();
    expect(r.memoria).toEqual({ nome_do_lead: 'Ana' });
  });

  it('chave de controle interno não aparece na tela', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({
      id: 'conv-teste',
      contactId: 'contato-1',
      inbox: { name: 'Simulador de atendimento' },
      customAttributes: { _resumo_conversa: { texto: 'x' }, etapa: 'fechamento' },
    });
    prismaMock.contact.findFirst.mockResolvedValue({
      customAttributes: { _simulador: true, nome_do_lead: 'Ana' },
    });
    const r = await preview();
    expect(r.sessao).toEqual({ etapa: 'fechamento' });
    // Vale pras duas memórias: a marcação do contato de teste também não vaza.
    expect(r.memoria).toEqual({ nome_do_lead: 'Ana' });
  });
});

describe('a trava que impede escrever em conversa de cliente', () => {
  it('RECUSA conversa que não nasceu no simulador — ela grava mensagem', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({
      id: 'conv-real',
      contactId: 'lead-de-verdade',
      inbox: { name: 'WhatsApp Comercial' },
      customAttributes: {},
    });

    await expect(preview({ conversationId: 'conv-real' })).rejects.toThrow(
      /não é do simulador/i
    );
    // O ponto: nenhuma fala falsa entrou no histórico do lead.
    expect(prismaMock.message.create).not.toHaveBeenCalled();
    expect(executeRunMock).not.toHaveBeenCalled();
  });

  it('conversa de outra conta não é alcançável', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(null);
    await expect(preview({ conversationId: 'conv-alheia' })).rejects.toThrow();
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });
});

describe('conversa de teste', () => {
  it('sem conversa em andamento, cria uma isolada num inbox inativo', async () => {
    prismaMock.inbox.findFirst.mockResolvedValue(null);
    prismaMock.inbox.create.mockResolvedValue({ id: 'inbox-sim' });
    prismaMock.contact.create.mockResolvedValue({ id: 'contato-novo' });
    prismaMock.conversation.create.mockResolvedValue({ id: 'conv-nova' });

    const r = await preview({ conversationId: null });

    // Inativo de propósito: não pode aparecer como caixa de envio real.
    expect(prismaMock.inbox.create.mock.calls[0][0].data.active).toBe(false);
    // O contato fica visível na lista de leads — o nome precisa denunciar.
    expect(prismaMock.contact.create.mock.calls[0][0].data.nome).toMatch(/simulador/i);
    expect(r.conversationId).toBe('conv-nova');
  });

  it('reaproveita o inbox do simulador em vez de criar um por teste', async () => {
    prismaMock.inbox.findFirst.mockResolvedValue({ id: 'inbox-sim' });
    prismaMock.contact.create.mockResolvedValue({ id: 'contato-novo' });
    prismaMock.conversation.create.mockResolvedValue({ id: 'conv-nova' });

    await preview({ conversationId: null });
    expect(prismaMock.inbox.create).not.toHaveBeenCalled();
  });
});

describe('acompanhar a execução em andamento', () => {
  it('devolve os passos já gravados — é o que acende os blocos no canvas', async () => {
    prismaMock.flowRun.findFirst.mockResolvedValue({
      id: 'run-1',
      status: 'running',
      stopReason: null,
      error: null,
    });
    prismaMock.flowRunStep.findMany.mockResolvedValue([passo(), passo({ id: 'st-2' })]);

    const r = await flowService.previewRunAtual(ACC, 'conv-teste');

    expect(r!.runId).toBe('run-1');
    expect(r!.steps).toHaveLength(2);
    // Só run do simulador: não pode expor atendimento real por esta porta.
    expect(prismaMock.flowRun.findFirst.mock.calls[0][0].where).toMatchObject({
      accountId: ACC,
      conversationId: 'conv-teste',
      simulador: true,
    });
  });

  it('sem run ainda, devolve nulo em vez de estourar', async () => {
    prismaMock.flowRun.findFirst.mockResolvedValue(null);
    expect(await flowService.previewRunAtual(ACC, 'conv-teste')).toBeNull();
  });

  it('RECUSA conversa que não é do simulador', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({
      id: 'conv-real',
      contactId: 'lead',
      inbox: { name: 'WhatsApp Comercial' },
      customAttributes: {},
    });
    await expect(flowService.previewRunAtual(ACC, 'conv-real')).rejects.toThrow(
      /não é do simulador/i
    );
  });
});

/*
  C1 — A JANELA DE AGRUPAMENTO É REAL NO SIMULADOR.

  Antes, o simulador pulava o `buffer.debounce`: cada mensagem virava um turno
  na hora. O cliente, em produção, manda "oi", "quero saber do plano", "quanto
  custa?" em sequência e recebe UMA resposta pras três — e o simulador mostrava
  três respostas. Quem ajustava o prompt olhando pra tela estava ajustando
  para um atendimento que não existe.
*/
describe('a janela de agrupamento no simulador', () => {
  const FLUXO_COM_JANELA = {
    ...FLUXO,
    graph: {
      nodes: [
        { id: 't', type: 'trigger.message_received' },
        { id: 'b', type: 'buffer.debounce', config: { segundos: 15 } },
        { id: 'r', type: 'chat.reply', config: { texto: 'oi' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'b' },
        { id: 'e2', source: 'b', target: 'r' },
      ],
    },
  };

  const agendar = (over: Record<string, unknown> = {}) =>
    flowService.preview({
      accountId: ACC,
      flowId: 'flow-1',
      message: 'oi',
      conversationId: 'conv-teste',
      ...over,
    }) as Promise<PreviewAgendado>;

  beforeEach(() => {
    prismaMock.flow.findFirst.mockResolvedValue(FLUXO_COM_JANELA);
    prismaMock.flowRun.findFirst.mockResolvedValue(null); // nenhum run aberto
  });

  it('com debounce, NÃO executa na hora: cria run em buffering com a hora marcada', async () => {
    const antes = Date.now();
    const r = await agendar();

    expect(executeRunMock).not.toHaveBeenCalled();
    expect(r.status).toBe('buffering');
    expect(r.segundos).toBe(15);
    expect(r.runId).toBe('run-1');
    const marcado = new Date(r.runAfter).getTime() - antes;
    expect(marcado).toBeGreaterThan(13_000);
    expect(marcado).toBeLessThan(17_000);

    const data = prismaMock.flowRun.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'buffering', shadow: true, simulador: true });
    expect(data.context.mensagens).toHaveLength(1);
    // A fala do lead já está no histórico — o run vai lê-la quando rodar.
    expect(prismaMock.message.create).toHaveBeenCalledTimes(1);
  });

  it('segunda mensagem dentro da janela ANEXA ao run e empurra a hora — igual ao real', async () => {
    prismaMock.flowRun.findFirst.mockResolvedValue({
      id: 'run-aberto',
      context: { mensagens: [{ id: 'msg-0', content: 'oi', contentType: 'text', createdAt: 'x' }] },
    });

    const antes = Date.now();
    const r = await agendar({ message: 'quanto custa?' });

    // Nenhum run novo: a mensagem entrou no que já esperava.
    expect(prismaMock.flowRun.create).not.toHaveBeenCalled();
    expect(r.runId).toBe('run-aberto');
    expect(r.status).toBe('buffering');

    const upd = prismaMock.flowRun.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'run-aberto' });
    expect(upd.data.context.mensagens).toHaveLength(2);
    expect(upd.data.context.mensagens[1].content).toBe('quanto custa?');
    expect(upd.data.runAfter.getTime()).toBeGreaterThan(antes + 13_000);
  });

  it('corrida com o próprio worker (P2002): anexa em vez de duplicar', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '5.22.0',
    });
    prismaMock.flowRun.create.mockRejectedValueOnce(p2002);
    prismaMock.flowRun.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'run-do-outro', context: { mensagens: [] } });

    const r = await agendar();
    expect(r.runId).toBe('run-do-outro');
  });

  it('sem debounce (ou segundos = 0) continua executando na hora', async () => {
    prismaMock.flow.findFirst.mockResolvedValue({
      ...FLUXO_COM_JANELA,
      graph: {
        ...FLUXO_COM_JANELA.graph,
        nodes: FLUXO_COM_JANELA.graph.nodes.map((n) =>
          n.id === 'b' ? { ...n, config: { segundos: 0 } } : n
        ),
      },
    });

    const r = await preview();
    expect(executeRunMock).toHaveBeenCalledTimes(1);
    expect(r.resposta).toBe('Oi! Como posso ajudar?');
  });
});

/*
  O worker executa o run do simulador quando a janela vence — e executa em
  SOMBRA, com a marca do simulador, exatamente como executaria um real. É o
  mesmo `runOne`; a diferença está nos três pontos abaixo.
*/
describe('o worker executa o run do simulador', () => {
  const runDoSimulador = (over: Record<string, unknown> = {}) => ({
    id: 'run-sim',
    accountId: ACC,
    flowId: 'flow-1',
    conversationId: 'conv-teste',
    status: 'running',
    shadow: true,
    simulador: true,
    resumeNodeId: null,
    wakeCount: 0,
    context: { mensagens: [{ id: 'm', content: 'oi', contentType: 'text', createdAt: 'x' }] },
    flow: FLUXO, // rascunho, de propósito
    ...over,
  });

  beforeEach(() => {
    prismaMock.flowRun.findMany.mockResolvedValue([{ id: 'run-sim', status: 'buffering' }]);
    prismaMock.flowRun.updateMany
      .mockResolvedValueOnce({ count: 0 }) // resgate de órfãos
      .mockResolvedValueOnce({ count: 1 }); // claim
    prismaMock.flowRun.findUnique.mockResolvedValue(runDoSimulador());
  });

  it('roda em sombra e com __simulador — nada sai pro WhatsApp', async () => {
    const r = await flowService.processDueRuns();

    expect(r).toEqual({ ok: 1, failed: 0 });
    const chamada = executeRunMock.mock.calls[0][0];
    expect(chamada.shadow).toBe(true);
    expect(chamada.vars.__simulador).toBe(true);
    expect(chamada.vars.memoria).toEqual({ faturamento: 'R$ 80 mil' });
  });

  it('fluxo em RASCUNHO roda mesmo assim — o simulador existe pra testar rascunho', async () => {
    await flowService.processDueRuns();

    expect(executeRunMock).toHaveBeenCalledTimes(1);
    const salvo = prismaMock.flowRun.update.mock.calls.at(-1)![0].data;
    expect(salvo.status).toBe('done');
    expect(salvo.stopReason).not.toBe('fluxo_despublicado');
  });

  it('run REAL de fluxo em rascunho continua sendo pulado', async () => {
    prismaMock.flowRun.findUnique.mockResolvedValue(runDoSimulador({ simulador: false, shadow: false }));

    await flowService.processDueRuns();

    expect(executeRunMock).not.toHaveBeenCalled();
    const salvo = prismaMock.flowRun.update.mock.calls.at(-1)![0].data;
    expect(salvo.stopReason).toBe('fluxo_despublicado');
  });

  it('ao terminar, persiste as falas da IA na conversa de teste (uma vez)', async () => {
    prismaMock.flowRunStep.findMany.mockResolvedValue([
      passo({ output: { simulado: true, texto: 'Oi! Como posso ajudar?' } }),
    ]);

    await flowService.processDueRuns();

    const gravadas = prismaMock.message.create.mock.calls.map((c) => c[0].data);
    expect(gravadas).toHaveLength(1);
    expect(gravadas[0]).toMatchObject({
      conversationId: 'conv-teste',
      senderType: 'ai_bot',
      content: 'Oi! Como posso ajudar?',
      metadata: { simulador: true, runId: 'run-sim' },
    });
  });

  it('a marca __simulador não vaza pro contexto salvo', async () => {
    executeRunMock.mockResolvedValue({
      status: 'done',
      steps: 1,
      stopReason: null,
      error: null,
      vars: { __simulador: true, __contato: { nome: 'x' }, agente: { etapa: 'x' } },
    });

    await flowService.processDueRuns();

    const salvo = prismaMock.flowRun.update.mock.calls.at(-1)![0].data;
    expect(salvo.context.__simulador).toBeUndefined();
    expect(salvo.context.__contato).toBeUndefined();
    expect(salvo.context.agente).toEqual({ etapa: 'x' });
  });
});

describe('acompanhar o run que rodou no worker', () => {
  it('enquanto espera a janela, devolve a hora marcada e nada de resposta', async () => {
    const runAfter = new Date(Date.now() + 10_000);
    prismaMock.flowRun.findFirst.mockResolvedValue({
      id: 'run-1',
      status: 'buffering',
      runAfter,
      stopReason: null,
      error: null,
    });
    prismaMock.flowRunStep.findMany.mockResolvedValue([]);

    const r = await flowService.previewRunAtual(ACC, 'conv-teste');

    expect(r).toMatchObject({ runId: 'run-1', status: 'buffering', runAfter: runAfter.toISOString() });
    expect(r!.resposta).toBeNull();
    expect(r!.memoria).toEqual({});
  });

  it('ao terminar, a resposta vem derivada dos passos — e a memória de depois', async () => {
    prismaMock.flowRun.findFirst.mockResolvedValue({
      id: 'run-1',
      status: 'done',
      runAfter: null,
      stopReason: 'fim_do_fluxo',
      error: null,
    });
    prismaMock.flowRunStep.findMany.mockResolvedValue([
      passo({ id: 'st-1', ordem: 1, nodeType: 'chat.reply', output: { texto: 'Um instante.' } }),
      passo({ id: 'st-2', ordem: 2, nodeType: 'ai.atender', output: { texto: 'Sua aula é 19h.' } }),
      passo({ id: 'st-3', ordem: 3, nodeType: 'guard.conditions', output: { texto: 'não fala' } }),
    ]);

    const r = await flowService.previewRunAtual(ACC, 'conv-teste');

    // Só quem FALA entra — pelo catálogo, não por tipo fixo.
    expect(r!.resposta).toBe('Um instante.\n\nSua aula é 19h.');
    expect(r!.status).toBe('done');
    expect(r!.runAfter).toBeNull();
    expect(r!.memoria).toEqual({ faturamento: 'R$ 80 mil' });
    expect(r!.sessao).toEqual({ etapa_roteiro: 'diagnostico' });
  });

  it('é idempotente: chamar duas vezes não grava nada', async () => {
    prismaMock.flowRun.findFirst.mockResolvedValue({
      id: 'run-1',
      status: 'done',
      runAfter: null,
      stopReason: null,
      error: null,
    });
    await flowService.previewRunAtual(ACC, 'conv-teste');
    await flowService.previewRunAtual(ACC, 'conv-teste');
    expect(prismaMock.message.create).not.toHaveBeenCalled();
    expect(prismaMock.flowRun.update).not.toHaveBeenCalled();
  });
});

describe('reset', () => {
  it('apaga a conversa de teste e o contato dela', async () => {
    await flowService.resetPreview(ACC, 'conv-teste');

    expect(prismaMock.conversation.delete).toHaveBeenCalledWith({ where: { id: 'conv-teste' } });
    expect(prismaMock.contact.delete).toHaveBeenCalledWith({ where: { id: 'contato-1' } });
    // Os runs não têm FK pra conversa: sem isso ficariam órfãos no banco.
    expect(prismaMock.flowRun.deleteMany).toHaveBeenCalledWith({
      where: { accountId: ACC, conversationId: 'conv-teste' },
    });
  });

  it('RECUSA apagar conversa que não é do simulador — o reset é destrutivo', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({
      id: 'conv-real',
      contactId: 'lead-de-verdade',
      inbox: { name: 'WhatsApp Comercial' },
    });

    await expect(flowService.resetPreview(ACC, 'conv-real')).rejects.toThrow(/não é do simulador/i);
    expect(prismaMock.conversation.delete).not.toHaveBeenCalled();
    expect(prismaMock.contact.delete).not.toHaveBeenCalled();
  });

  it('conversa de outra conta não existe pra este admin', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(null);
    await expect(flowService.resetPreview(ACC, 'conv-alheia')).rejects.toThrow();
    // O escopo por conta é do próprio where — a trava não depende do nome do inbox.
    expect(prismaMock.conversation.findFirst.mock.calls[0][0].where.accountId).toBe(ACC);
  });
});
