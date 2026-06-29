/**
 * CSAT service tests — SLA v2.
 *
 * Cobre:
 *  - sendPendingCsatMessages: cria msg system pra cycles elegiveis
 *  - nao envia 2x (csatSentAt guard)
 *  - nao envia se passou 24h (janela maxima)
 *  - nao envia se ainda nao passou 15min (delay minimo)
 *  - parseRatingFromText: reconhece formatos comuns
 *  - parseCustomerResponse: grava customerCsat=5 quando msg='5'
 *  - parseCustomerResponse no-op quando texto nao for rating
 *
 * Mock: messageService.create (nao bate evolution real).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./evolution.service', () => ({
  evolutionService: {
    sendText: vi.fn(async () => ({ messageId: 'mock' })),
    sendMedia: vi.fn(async () => ({ messageId: 'mock' })),
    sendAudio: vi.fn(async () => ({ messageId: 'mock' })),
  },
}));

// Mock messageService: nao queremos disparar webhook outbound nem socket;
// soh queremos validar que a chamada aconteceu com os parametros certos.
vi.mock('./message.service', () => ({
  messageService: {
    create: vi.fn(async (accountId: string, input: any) => ({
      id: `msg-${Math.random()}`,
      conversationId: input.conversationId,
      senderType: input.senderType,
      content: input.content,
      contentType: input.contentType,
      isPrivate: input.isPrivate ?? false,
      metadata: input.metadata ?? {},
      createdAt: new Date(),
    })),
    markFailed: vi.fn(async (id: string) => ({ id, status: 'failed' })),
  },
}));

import { prismaTest } from '../test/setup';
import { createTestAccount } from '../test/helpers';
import { csatService, parseRatingFromText } from './csat.service';
import { messageService } from './message.service';
import { evolutionService } from './evolution.service';

beforeEach(() => {
  vi.mocked(messageService.create).mockClear();
  vi.mocked(messageService.markFailed).mockClear();
  vi.mocked(evolutionService.sendText).mockClear();
  vi.mocked(evolutionService.sendText).mockResolvedValue({
    messageId: 'mock-msg-id',
    raw: {},
  } as any);
});

async function createConvWithCycle(
  accountId: string,
  overrides: {
    resolvedAtAgoMs?: number;
    csatRequested?: boolean;
    csatSentAt?: Date | null;
    customerCsat?: number | null;
    contactPhone?: string | null;
  } = {}
) {
  const inbox = await prismaTest.inbox.create({
    data: {
      accountId,
      name: 'Inbox CSAT',
      channelType: 'whatsapp',
      evolutionInstance: `inst-${Date.now()}-${Math.random()}`,
    },
  });
  const contact = overrides.contactPhone === null
    ? null
    : await prismaTest.contact.create({
        data: {
          accountId,
          nome: 'Contato CSAT',
          telefone: overrides.contactPhone ?? '5534993383017', // numero de teste
        },
      });
  const conv = await prismaTest.conversation.create({
    data: {
      accountId,
      inboxId: inbox.id,
      contactId: contact?.id ?? null,
      status: 'resolved',
    },
  });
  const resolvedAt =
    overrides.resolvedAtAgoMs !== undefined
      ? new Date(Date.now() - overrides.resolvedAtAgoMs)
      : new Date(Date.now() - 30 * 60 * 1000); // 30min atras (elegivel)
  const cycle = await prismaTest.conversationCycle.create({
    data: {
      accountId,
      conversationId: conv.id,
      openedAt: new Date(Date.now() - 60 * 60 * 1000),
      resolvedAt,
      resolvedBy: 'human',
      outcome: 'resolved',
      durationSec: 1800,
      csatRequested: overrides.csatRequested ?? true,
      csatSentAt: overrides.csatSentAt ?? null,
      customerCsat: overrides.customerCsat ?? null,
    },
  });
  return { inbox, contact, conv, cycle };
}

describe('parseRatingFromText', () => {
  it('reconhece "1", "5" como string inteira', () => {
    expect(parseRatingFromText('1')).toBe(1);
    expect(parseRatingFromText('5')).toBe(5);
    expect(parseRatingFromText('3')).toBe(3);
  });

  it('reconhece "5/5" e "3/5"', () => {
    expect(parseRatingFromText('5/5')).toBe(5);
    expect(parseRatingFromText('3 / 5')).toBe(3);
  });

  it('reconhece palavras-chave', () => {
    expect(parseRatingFromText('ruim')).toBe(1);
    expect(parseRatingFromText('pessimo')).toBe(1);
    expect(parseRatingFromText('otimo')).toBe(5);
    expect(parseRatingFromText('excelente')).toBe(5);
    expect(parseRatingFromText('bom')).toBe(4);
  });

  it('retorna null pra texto sem rating', () => {
    expect(parseRatingFromText('oi')).toBeNull();
    expect(parseRatingFromText('')).toBeNull();
    expect(parseRatingFromText(null)).toBeNull();
    expect(parseRatingFromText('quero falar com humano')).toBeNull();
  });

  // BUG-012: regex estrito — qualquer digito 1-5 isolado NAO deve virar CSAT.
  it('BUG-012: nao reconhece digito 1-5 em frase casual (anti falso positivo)', () => {
    expect(parseRatingFromText('foram 3 horas esperando')).toBeNull();
    expect(parseRatingFromText('sou cliente ha 5 anos')).toBeNull();
    expect(parseRatingFromText('preciso 2 reservas pra hoje')).toBeNull();
    expect(parseRatingFromText('meu CEP eh 04567')).toBeNull();
  });

  it('BUG-012: aceita avaliacao quando ha prefixo claro', () => {
    expect(parseRatingFromText('nota 4')).toBe(4);
    expect(parseRatingFromText('avalio 5')).toBe(5);
    expect(parseRatingFromText('dou 3')).toBe(3);
  });

  it('BUG-012: aceita avaliacao quando ha sufixo claro', () => {
    expect(parseRatingFromText('5 estrelas')).toBe(5);
    expect(parseRatingFromText('3 pontos')).toBe(3);
    expect(parseRatingFromText('4 de 5')).toBe(4);
  });
});

describe('csatService.sendPendingCsatMessages', () => {
  it('cria msg system pra cycles elegiveis (resolvido entre 15min e 24h)', async () => {
    const { account } = await createTestAccount();
    await createConvWithCycle(account.id, { resolvedAtAgoMs: 30 * 60 * 1000 }); // 30min atras

    const result = await csatService.sendPendingCsatMessages();
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(messageService.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(messageService.create).mock.calls[0];
    expect(call[1].senderType).toBe('system');
    expect(call[1].content).toMatch(/avalia/i);
    expect(call[1].metadata).toMatchObject({ csat_request: true });
  });

  it('NAO envia 2x — guard csatSentAt', async () => {
    const { account } = await createTestAccount();
    // Cycle ja teve csat enviado 1h atras
    await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 30 * 60 * 1000,
      csatSentAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await csatService.sendPendingCsatMessages();
    expect(result.sent).toBe(0);
    expect(messageService.create).not.toHaveBeenCalled();
  });

  it('NAO envia se passou 24h da resolucao', async () => {
    const { account } = await createTestAccount();
    await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 25 * 60 * 60 * 1000, // 25h atras (passou janela)
    });

    const result = await csatService.sendPendingCsatMessages();
    expect(result.sent).toBe(0);
  });

  it('NAO envia se ainda nao passou 15min da resolucao', async () => {
    const { account } = await createTestAccount();
    await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 5 * 60 * 1000, // 5min atras (cedo demais)
    });

    const result = await csatService.sendPendingCsatMessages();
    expect(result.sent).toBe(0);
  });

  it('NAO envia se csatRequested=false', async () => {
    const { account } = await createTestAccount();
    await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 30 * 60 * 1000,
      csatRequested: false,
    });

    const result = await csatService.sendPendingCsatMessages();
    expect(result.sent).toBe(0);
  });

  it('marca csatSentAt apos envio bem-sucedido', async () => {
    const { account } = await createTestAccount();
    const { cycle } = await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 30 * 60 * 1000,
    });

    await csatService.sendPendingCsatMessages();

    const reloaded = await prismaTest.conversationCycle.findUnique({
      where: { id: cycle.id },
    });
    expect(reloaded?.csatSentAt).not.toBeNull();
  });
});

describe('csatService.parseCustomerResponse', () => {
  it('grava customerCsat=5 quando msg=5 em ciclo com csat pendente', async () => {
    const { account } = await createTestAccount();
    const { conv, cycle } = await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 60 * 60 * 1000,
      csatSentAt: new Date(Date.now() - 5 * 60 * 1000), // ja perguntou 5min atras
    });

    const result = await csatService.parseCustomerResponse(conv.id, account.id, '5');
    expect(result.matched).toBe(true);
    expect(result.rating).toBe(5);
    expect(result.cycleId).toBe(cycle.id);

    const reloaded = await prismaTest.conversationCycle.findUnique({
      where: { id: cycle.id },
    });
    expect(reloaded?.customerCsat).toBe(5);
    expect(reloaded?.customerCsatAt).not.toBeNull();
  });

  it('no-op quando ciclo nao teve csat enviado', async () => {
    const { account } = await createTestAccount();
    const { conv } = await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 60 * 60 * 1000,
      csatSentAt: null, // nunca perguntou
    });

    const result = await csatService.parseCustomerResponse(conv.id, account.id, '5');
    expect(result.matched).toBe(false);
  });

  it('no-op quando texto nao for rating', async () => {
    const { account } = await createTestAccount();
    const { conv } = await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 60 * 60 * 1000,
      csatSentAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    const result = await csatService.parseCustomerResponse(
      conv.id,
      account.id,
      'quero falar com vendedor'
    );
    expect(result.matched).toBe(false);
    expect(result.rating).toBeNull();
  });

  it('no-op quando customerCsat ja gravado (evita duplicata)', async () => {
    const { account } = await createTestAccount();
    const { conv, cycle } = await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 60 * 60 * 1000,
      csatSentAt: new Date(Date.now() - 5 * 60 * 1000),
      customerCsat: 3, // ja respondeu
    });

    const result = await csatService.parseCustomerResponse(conv.id, account.id, '5');
    expect(result.matched).toBe(false);

    const reloaded = await prismaTest.conversationCycle.findUnique({
      where: { id: cycle.id },
    });
    // Manteve valor original
    expect(reloaded?.customerCsat).toBe(3);
  });
});

describe('csatService.sendCsatNow — SLA v2.1', () => {
  it('cria msg system + seta csatSentAt em ciclo elegivel', async () => {
    const { account } = await createTestAccount();
    const { conv, cycle } = await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 60 * 60 * 1000,
      csatSentAt: null,
    });

    const result = await csatService.sendCsatNow(conv.id, account.id);

    expect(result.sent).toBe(true);
    expect(result.cycleId).toBe(cycle.id);
    expect(result.sentAt).toBeInstanceOf(Date);
    expect(result.messageText).toMatch(/avalia/i);

    // Cria msg system
    expect(messageService.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(messageService.create).mock.calls[0];
    expect(call[0]).toBe(account.id);
    expect(call[1].senderType).toBe('system');
    expect(call[1].conversationId).toBe(conv.id);
    expect(call[1].metadata).toMatchObject({
      csat_request: true,
      cycleId: cycle.id,
      source: 'csat_service.sendCsatNow',
    });

    // Persiste csatSentAt + csatRequested no cycle
    const reloaded = await prismaTest.conversationCycle.findUnique({
      where: { id: cycle.id },
    });
    expect(reloaded?.csatSentAt).not.toBeNull();
    expect(reloaded?.csatRequested).toBe(true);
  });

  it('lanca ConflictError quando cycle ja tem csatSentAt setado', async () => {
    const { account } = await createTestAccount();
    const { conv } = await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 60 * 60 * 1000,
      csatSentAt: new Date(Date.now() - 10 * 60 * 1000), // ja enviado 10min atras
    });

    await expect(
      csatService.sendCsatNow(conv.id, account.id)
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });

    // Nao chamou messageService.create
    expect(messageService.create).not.toHaveBeenCalled();
  });

  it('com force=true reenvia mesmo se csatSentAt ja setado', async () => {
    const { account } = await createTestAccount();
    const { conv, cycle } = await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 60 * 60 * 1000,
      csatSentAt: new Date(Date.now() - 60 * 60 * 1000), // 1h atras
    });

    const result = await csatService.sendCsatNow(conv.id, account.id, {
      force: true,
    });

    expect(result.sent).toBe(true);
    expect(result.cycleId).toBe(cycle.id);
    expect(messageService.create).toHaveBeenCalledTimes(1);

    // Atualiza csatSentAt pro now (reenvio explicito)
    const reloaded = await prismaTest.conversationCycle.findUnique({
      where: { id: cycle.id },
    });
    expect(reloaded?.csatSentAt!.getTime()).toBeGreaterThan(
      Date.now() - 5_000
    );
  });

  it('com customMessage usa texto custom em vez do padrao', async () => {
    const { account } = await createTestAccount();
    const { conv } = await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 60 * 60 * 1000,
      csatSentAt: null,
    });

    const customText = 'De 1 a 5, como foi sua experiencia hoje?';
    const result = await csatService.sendCsatNow(conv.id, account.id, {
      customMessage: customText,
    });

    expect(result.messageText).toBe(customText);
    const call = vi.mocked(messageService.create).mock.calls[0];
    expect(call[1].content).toBe(customText);
  });

  it('lanca NotFoundError quando conversation nao existe ou eh de outra conta', async () => {
    const { account } = await createTestAccount();
    const fakeId = '00000000-0000-0000-0000-000000000000';

    await expect(
      csatService.sendCsatNow(fakeId, account.id)
    ).rejects.toMatchObject({
      statusCode: 404,
    });

    expect(messageService.create).not.toHaveBeenCalled();
  });

  it('lanca NotFoundError quando conversation existe mas nao tem cycle', async () => {
    const { account } = await createTestAccount();
    const inbox = await prismaTest.inbox.create({
      data: {
        accountId: account.id,
        name: 'Inbox sem cycle',
        channelType: 'whatsapp',
        evolutionInstance: `inst-no-cycle-${Date.now()}`,
      },
    });
    const conv = await prismaTest.conversation.create({
      data: {
        accountId: account.id,
        inboxId: inbox.id,
        status: 'open',
      },
    });

    await expect(
      csatService.sendCsatNow(conv.id, account.id)
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  // BUG-001: dispatch via Evolution. Antes, sendCsatNow so persistia Message.
  it('BUG-001: dispara via evolutionService.sendText (Evolution real)', async () => {
    const { account } = await createTestAccount();
    const { conv } = await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 60 * 60 * 1000,
      csatSentAt: null,
    });

    await csatService.sendCsatNow(conv.id, account.id);

    expect(evolutionService.sendText).toHaveBeenCalledTimes(1);
    const call = vi.mocked(evolutionService.sendText).mock.calls[0];
    expect(call[0]).toBe(account.id);
    expect(call[1].number).toBe('5534993383017');
    expect(call[1].text).toMatch(/avalia/i);
  });

  // BUG-025: validacao de pre-dispatch.
  it('BUG-025: rejeita CSAT em inbox nao-whatsapp', async () => {
    const { account } = await createTestAccount();
    const inbox = await prismaTest.inbox.create({
      data: {
        accountId: account.id,
        name: 'Inbox email',
        channelType: 'email',
        evolutionInstance: null,
      },
    });
    const contact = await prismaTest.contact.create({
      data: { accountId: account.id, nome: 'X', telefone: '5534993383017' },
    });
    const conv = await prismaTest.conversation.create({
      data: {
        accountId: account.id,
        inboxId: inbox.id,
        contactId: contact.id,
        status: 'resolved',
      },
    });
    await prismaTest.conversationCycle.create({
      data: {
        accountId: account.id,
        conversationId: conv.id,
        openedAt: new Date(),
        resolvedAt: new Date(),
        resolvedBy: 'human',
        outcome: 'resolved',
        csatRequested: true,
      },
    });

    await expect(
      csatService.sendCsatNow(conv.id, account.id)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(evolutionService.sendText).not.toHaveBeenCalled();
  });

  // BUG-004: race condition. 5 calls paralelas -> apenas 1 dispatcha.
  it('BUG-004: race protection — 5 calls paralelas geram apenas 1 dispatch', async () => {
    const { account } = await createTestAccount();
    const { conv } = await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 60 * 60 * 1000,
      csatSentAt: null,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        csatService.sendCsatNow(conv.id, account.id)
      )
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(4);
    // Apenas 1 dispatch real para o cliente — sem spam WhatsApp.
    expect(evolutionService.sendText).toHaveBeenCalledTimes(1);
  });
});

// BUG-002: cron sendPendingCsatMessages claim antes do dispatch.
describe('csatService.sendPendingCsatMessages — BUG-002 (no retry storm)', () => {
  it('marca csatSentAt MESMO quando Evolution falha (evita retry storm)', async () => {
    vi.mocked(evolutionService.sendText).mockRejectedValueOnce(
      new Error('evolution_429_rate_limit')
    );

    const { account } = await createTestAccount();
    const { cycle } = await createConvWithCycle(account.id, {
      resolvedAtAgoMs: 30 * 60 * 1000,
    });

    const result = await csatService.sendPendingCsatMessages();
    expect(result.failed).toBe(1);

    const reloaded = await prismaTest.conversationCycle.findUnique({
      where: { id: cycle.id },
    });
    // Mesmo com falha, csatSentAt foi setado — cron nao re-tenta em loop.
    expect(reloaded?.csatSentAt).not.toBeNull();
  });
});
