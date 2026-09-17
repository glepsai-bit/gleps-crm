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
  contact: { findFirst: vi.fn(), update: vi.fn() },
  // A etapa é resolvida no FUNIL REAL da conta, e a transferência por time lê
  // o time com os membros ativos.
  tag: { findFirst: vi.fn() },
  team: { findFirst: vi.fn() },
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
const assignMock = vi.hoisted(() => vi.fn());
const assignToTeamMock = vi.hoisted(() => vi.fn());
const updateStatusMock = vi.hoisted(() => vi.fn());
const resolveMock = vi.hoisted(() => vi.fn());
vi.mock('../conversation.service', () => ({
  conversationService: {
    addLabel: addLabelMock,
    // Continua mockado de propósito: o teste prova que NÃO é mais chamado.
    resolveOrCreateTagByLabel: resolveTagMock,
    assign: assignMock,
    assignToTeam: assignToTeamMock,
    updateStatus: updateStatusMock,
    resolve: resolveMock,
  },
}));

const listOnlineMock = vi.hoisted(() => vi.fn());
vi.mock('../agent-availability.service', () => ({
  agentAvailabilityService: { listOnline: listOnlineMock },
}));
const pickAssigneeMock = vi.hoisted(() => vi.fn());
vi.mock('../team.service', () => ({ teamService: { pickAssignee: pickAssigneeMock } }));
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
  // A conta tem a etapa que o agente costuma devolver nos testes abaixo.
  prismaMock.tag.findFirst.mockImplementation(async (q: { where: { OR: { slug?: { equals: string } }[] } }) => {
    const pedida = q.where.OR[0].slug?.equals;
    return pedida === 'novo-lead' ? { id: 'tag-1', slug: 'novo-lead' } : null;
  });
  sendMock.mockResolvedValue({ messageId: 'm1', status: 'sent' });
  resolveTagMock.mockResolvedValue('tag-1');
  addLabelMock.mockResolvedValue(undefined);
  listOnlineMock.mockResolvedValue([]);
  pickAssigneeMock.mockResolvedValue(null);
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
    // A etiqueta aplicada é a do FUNIL da conta — resolvida, nunca criada.
    expect(addLabelMock).toHaveBeenCalledWith('conv-1', 'acc-1', 'tag-1', 'flow:flow-1');
    expect(resolveTagMock).not.toHaveBeenCalled();
    expect(r.output).toMatchObject({ etapa: 'novo-lead', tagId: 'tag-1' });
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
/*
  C2 — A ETAPA VEM DO KANBAN REAL.

  O bug era silencioso: o modelo devolvia "agendado", o fluxo não achava a
  etiqueta e CRIAVA uma com esse nome — fora do funil. O kanban de verdade
  ficava intocado e ninguém via erro nenhum.
*/
describe('etapa no funil real', () => {
  it('etapa que a conta NÃO tem: nada é criado, e o passo diz por quê', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'oi', etapa: 'agendado' })
    );

    const r = await atender.execute(no(), ctx());

    expect(resolveTagMock).not.toHaveBeenCalled();
    expect(addLabelMock).not.toHaveBeenCalled();
    expect(r.output).toMatchObject({ etapa: 'agendado', motivo: 'etapa_desconhecida' });
    // A resposta ainda vai: recusar a etapa não é recusar o atendimento.
    expect(sendMock).toHaveBeenCalled();
  });

  it('a busca é escopada por conta e só olha etapa ativa do funil', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'oi', etapa: 'novo-lead' })
    );
    await atender.execute(no(), ctx());

    const where = prismaMock.tag.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ accountId: 'acc-1', type: 'stage', ativo: true });
  });

  it('em sombra a resolução acontece igual — o simulador mostra a mesma recusa', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'oi', etapa: 'inventada' })
    );
    const r = await atender.execute(no(), ctx({ shadow: true }));
    expect(r.output).toMatchObject({ motivo: 'etapa_desconhecida' });
    expect(addLabelMock).not.toHaveBeenCalled();
  });

  it('o bloco "Aplicar etapa" segue a mesma regra estrita', async () => {
    const aplicar = NODE_CATALOG['crm.apply_stage'];

    const r = await aplicar.execute(
      { id: 's', type: 'crm.apply_stage', config: { etapa: 'agendado' } },
      ctx()
    );

    expect(r.output).toMatchObject({ etapa: 'agendado', motivo: 'etapa_desconhecida' });
    expect(resolveTagMock).not.toHaveBeenCalled();
    expect(addLabelMock).not.toHaveBeenCalled();

    const ok = await aplicar.execute(
      { id: 's', type: 'crm.apply_stage', config: { etapa: 'novo-lead' } },
      ctx()
    );
    expect(ok.output).toMatchObject({ etapa: 'novo-lead', tagId: 'tag-1' });
    expect(addLabelMock).toHaveBeenCalledWith('conv-1', 'acc-1', 'tag-1', 'flow:flow-1');
  });
});

