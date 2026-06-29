/**
 * SLA v2 — service tests.
 *
 * Cobre:
 *  - checkBreaches com businessHoursStart='09:00' end='18:00':
 *    conversa criada 22h, ainda nao estourou na manha seguinte
 *  - checkBreaches com pauseWhenWaitingCustomer: agente respondeu, cronometro
 *    pausa, nao breach
 *  - getDashboard agrega corretamente outcomes
 *  - getDashboard csatAvg ignora null
 *  - calculateBusinessElapsedSec helper unitario
 */

import { describe, it, expect, vi } from 'vitest';

// Mock evolution antes de qualquer import que possa carregar a chain
vi.mock('./evolution.service', () => ({
  evolutionService: {
    sendText: vi.fn(async () => ({ messageId: 'mock' })),
    sendMedia: vi.fn(async () => ({ messageId: 'mock' })),
    sendAudio: vi.fn(async () => ({ messageId: 'mock' })),
  },
}));

import { prismaTest } from '../test/setup';
import { createTestAccount } from '../test/helpers';
import { slaService, calculateBusinessElapsedSec } from './sla.service';

async function createInbox(accountId: string) {
  return prismaTest.inbox.create({
    data: {
      accountId,
      name: 'Inbox SLA',
      channelType: 'whatsapp',
      evolutionInstance: `inst-${Date.now()}`,
    },
  });
}

async function createPolicy(
  accountId: string,
  overrides: Partial<{
    firstResponseMin: number;
    resolutionMin: number;
    pauseWhenWaitingCustomer: boolean;
    businessHoursStart: string | null;
    businessHoursEnd: string | null;
    businessDays: number[];
    timezone: string;
    name: string;
  }> = {}
) {
  return prismaTest.sLAPolicy.create({
    data: {
      accountId,
      name: overrides.name ?? `pol-${Date.now()}-${Math.random()}`,
      firstResponseMin: overrides.firstResponseMin ?? 30,
      resolutionMin: overrides.resolutionMin ?? 60,
      pauseWhenWaitingCustomer: overrides.pauseWhenWaitingCustomer ?? false,
      businessHoursStart: overrides.businessHoursStart ?? null,
      businessHoursEnd: overrides.businessHoursEnd ?? null,
      businessDays: overrides.businessDays ?? [1, 2, 3, 4, 5],
      timezone: overrides.timezone ?? 'America/Sao_Paulo',
    },
  });
}

describe('calculateBusinessElapsedSec', () => {
  it('sem businessHoursStart/End: retorna elapsed puro', () => {
    const from = new Date('2026-01-15T10:00:00Z');
    const to = new Date('2026-01-15T10:01:00Z');
    const policy = {
      businessHoursStart: null,
      businessHoursEnd: null,
      businessDays: [1, 2, 3, 4, 5],
      timezone: 'America/Sao_Paulo',
    } as any;
    expect(calculateBusinessElapsedSec(from, to, policy)).toBe(60);
  });

  it('com horario comercial 09:00-18:00 BRT: 22h-08:00 BRT nao conta', () => {
    // 22:00 BRT do dia X → 08:00 BRT do dia X+1 = 10 horas reais.
    // Nenhum minuto dentro de [09:00, 18:00) → resultado 0.
    // 22:00 BRT = 01:00 UTC (BRT = UTC-3)
    const from = new Date('2026-01-15T01:00:00Z'); // 22:00 BRT dia 14
    const to = new Date('2026-01-15T11:00:00Z'); // 08:00 BRT dia 15
    const policy = {
      businessHoursStart: '09:00',
      businessHoursEnd: '18:00',
      businessDays: [1, 2, 3, 4, 5],
      timezone: 'America/Sao_Paulo',
    } as any;
    const sec = calculateBusinessElapsedSec(from, to, policy);
    expect(sec).toBe(0);
  });

  it('com horario comercial 09:00-18:00: 14:00-15:00 BRT em dia util = 3600s', () => {
    // 14:00 BRT = 17:00 UTC
    const from = new Date('2026-01-15T17:00:00Z'); // quinta 14:00 BRT
    const to = new Date('2026-01-15T18:00:00Z'); // quinta 15:00 BRT
    const policy = {
      businessHoursStart: '09:00',
      businessHoursEnd: '18:00',
      businessDays: [1, 2, 3, 4, 5],
      timezone: 'America/Sao_Paulo',
    } as any;
    const sec = calculateBusinessElapsedSec(from, to, policy);
    // Walk minuto-a-minuto soma ~60 minutos
    expect(sec).toBeGreaterThanOrEqual(60 * 59);
    expect(sec).toBeLessThanOrEqual(60 * 61);
  });
});

