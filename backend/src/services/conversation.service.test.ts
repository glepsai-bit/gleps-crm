/**
 * Conversation service — SLA v2 resolve() tests.
 *
 * Cobre:
 *  - resolve com outcome valido: persiste outcome em ConversationCycle
 *  - resolve sem outcome no controller: 400 (testado em integration-chat.controller.test)
 *  - resolve service-level com outcome invalido: ValidationError
 *  - resolve com internalRating fora de 1-5: ValidationError
 *  - resolve com sendCsatToCustomer=true: csatRequested=true no cycle
 *  - resolve via api-key marca resolvedBy='ai' (testado em integration-chat tests)
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./evolution.service', () => ({
  evolutionService: {
    sendText: vi.fn(async () => ({ messageId: 'mock' })),
    sendMedia: vi.fn(async () => ({ messageId: 'mock' })),
    sendAudio: vi.fn(async () => ({ messageId: 'mock' })),
  },
}));

import { prismaTest } from '../test/setup';
import { createTestAccount } from '../test/helpers';
import { conversationService } from './conversation.service';
import { conversationCycleService } from './conversation-cycle.service';

async function createConvOpen(accountId: string, userId: string) {
  const inbox = await prismaTest.inbox.create({
    data: {
      accountId,
      name: 'Inbox Conv',
      channelType: 'whatsapp',
      evolutionInstance: `inst-${Date.now()}-${Math.random()}`,
    },
  });
  const conv = await prismaTest.conversation.create({
    data: {
      accountId,
      inboxId: inbox.id,
      status: 'open',
    },
  });
  // Abre um ciclo
  await conversationCycleService.openCycle(conv.id, accountId);
  return { inbox, conv };
}

describe('ConversationService.resolve — SLA v2', () => {
  it('resolve com outcome valido: persiste outcome em ConversationCycle', async () => {
    const { account, user } = await createTestAccount();
    const { conv } = await createConvOpen(account.id, user.id);

    const resolved = await conversationService.resolve(conv.id, account.id, {
      resolvedBy: 'human',
      userId: user.id,
      outcome: 'transferred',
      reason: 'Cliente vai falar com financeiro',
      sendCsatToCustomer: false,
    });
    expect(resolved.status).toBe('resolved');

    const cycles = await prismaTest.conversationCycle.findMany({
      where: { conversationId: conv.id },
    });
    expect(cycles.length).toBe(1);
    expect(cycles[0].outcome).toBe('transferred');
    expect(cycles[0].resolveReason).toBe('Cliente vai falar com financeiro');
    expect(cycles[0].csatRequested).toBe(false);
  });

  it('resolve com outcome invalido (service-level): ValidationError', async () => {
    const { account, user } = await createTestAccount();
    const { conv } = await createConvOpen(account.id, user.id);

    await expect(
      conversationService.resolve(conv.id, account.id, {
        resolvedBy: 'human',
        userId: user.id,
        outcome: 'invalid_outcome' as any,
      })
    ).rejects.toThrow(/outcome/i);
  });

  it('resolve com rating 6 (fora de 1-5): ValidationError', async () => {
    const { account, user } = await createTestAccount();
    const { conv } = await createConvOpen(account.id, user.id);

    await expect(
      conversationService.resolve(conv.id, account.id, {
        resolvedBy: 'human',
        userId: user.id,
        outcome: 'resolved',
        internalRating: 6,
      })
    ).rejects.toThrow(/internalRating/i);
  });

  it('resolve com rating 0 (zero invalido): ValidationError', async () => {
    const { account, user } = await createTestAccount();
    const { conv } = await createConvOpen(account.id, user.id);

    await expect(
      conversationService.resolve(conv.id, account.id, {
        resolvedBy: 'human',
        userId: user.id,
        outcome: 'resolved',
        internalRating: 0,
      })
    ).rejects.toThrow(/internalRating/i);
  });

  it('resolve com sendCsatToCustomer=true: csatRequested=true no cycle', async () => {
    const { account, user } = await createTestAccount();
    const { conv } = await createConvOpen(account.id, user.id);

    await conversationService.resolve(conv.id, account.id, {
      resolvedBy: 'human',
      userId: user.id,
      outcome: 'resolved',
      sendCsatToCustomer: true,
    });

    const cycle = await prismaTest.conversationCycle.findFirst({
      where: { conversationId: conv.id },
    });
    expect(cycle?.csatRequested).toBe(true);
  });

  it('resolve com internalRating valido (1-5): grava no cycle', async () => {
    const { account, user } = await createTestAccount();
    const { conv } = await createConvOpen(account.id, user.id);

    await conversationService.resolve(conv.id, account.id, {
      resolvedBy: 'human',
      userId: user.id,
      outcome: 'resolved',
      internalRating: 4,
    });

    const cycle = await prismaTest.conversationCycle.findFirst({
      where: { conversationId: conv.id },
    });
    expect(cycle?.internalRating).toBe(4);
  });

  it('resolve com resolvedBy=ai: resolvedByUserId fica null por default', async () => {
    const { account, user } = await createTestAccount();
    const { conv } = await createConvOpen(account.id, user.id);

    await conversationService.resolve(conv.id, account.id, {
      resolvedBy: 'ai',
      userId: user.id,
      outcome: 'resolved',
    });

    const cycle = await prismaTest.conversationCycle.findFirst({
      where: { conversationId: conv.id },
    });
    expect(cycle?.resolvedBy).toBe('ai');
    expect(cycle?.resolvedByUserId).toBeNull();
  });
});