// ============================================
/*
  C3 — PRECEDÊNCIA DA SAÍDA.

  `rota: "respondeu"` + `transferir_para_humano: true` NÃO transferia: a rota
  vencia, e o lead que pediu humano ficava com a IA. Rota PRÓPRIA (financeiro,
  agendamento) continua vencendo — é a decisão mais específica.
*/
describe('precedência das portas', () => {
  it('rota "respondeu" + pediu humano → sai por "humano"', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'um instante', rota: 'respondeu', transferir_para_humano: true })
    );
    const r = await atender.execute(no(), ctx());
    expect(r.branch).toBe('humano');
  });

  it('rota "respondeu" + encerrou → sai por "encerrou"', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'tchau', rota: 'respondeu', resolver_conversa: true })
    );
    const r = await atender.execute(no(), ctx());
    expect(r.branch).toBe('encerrou');
  });

  it('rota própria vence os sinais genéricos', async () => {
    runAgentMock.mockResolvedValue(
      respostaAgente({ mensagem_de_resposta: 'x', rota: 'financeiro', transferir_para_humano: true })
    );
    const r = await atender.execute(no(), ctx());
    expect(r.branch).toBe('financeiro');
  });

  it('sem sinal nenhum, "respondeu"', async () => {
    runAgentMock.mockResolvedValue(respostaAgente({ mensagem_de_resposta: 'x' }));
    const r = await atender.execute(no(), ctx());
    expect(r.branch).toBe('respondeu');
  });
});

