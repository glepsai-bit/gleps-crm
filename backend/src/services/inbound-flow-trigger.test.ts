/**
 * T-033 — gatilho de fluxo por chamada externa.
 *
 * Existe porque nem todo dado nasce no CRM: academia usa Pacto, e a verdade
 * sobre aniversário ou plano vencendo mora lá. Ninguém vai trocar de sistema
 * por causa disso.
 *
 * O que se testa aqui é sobretudo o que RECUSA. Um gatilho externo que aceita
 * qualquer coisa vira disparo em massa sem critério — e com Baileys isso não
 * dá erro de API, dá banimento do número da academia.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  inboundIntegration: { findFirst: vi.fn() },
  flow: { findFirst: vi.fn() },
  inbox: { findFirst: vi.fn() },
  // findFirst: a checagem explícita de reentrega, feita antes do insert porque
  // o índice do agrupamento dispara antes do de dedupe quando é o mesmo contato.
  flowRun: { create: vi.fn(), findFirst: vi.fn() },
}));

vi.mock('../config/database', () => ({ prisma: prismaMock }));
vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./contact.service', () => ({ contactService: {} }));
vi.mock('./whatsapp-campaign.service', () => ({ whatsappCampaignService: {} }));
vi.mock('./event.service', () => ({ eventService: { create: vi.fn() } }));

const findOrCreateMock = vi.hoisted(() => vi.fn());
vi.mock('./conversation.service', () => ({
  conversationService: { findOrCreateForCustomer: findOrCreateMock },
}));

import { Prisma } from '@prisma/client';
import { inboundIntegrationService } from './inbound-integration.service';

const ACC = 'acc-1';

const GRAFO_EXTERNO = {
  nodes: [
    { id: 'g', type: 'trigger.webhook' },
    { id: 'r', type: 'chat.reply', config: { texto: 'oi' } },
  ],
  edges: [{ id: 'e', source: 'g', target: 'r' }],
};

const integracao = (config: Record<string, unknown> = {}) => ({
  id: 'int-1',
  accountId: ACC,
  slug: 'pacto',
  handler: 'flow_trigger',
  secret: 'x',
  active: true,
  config: { flowId: 'flow-1', campoTelefone: 'data.telefone', ...config },
});

/**
 * O handler é privado — o teste chama pelo caminho real do dispatch, que é
 * como o webhook do Pacto chega de verdade.
 */
const disparar = (body: unknown, config: Record<string, unknown> = {}) => {
  prismaMock.inboundIntegration.findFirst.mockResolvedValue(integracao(config));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (inboundIntegrationService as any).handleFlowTrigger(ACC, integracao(config), body);
};

const CORPO = { evento: 'aniversario', data: { telefone: '5511988887777', nome: 'Ana' } };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.flow.findFirst.mockResolvedValue({
    id: 'flow-1',
    accountId: ACC,
    status: 'active',
    graph: GRAFO_EXTERNO,
  });
  prismaMock.inbox.findFirst.mockResolvedValue({ id: 'inbox-1' });
  prismaMock.flowRun.create.mockResolvedValue({ id: 'run-1' });
  prismaMock.flowRun.findFirst.mockResolvedValue(null); // nada visto antes
  findOrCreateMock.mockResolvedValue({ id: 'conv-1' });
});

describe('o caminho feliz — Pacto avisa aniversário', () => {
  it('resolve o contato pelo telefone e cria o atendimento', async () => {
    const r = await disparar(CORPO, { campoNome: 'data.nome' });

    expect(findOrCreateMock).toHaveBeenCalledWith(ACC, 'inbox-1', {
      externalId: '5511988887777',
      contactPhone: '5511988887777',
      contactName: 'Ana',
    });
    expect(r.runId).toBe('run-1');
  });

  it('sem campoNome configurado, não adivinha o nome', async () => {
    await disparar(CORPO);
    // Chutar qual campo é o nome em JSON de terceiro é como se grava "Cliente"
    // ou o CPF no lugar do nome. Melhor vazio e explícito.
    expect(findOrCreateMock.mock.calls[0][2].contactName).toBeNull();
  });

  it('o corpo inteiro vira {{webhook.*}} para os nós seguintes', async () => {
    await disparar(CORPO);
    const ctx = prismaMock.flowRun.create.mock.calls[0][0].data.context;
    // É isto que deixa o nó de Condição rotear por {{webhook.evento}} sem
    // precisar de nó novo nenhum.
    expect(ctx.webhook).toEqual(CORPO);
  });

  it('lê telefone aninhado — cada sistema entrega o JSON do seu jeito', async () => {
    await disparar(
      { aluno: { contato: { celular: '5511977776666' } } },
      { campoTelefone: 'aluno.contato.celular' }
    );
    expect(findOrCreateMock.mock.calls[0][2].contactPhone).toBe('5511977776666');
  });

  it('nasce vencido: disparo externo não tem o que agrupar', async () => {
    await disparar(CORPO);
    const data = prismaMock.flowRun.create.mock.calls[0][0].data;
    expect(data.status).toBe('buffering');
    expect(data.runAfter.getTime()).toBeLessThanOrEqual(Date.now() + 100);
  });

  it('fluxo em sombra gera run em sombra — dá pra testar sem mandar nada', async () => {
    prismaMock.flow.findFirst.mockResolvedValue({
      id: 'flow-1',
      accountId: ACC,
      status: 'shadow',
      graph: GRAFO_EXTERNO,
    });
    await disparar(CORPO);
    expect(prismaMock.flowRun.create.mock.calls[0][0].data.shadow).toBe(true);
  });
});