describe('SLAService.checkBreaches — SLA v2', () => {
  it('com businessHoursStart=09:00 end=18:00 e conversa criada 22h: NAO estoura na manha seguinte', async () => {
    const { account } = await createTestAccount();
    const inbox = await createInbox(account.id);
    const policy = await createPolicy(account.id, {
      firstResponseMin: 30,
      resolutionMin: 60,
      businessHoursStart: '09:00',
      businessHoursEnd: '18:00',
      businessDays: [1, 2, 3, 4, 5],
      timezone: 'America/Sao_Paulo',
    });

    // Conversa criada 22:00 BRT (= 01:00 UTC) de uma quarta-feira
    const createdAt = new Date('2026-01-14T01:00:00Z'); // qua 22:00 BRT do dia 13
    await prismaTest.conversation.create({
      data: {
        accountId: account.id,
        inboxId: inbox.id,
        status: 'open',
        slaPolicyId: policy.id,
        createdAt,
      },
    });

    // "Manha seguinte" = 08:00 BRT (= 11:00 UTC) — antes do start 09:00
    const nowMorning = new Date('2026-01-14T11:00:00Z');
    const result = await slaService.checkBreaches(nowMorning);
    expect(result.detected).toBe(0);

    const breaches = await prismaTest.sLABreach.findMany();
    expect(breaches.length).toBe(0);
  });

  it('com pauseWhenWaitingCustomer=true: agente respondeu, cronometro pausa, NAO breach', async () => {
    const { account } = await createTestAccount();
    const inbox = await createInbox(account.id);
    const policy = await createPolicy(account.id, {
      firstResponseMin: 5,
      resolutionMin: 10,
      pauseWhenWaitingCustomer: true,
    });

    const createdAt = new Date(Date.now() - 60 * 60 * 1000); // 1h atras
    const conv = await prismaTest.conversation.create({
      data: {
        accountId: account.id,
        inboxId: inbox.id,
        status: 'open',
        slaPolicyId: policy.id,
        createdAt,
        firstResponseAt: new Date(Date.now() - 55 * 60 * 1000), // ja respondeu (5min apos criar)
      },
    });

    // Mensagem do customer (1h atras = createdAt)
    await prismaTest.message.create({
      data: {
        conversationId: conv.id,
        senderType: 'customer',
        content: 'oi',
        contentType: 'text',
        createdAt,
        isPrivate: false,
      },
    });
    // Resposta do agente 50min atras — cronometro pausa daqui em diante
    await prismaTest.message.create({
      data: {
        conversationId: conv.id,
        senderType: 'agent',
        content: 'resposta',
        contentType: 'text',
        createdAt: new Date(Date.now() - 50 * 60 * 1000),
        isPrivate: false,
      },
    });

    const result = await slaService.checkBreaches();
    // 50min "pausado" — elapsed efetivo eh 10min (criado a 1h, ultima msg agente foi 50min atras)
    // resolutionMin=10. 10 > 10*60? 600 > 600 = false. NAO breach.
    expect(result.detected).toBe(0);
  });

  it('SEM pauseWhenWaitingCustomer: ja teria estourado (controle)', async () => {
    const { account } = await createTestAccount();
    const inbox = await createInbox(account.id);
    const policy = await createPolicy(account.id, {
      firstResponseMin: 5,
      resolutionMin: 10,
      pauseWhenWaitingCustomer: false,
    });

    const createdAt = new Date(Date.now() - 60 * 60 * 1000);
    await prismaTest.conversation.create({
      data: {
        accountId: account.id,
        inboxId: inbox.id,
        status: 'open',
        slaPolicyId: policy.id,
        createdAt,
        firstResponseAt: new Date(Date.now() - 55 * 60 * 1000),
      },
    });

    const result = await slaService.checkBreaches();
    // sem pausa: 60 min elapsed > 10 min resolution = breach
    expect(result.detected).toBeGreaterThan(0);
  });
});