// ============================================
/*
  C3 — TRANSFERIR PARA UM TIME.

  É o que transforma "rota" em "departamento": `financeiro → time Financeiro`
  só é possível se o bloco souber de time. Sem time, o sorteio de sempre.
*/
describe('transferir para humano, por time', () => {
  const transferir = NODE_CATALOG['chat.assign_human'];
  const noTime = (config: Record<string, unknown> = {}) => ({
    id: 'tr',
    type: 'chat.assign_human',
    config,
  });
  const u = (id: string) => ({ id, email: `${id}@x.com` });

  beforeEach(() => {
    prismaMock.team.findFirst.mockResolvedValue({
      id: 'time-fin',
      name: 'Financeiro',
      members: [{ userId: 'ana' }, { userId: 'bia' }],
    });
    assignMock.mockResolvedValue({});
    assignToTeamMock.mockResolvedValue({});
    updateStatusMock.mockResolvedValue({});
  });

  it('sem time configurado, comportamento de hoje: sorteia entre os online', async () => {
    listOnlineMock.mockResolvedValue([u('carlos')]);

    const r = await transferir.execute(noTime(), ctx());

    expect(prismaMock.team.findFirst).not.toHaveBeenCalled();
    expect(assignToTeamMock).not.toHaveBeenCalled();
    expect(assignMock).toHaveBeenCalledWith('conv-1', 'acc-1', 'carlos', 'flow:flow-1');
    expect(r.output).toMatchObject({ assigneeId: 'carlos' });
  });

  it('com time: escolhe na interseção online ∩ membros ativos do time', async () => {
    // carlos está online mas não é do Financeiro; bia é do time e está online.
    listOnlineMock.mockResolvedValue([u('carlos'), u('bia')]);

    const r = await transferir.execute(noTime({ teamId: 'time-fin' }), ctx());

    expect(pickAssigneeMock).not.toHaveBeenCalled();
    expect(assignToTeamMock).toHaveBeenCalledWith('conv-1', 'acc-1', 'time-fin', 'flow:flow-1');
    expect(assignMock).toHaveBeenCalledWith('conv-1', 'acc-1', 'bia', 'flow:flow-1');
    expect(updateStatusMock).toHaveBeenCalledWith('conv-1', 'acc-1', 'open', 'flow:flow-1');
    expect(r.branch).toBeUndefined();
    expect(r.output).toMatchObject({ teamId: 'time-fin', teamNome: 'Financeiro', assigneeId: 'bia' });
  });

  it('ninguém do time online: cai no rodízio do time', async () => {
    listOnlineMock.mockResolvedValue([u('carlos')]); // online, mas de outro time
    pickAssigneeMock.mockResolvedValue({ id: 'ana', email: 'ana@x.com' });

    const r = await transferir.execute(noTime({ teamId: 'time-fin' }), ctx());

    expect(pickAssigneeMock).toHaveBeenCalledWith('time-fin', 'acc-1');
    expect(assignMock).toHaveBeenCalledWith('conv-1', 'acc-1', 'ana', 'flow:flow-1');
    expect(r.output).toMatchObject({ assigneeId: 'ana', criterio: 'rodizio_do_time' });
  });

  it('nem rodízio: "sem_atendente"', async () => {
    listOnlineMock.mockResolvedValue([]);
    pickAssigneeMock.mockResolvedValue(null);

    const r = await transferir.execute(noTime({ teamId: 'time-fin' }), ctx());

    expect(r.branch).toBe('sem_atendente');
    expect(assignMock).not.toHaveBeenCalled();
    expect(r.output).toMatchObject({ motivo: 'time_sem_atendente', teamId: 'time-fin' });
  });

  it('time de outra conta não existe: "sem_atendente", sem derrubar o atendimento', async () => {
    prismaMock.team.findFirst.mockResolvedValue(null);
    listOnlineMock.mockResolvedValue([u('bia')]);

    const r = await transferir.execute(noTime({ teamId: 'time-alheio' }), ctx());

    expect(prismaMock.team.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'time-alheio',
      accountId: 'acc-1',
    });
    expect(r.branch).toBe('sem_atendente');
    expect(r.output).toMatchObject({ motivo: 'time_nao_encontrado' });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('em sombra decide igual, mas não atribui', async () => {
    listOnlineMock.mockResolvedValue([u('bia')]);

    const r = await transferir.execute(noTime({ teamId: 'time-fin' }), ctx({ shadow: true }));

    expect(assignMock).not.toHaveBeenCalled();
    expect(assignToTeamMock).not.toHaveBeenCalled();
    expect(r.output).toMatchObject({ simulado: true, teamNome: 'Financeiro', assigneeId: 'bia' });
  });
});

// ============================================
/*
  C4 — AO ENCERRAR, O QUE SE APRENDEU VAI PRO CONTATO.

  A conversa morre e o `_resumo_conversa` morre com ela. Copiar resumo + etapa
  + data para o contato é de onde sai o "última conversa" quando a pessoa
  volta — sem gastar um token a mais.
*/
describe('resolver conversa guarda a última conversa no contato', () => {
  const resolver = NODE_CATALOG['chat.resolve'];
  const noResolve = { id: 'fim', type: 'chat.resolve', config: { outcome: 'resolved' } };

  beforeEach(() => {
    prismaMock.conversation.findFirst.mockResolvedValue({
      assigneeId: null,
      contactId: 'contato-1',
      customAttributes: { _resumo_conversa: { texto: 'Lead quer plano anual.', cobertas: 20 } },
      labels: [
        { tag: { slug: 'vip', type: 'operational' } },
        { tag: { slug: 'agendado', type: 'stage' } },
      ],
    });
    prismaMock.contact.findFirst.mockResolvedValue({ customAttributes: { nome: 'Ana' } });
    prismaMock.contact.update.mockResolvedValue({});
    resolveMock.mockResolvedValue({});
  });

  it('copia resumo + etapa + data para _ultima_conversa, preservando o resto', async () => {
    const r = await resolver.execute(noResolve, ctx());

    const gravado = prismaMock.contact.update.mock.calls[0][0].data.customAttributes;
    expect(gravado.nome).toBe('Ana');
    expect(gravado._ultima_conversa).toMatchObject({
      resumo: 'Lead quer plano anual.',
      etapa: 'agendado', // a etapa do FUNIL, não a etiqueta operacional
    });
    expect(typeof gravado._ultima_conversa.em).toBe('string');
    expect(resolveMock).toHaveBeenCalled();
    expect(r.stopReason).toBe('conversa_resolvida');
  });

  it('sem resumo ainda, guarda etapa e data mesmo assim', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({
      contactId: 'contato-1',
      customAttributes: {},
      labels: [{ tag: { slug: 'novo-lead', type: 'stage' } }],
    });
    await resolver.execute(noResolve, ctx());
    const gravado = prismaMock.contact.update.mock.calls[0][0].data.customAttributes;
    expect(gravado._ultima_conversa).toMatchObject({ resumo: null, etapa: 'novo-lead' });
  });

  it('falha ao guardar não impede o encerramento', async () => {
    prismaMock.contact.update.mockRejectedValue(new Error('banco caiu'));
    const r = await resolver.execute(noResolve, ctx());
    expect(resolveMock).toHaveBeenCalled();
    expect(r.stopReason).toBe('conversa_resolvida');
  });

  it('em sombra não toca no contato', async () => {
    await resolver.execute(noResolve, ctx({ shadow: true }));
    expect(prismaMock.contact.update).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
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

/**
 * T-038 — o fluxo padrão passa a nascer com o bloco composto.
 *
 * Sem isto a redução de 11 para 6 não acontecia para ninguém: o botão "Criar
 * fluxo padrão" continuava montando a versão antiga, e a peça nova ficava só
 * na paleta esperando alguém descobrir.
 */
describe('o fluxo semeado', () => {
  it('monta 6 blocos, não 11', async () => {
    const { buildDefaultGraph } = await import('./default-graph');
    const g = buildDefaultGraph('ag-1');
    expect(g.nodes).toHaveLength(6);
  });

  it('usa o bloco composto e não as seis peças soltas', async () => {
    const { buildDefaultGraph } = await import('./default-graph');
    const tipos = buildDefaultGraph('ag-1').nodes.map((n) => n.type);

    expect(tipos).toContain('ai.atender');
    // As peças que ele absorveu não aparecem mais no padrão.
    expect(tipos).not.toContain('ai.agent');
    expect(tipos).not.toContain('logic.switch');
    expect(tipos).not.toContain('crm.apply_stage');
    expect(tipos).not.toContain('chat.reply');
  });

  it('as decisões viram arestas por porta nomeada', async () => {
    const { buildDefaultGraph } = await import('./default-graph');
    const g = buildDefaultGraph('ag-1');
    const doAtende = g.edges.filter((e) => e.source === 'atende');

    expect(doAtende.map((e) => e.branch).sort()).toEqual(['encerrou', 'humano']);
    // "respondeu" de propósito sem aresta: a maioria das mensagens acaba aí, e
    // o fluxo termina esperando a próxima.
    expect(doAtende.some((e) => e.branch === 'respondeu')).toBe(false);
  });

  it('o grafo semeado passa na validação', async () => {
    const { buildDefaultGraph } = await import('./default-graph');
    const { validateGraph } = await import('./engine');
    expect(validateGraph(buildDefaultGraph('ag-1'))).toEqual([]);
  });

  it('sem agente escolhido, a validação avisa antes de publicar', async () => {
    const { buildDefaultGraph } = await import('./default-graph');
    const { validateGraph } = await import('./engine');
    const problemas = validateGraph(buildDefaultGraph(null));
    expect(problemas.join(' ')).toMatch(/sem agente/i);
  });

  it('a lista de assunto sempre-humano nasce VAZIA', async () => {
    const { buildDefaultGraph } = await import('./default-graph');
    const atende = buildDefaultGraph('ag-1').nodes.find((n) => n.type === 'ai.atender');
    // É decisão de negócio de cada cliente. Um padrão nosso seria palpite
    // sobre o negócio dele — e palpite que bloqueia atendimento.
    expect((atende!.config as { rotasSempreHumano: string[] }).rotasSempreHumano).toEqual([]);
  });
});