describe('idempotência — sistema que erra reenvia', () => {
  it('monta a chave com o slug, pra dois sistemas não colidirem', async () => {
    await disparar({ ...CORPO, id: 'evt-99' }, { campoDedupe: 'id' });
    expect(prismaMock.flowRun.create.mock.calls[0][0].data.dedupeKey).toBe('pacto:evt-99');
  });

  it('reentrega vira no-op em vez de segundo "feliz aniversário"', async () => {
    // Caminho normal: o run daquele evento já existe. É checado ANTES de
    // inserir, porque quando os dois eventos são do mesmo contato o índice do
    // agrupamento dispara antes do de dedupe — e a reentrega viraria erro em
    // vez de silêncio, justo o caso que precisa ser silencioso.
    prismaMock.flowRun.findFirst.mockResolvedValue({ id: 'run-antigo', conversationId: 'conv-1' });

    const r = await disparar({ ...CORPO, id: 'evt-99' }, { campoDedupe: 'id' });
    expect(r.duplicado).toBe(true);
    expect(r.runId).toBeNull();
    // Nem tentou inserir.
    expect(prismaMock.flowRun.create).not.toHaveBeenCalled();
  });

  it('entregas SIMULTÂNEAS: o índice do banco é a trava final', async () => {
    // As duas passam pela checagem (nenhuma vê a outra ainda) e a segunda
    // esbarra no índice único. O handler distingue por instanceof e pelo nome
    // do índice — um `{ code: 'P2002' }` qualquer não vira duplicata.
    prismaMock.flowRun.findFirst.mockResolvedValue(null);
    prismaMock.flowRun.create.mockRejectedValue(
      Object.assign(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'x',
        }),
        { meta: { target: 'flow_runs_account_dedupe_key' } }
      )
    );

    const r = await disparar({ ...CORPO, id: 'evt-99' }, { campoDedupe: 'id' });
    expect(r.duplicado).toBe(true);
  });

  it('conflito de atendimento pendente NÃO é confundido com reentrega', async () => {
    prismaMock.flowRun.findFirst.mockResolvedValue(null);
    prismaMock.flowRun.create.mockRejectedValue(
      Object.assign(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'x',
        }),
        { meta: { target: 'flow_runs_conversation_buffering_key' } }
      )
    );

    // Evento legítimo sumindo em silêncio é pior que falhar alto.
    await expect(
      disparar({ ...CORPO, id: 'evt-outro' }, { campoDedupe: 'id' })
    ).rejects.toThrow(/atendimento pendente/i);
  });

  it('sem campo de dedupe configurado, não inventa chave', async () => {
    await disparar(CORPO);
    expect(prismaMock.flowRun.create.mock.calls[0][0].data.dedupeKey).toBeNull();
  });
});

describe('o que ele RECUSA', () => {
  it('fluxo em rascunho — senão o webhook responde 200 e nada acontece', async () => {
    prismaMock.flow.findFirst.mockResolvedValue({
      id: 'flow-1',
      accountId: ACC,
      status: 'draft',
      graph: GRAFO_EXTERNO,
    });
    await expect(disparar(CORPO)).rejects.toThrow(/rascunho/i);
    expect(prismaMock.flowRun.create).not.toHaveBeenCalled();
  });

  it('fluxo que começa por mensagem recebida não pode ser chamado de fora', async () => {
    prismaMock.flow.findFirst.mockResolvedValue({
      id: 'flow-1',
      accountId: ACC,
      status: 'active',
      graph: { nodes: [{ id: 'g', type: 'trigger.message_received' }], edges: [] },
    });
    await expect(disparar(CORPO)).rejects.toThrow(/Chamada externa/i);
  });

  it('corpo sem telefone — sem destinatário não há atendimento', async () => {
    await expect(disparar({ evento: 'aniversario', data: {} })).rejects.toThrow(/telefone/i);
    expect(prismaMock.flowRun.create).not.toHaveBeenCalled();
  });

  it('fluxo de outra conta não existe para esta integração', async () => {
    prismaMock.flow.findFirst.mockResolvedValue(null);
    await expect(disparar(CORPO)).rejects.toThrow();
    // O escopo por conta está no próprio where.
    expect(prismaMock.flow.findFirst.mock.calls[0][0].where.accountId).toBe(ACC);
  });

  it('integração sem flowId configurado falha alto', async () => {
    await expect(disparar(CORPO, { flowId: undefined })).rejects.toThrow(/flowId/i);
  });

  it('conta sem inbox de WhatsApp ativo — não há por onde falar', async () => {
    prismaMock.inbox.findFirst.mockResolvedValue(null);
    await expect(disparar(CORPO)).rejects.toThrow(/inbox/i);
  });
});