describe('SLAService.getDashboard — SLA v2', () => {
  it('agrega outcomes corretamente', async () => {
    const { account } = await createTestAccount();
    const inbox = await createInbox(account.id);

    // Cria 3 conversas + 3 ciclos resolvidos com outcomes diferentes
    const outcomes = ['resolved', 'transferred', 'spam'];
    for (const oc of outcomes) {
      const conv = await prismaTest.conversation.create({
        data: { accountId: account.id, inboxId: inbox.id, status: 'resolved' },
      });
      await prismaTest.conversationCycle.create({
        data: {
          accountId: account.id,
          conversationId: conv.id,
          openedAt: new Date(Date.now() - 60 * 1000),
          resolvedAt: new Date(),
          resolvedBy: 'human',
          outcome: oc,
          durationSec: 60,
        },
      });
    }

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 60 * 1000);
    const dash = await slaService.getDashboard(account.id, { fromDate: from, toDate: to });
    expect(dash.outcomes.resolved).toBe(1);
    expect(dash.outcomes.transferred).toBe(1);
    expect(dash.outcomes.spam).toBe(1);
    expect(dash.totalConversations).toBe(3);
  });

  it('csatAvg ignora null — soh conta respostas reais', async () => {
    const { account } = await createTestAccount();
    const inbox = await createInbox(account.id);

    // 3 ciclos: 2 com customerCsat (4, 5), 1 null
    const csats = [4, 5, null];
    for (const csat of csats) {
      const conv = await prismaTest.conversation.create({
        data: { accountId: account.id, inboxId: inbox.id, status: 'resolved' },
      });
      await prismaTest.conversationCycle.create({
        data: {
          accountId: account.id,
          conversationId: conv.id,
          openedAt: new Date(Date.now() - 60 * 1000),
          resolvedAt: new Date(),
          resolvedBy: 'human',
          outcome: 'resolved',
          customerCsat: csat ?? null,
          csatSentAt: csat !== null ? new Date() : null,
          durationSec: 60,
        },
      });
    }

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 60 * 1000);
    const dash = await slaService.getDashboard(account.id, { fromDate: from, toDate: to });
    // Media de (4, 5) = 4.5
    expect(dash.csatAvg).toBe(4.5);
    // csatResponseRate = respondidos(2) / pedidos(2) = 1.0
    expect(dash.csatResponseRate).toBe(1);
  });

  it('aiVsHuman separa ciclos resolvidos por IA vs humano', async () => {
    const { account } = await createTestAccount();
    const inbox = await createInbox(account.id);

    // 2 ciclos por IA, 1 por humano
    for (let i = 0; i < 2; i++) {
      const conv = await prismaTest.conversation.create({
        data: { accountId: account.id, inboxId: inbox.id, status: 'resolved' },
      });
      await prismaTest.conversationCycle.create({
        data: {
          accountId: account.id,
          conversationId: conv.id,
          openedAt: new Date(Date.now() - 60 * 1000),
          resolvedAt: new Date(),
          resolvedBy: 'ai',
          outcome: 'resolved',
          durationSec: 60,
        },
      });
    }
    const conv2 = await prismaTest.conversation.create({
      data: { accountId: account.id, inboxId: inbox.id, status: 'resolved' },
    });
    await prismaTest.conversationCycle.create({
      data: {
        accountId: account.id,
        conversationId: conv2.id,
        openedAt: new Date(Date.now() - 60 * 1000),
        resolvedAt: new Date(),
        resolvedBy: 'human',
        outcome: 'resolved',
        durationSec: 60,
      },
    });

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 60 * 1000);
    const dash = await slaService.getDashboard(account.id, { fromDate: from, toDate: to });
    expect(dash.aiVsHuman.ai.resolved).toBe(2);
    expect(dash.aiVsHuman.human.resolved).toBe(1);
  });

  it('SLA v2.1: csatAvg IGNORA internalRating (auxiliar nao oficial)', async () => {
    const { account } = await createTestAccount();
    const inbox = await createInbox(account.id);

    // 3 ciclos com internalRating BAIXO mas customerCsat ALTO — csatAvg do
    // dashboard deve refletir SO customerCsat. Caso internalRating estivesse
    // sendo misturado, a media puxaria pra baixo.
    const samples = [
      { internal: 1, customer: 5 },
      { internal: 2, customer: 5 },
      { internal: 1, customer: 4 },
    ];
    for (const s of samples) {
      const conv = await prismaTest.conversation.create({
        data: { accountId: account.id, inboxId: inbox.id, status: 'resolved' },
      });
      await prismaTest.conversationCycle.create({
        data: {
          accountId: account.id,
          conversationId: conv.id,
          openedAt: new Date(Date.now() - 60 * 1000),
          resolvedAt: new Date(),
          resolvedBy: 'human',
          outcome: 'resolved',
          internalRating: s.internal,
          customerCsat: s.customer,
          csatSentAt: new Date(),
          durationSec: 60,
        },
      });
    }

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 60 * 1000);
    const dash = await slaService.getDashboard(account.id, { fromDate: from, toDate: to });

    // csatAvg = AVG(customerCsat) = (5+5+4)/3 = 4.67 (round 100x)
    expect(dash.csatAvg).toBe(4.67);
    // internalRatingAvg eh exposto separado = (1+2+1)/3 = 1.33
    expect(dash.internalRatingAvg).toBe(1.33);
  });

  it('SLA v2.1: aiVsHuman.csat usa SO customerCsat (nao internalRating)', async () => {
    const { account } = await createTestAccount();
    const inbox = await createInbox(account.id);

    // IA: customerCsat=[5,5], internalRating=[1,1]
    for (let i = 0; i < 2; i++) {
      const conv = await prismaTest.conversation.create({
        data: { accountId: account.id, inboxId: inbox.id, status: 'resolved' },
      });
      await prismaTest.conversationCycle.create({
        data: {
          accountId: account.id,
          conversationId: conv.id,
          openedAt: new Date(Date.now() - 60 * 1000),
          resolvedAt: new Date(),
          resolvedBy: 'ai',
          outcome: 'resolved',
          internalRating: 1,
          customerCsat: 5,
          csatSentAt: new Date(),
          durationSec: 60,
        },
      });
    }
    // Humano: customerCsat=[3], internalRating=[5]
    const convH = await prismaTest.conversation.create({
      data: { accountId: account.id, inboxId: inbox.id, status: 'resolved' },
    });
    await prismaTest.conversationCycle.create({
      data: {
        accountId: account.id,
        conversationId: convH.id,
        openedAt: new Date(Date.now() - 60 * 1000),
        resolvedAt: new Date(),
        resolvedBy: 'human',
        outcome: 'resolved',
        internalRating: 5,
        customerCsat: 3,
        csatSentAt: new Date(),
        durationSec: 60,
      },
    });

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 60 * 1000);
    const dash = await slaService.getDashboard(account.id, { fromDate: from, toDate: to });

    // aiVsHuman comparado por customerCsat (NAO internalRating)
    expect(dash.aiVsHuman.ai.csat).toBe(5); // (5+5)/2
    expect(dash.aiVsHuman.human.csat).toBe(3);
  });

  it('SLA v2.1: csatAvg null quando so ha internalRating (sem cliente respondendo)', async () => {
    const { account } = await createTestAccount();
    const inbox = await createInbox(account.id);

    // 2 ciclos so com internalRating (cliente nao respondeu nada)
    for (let i = 0; i < 2; i++) {
      const conv = await prismaTest.conversation.create({
        data: { accountId: account.id, inboxId: inbox.id, status: 'resolved' },
      });
      await prismaTest.conversationCycle.create({
        data: {
          accountId: account.id,
          conversationId: conv.id,
          openedAt: new Date(Date.now() - 60 * 1000),
          resolvedAt: new Date(),
          resolvedBy: 'human',
          outcome: 'resolved',
          internalRating: 5,
          customerCsat: null,
          csatSentAt: null,
          durationSec: 60,
        },
      });
    }

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 60 * 1000);
    const dash = await slaService.getDashboard(account.id, { fromDate: from, toDate: to });

    // SLA: sem customerCsat respondido = null (NAO usa internalRating)
    expect(dash.csatAvg).toBeNull();
    // Auxiliar internalRatingAvg eh = 5
    expect(dash.internalRatingAvg).toBe(5);
  });
});
