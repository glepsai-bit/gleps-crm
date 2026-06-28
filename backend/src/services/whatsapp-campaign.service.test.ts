/**
 * AREA T5 — whatsapp-campaign service
 *
 * Cobre sendBatch (agendado/passado/vazio/limite),
 * pause/resume (prospecting), cancelScheduled e
 * recoverOrphanRunningBatches.
 *
 * evolutionService.sendText eh mockado pra nao chamar HTTP real.
 *
 * NOTA: usa um mini-factory `createAccount()` direto via prismaTest em vez de
 * createTestAccount(), pois esses testes nao precisam de JWT/login (chamam o
 * service direto) — evita-se a interferencia do authService.login que dispara
 * eventService.create (que faz writes adicionais) em loop pelos varios it().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock evolution.service ANTES de qualquer import do servico (vi.mock eh hoisted)
vi.mock('../services/evolution.service', () => ({
  evolutionService: {
    sendText: vi.fn(async () => ({ messageId: 'evo-msg-test' })),
  },
}));

import { prismaTest } from '../test/setup';
import { whatsappCampaignService } from './whatsapp-campaign.service';
import { prospectingService } from './prospecting.service';
import { ValidationError, NotFoundError, AppError } from '../utils/errors';

beforeEach(() => {
  vi.clearAllMocks();
});

async function createAccount(name = 'Test Account') {
  return prismaTest.account.create({ data: { nome: name } });
}

/**
 * Helper de matching de erro: como AppError usa Object.setPrototypeOf(this, AppError.prototype)
 * no construtor pai, instanceof ValidationError sempre retorna FALSE — todas as
 * subclasses sao "tecnicamente" AppError. Validamos por statusCode/code.
 */
function expectValidationError(err: unknown) {
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).statusCode).toBe(400);
  expect((err as AppError).code).toBe('VALIDATION_ERROR');
}

function expectNotFoundError(err: unknown) {
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).statusCode).toBe(404);
  expect((err as AppError).code).toBe('NOT_FOUND');
}

describe('whatsapp-campaign.service.sendBatch', () => {
  it('com scheduledAt futuro: cria batch status=scheduled e NAO chama evolution', async () => {
    const account = await createAccount();

    const future = new Date(Date.now() + 60 * 60_000);

    const res = await whatsappCampaignService.sendBatch(account.id, {
      phones: [{ phone: '5534993383017', name: 'Teste' }],
      content: 'Ola {nome}',
      scheduledAt: future,
      source: 'manual_scheduled',
    });

    expect(res.scheduled).toBe(true);
    expect(res.batchId).toBeTruthy();

    const batch = await prismaTest.dispatchBatch.findUnique({
      where: { id: res.batchId },
    });
    expect(batch?.status).toBe('scheduled');
    const { evolutionService } = await import('../services/evolution.service');
    expect((evolutionService.sendText as any)).not.toHaveBeenCalled();
  });

  it('com scheduledAt no passado: throw ValidationError "scheduledAt deve ser futuro"', async () => {
    const account = await createAccount();

    const past = new Date(Date.now() - 60_000);

    const err = await whatsappCampaignService
      .sendBatch(account.id, {
        phones: [{ phone: '5534993383017' }],
        content: 'Ola',
        scheduledAt: past,
        source: 'manual_scheduled',
      })
      .catch(e => e);

    expectValidationError(err);
    expect((err as AppError).message).toMatch(/scheduledAt|futuro/i);
  });

  it('com phones vazio E contactIds vazio: throw ValidationError', async () => {
    const account = await createAccount();

    const err = await whatsappCampaignService
      .sendBatch(account.id, {
        phones: [],
        contactIds: [],
        content: 'Ola',
        source: 'manual',
      })
      .catch(e => e);

    expectValidationError(err);
  });

  it('sem templateId nem content: throw ValidationError', async () => {
    const account = await createAccount();

    const err = await whatsappCampaignService
      .sendBatch(account.id, {
        phones: [{ phone: '5534993383017' }],
        source: 'manual',
      } as any)
      .catch(e => e);

    expectValidationError(err);
  });

  it('com templateId inexistente: throw NotFoundError', async () => {
    const account = await createAccount();
    const fakeTemplateId = '00000000-0000-0000-0000-000000000099';

    const err = await whatsappCampaignService
      .sendBatch(account.id, {
        phones: [{ phone: '5534993383017' }],
        templateId: fakeTemplateId,
        source: 'manual',
      })
      .catch(e => e);

    expectNotFoundError(err);
  });
});

describe('prospectingService.pauseBatch / resumeBatchFromPause', () => {
  it('pauseBatch: scheduled -> paused via updateMany atomico', async () => {
    const account = await createAccount();

    const batch = await prismaTest.dispatchBatch.create({
      data: {
        accountId: account.id,
        totalContacts: 1,
        status: 'scheduled',
        scheduledAt: new Date(Date.now() + 60 * 60_000),
        delaySeconds: 30,
        source: 'manual_scheduled',
      },
    });

    const res = await prospectingService.pauseBatch(account.id, batch.id);
    expect(res.status).toBe('paused');

    const updated = await prismaTest.dispatchBatch.findUnique({
      where: { id: batch.id },
    });
    expect(updated?.status).toBe('paused');
  });

  it('pauseBatch em batch completed: throw ValidationError', async () => {
    const account = await createAccount();

    const batch = await prismaTest.dispatchBatch.create({
      data: {
        accountId: account.id,
        totalContacts: 1,
        status: 'completed',
        delaySeconds: 30,
        source: 'manual',
      },
    });

    const err = await prospectingService
      .pauseBatch(account.id, batch.id)
      .catch(e => e);
    expectValidationError(err);
  });

  it('pauseBatch em batch inexistente: throw NotFoundError', async () => {
    const account = await createAccount();
    const fakeId = '00000000-0000-0000-0000-000000000123';

    const err = await prospectingService.pauseBatch(account.id, fakeId).catch(e => e);
    expectNotFoundError(err);
  });

  it('resumeBatchFromPause: paused -> scheduled', async () => {
    const account = await createAccount();

    const batch = await prismaTest.dispatchBatch.create({
      data: {
        accountId: account.id,
        totalContacts: 1,
        status: 'paused',
        scheduledAt: new Date(Date.now() + 60 * 60_000),
        delaySeconds: 30,
        source: 'manual_scheduled',
      },
    });

    const res = await prospectingService.resumeBatchFromPause(account.id, batch.id);
    expect(res.status).toBe('scheduled');

    const updated = await prismaTest.dispatchBatch.findUnique({
      where: { id: batch.id },
    });
    expect(updated?.status).toBe('scheduled');
  });

  it('resumeBatchFromPause em batch nao-paused: throw ValidationError', async () => {
    const account = await createAccount();

    const batch = await prismaTest.dispatchBatch.create({
      data: {
        accountId: account.id,
        totalContacts: 1,
        status: 'scheduled',
        scheduledAt: new Date(Date.now() + 60 * 60_000),
        delaySeconds: 30,
        source: 'manual_scheduled',
      },
    });

    const err = await prospectingService
      .resumeBatchFromPause(account.id, batch.id)
      .catch(e => e);
    expectValidationError(err);
  });
});

describe('whatsapp-campaign.service.cancelScheduled', () => {
  it('cancela batch scheduled', async () => {
    const account = await createAccount();

    const batch = await prismaTest.dispatchBatch.create({
      data: {
        accountId: account.id,
        totalContacts: 1,
        status: 'scheduled',
        scheduledAt: new Date(Date.now() + 60 * 60_000),
        delaySeconds: 30,
        source: 'manual_scheduled',
      },
    });

    await whatsappCampaignService.cancelScheduled(batch.id, account.id);

    const updated = await prismaTest.dispatchBatch.findUnique({
      where: { id: batch.id },
    });
    expect(updated?.status).toBe('cancelled');
    expect(updated?.completedAt).not.toBeNull();
  });

  it('cancela batch paused', async () => {
    const account = await createAccount();

    const batch = await prismaTest.dispatchBatch.create({
      data: {
        accountId: account.id,
        totalContacts: 1,
        status: 'paused',
        scheduledAt: new Date(Date.now() + 60 * 60_000),
        delaySeconds: 30,
        source: 'manual_scheduled',
      },
    });

    await whatsappCampaignService.cancelScheduled(batch.id, account.id);

    const updated = await prismaTest.dispatchBatch.findUnique({
      where: { id: batch.id },
    });
    expect(updated?.status).toBe('cancelled');
  });

  it('cancela batch running', async () => {
    const account = await createAccount();

    const batch = await prismaTest.dispatchBatch.create({
      data: {
        accountId: account.id,
        totalContacts: 1,
        status: 'running',
        delaySeconds: 30,
        source: 'manual',
      },
    });

    await whatsappCampaignService.cancelScheduled(batch.id, account.id);

    const updated = await prismaTest.dispatchBatch.findUnique({
      where: { id: batch.id },
    });
    expect(updated?.status).toBe('cancelled');
  });

  it('cancelScheduled em batch completed: throw ValidationError', async () => {
    const account = await createAccount();

    const batch = await prismaTest.dispatchBatch.create({
      data: {
        accountId: account.id,
        totalContacts: 1,
        status: 'completed',
        delaySeconds: 30,
        source: 'manual',
      },
    });

    const err = await whatsappCampaignService
      .cancelScheduled(batch.id, account.id)
      .catch(e => e);
    expectValidationError(err);
  });
});

describe('whatsapp-campaign.service.recoverOrphanRunningBatches', () => {
  it('marca batches running startedAt > 30min atras como scheduled', async () => {
    const account = await createAccount();

    const orphanStartedAt = new Date(Date.now() - 45 * 60_000);
    const orphan = await prismaTest.dispatchBatch.create({
      data: {
        accountId: account.id,
        totalContacts: 1,
        status: 'running',
        delaySeconds: 30,
        source: 'manual',
        startedAt: orphanStartedAt,
      },
    });

    const recent = await prismaTest.dispatchBatch.create({
      data: {
        accountId: account.id,
        totalContacts: 1,
        status: 'running',
        delaySeconds: 30,
        source: 'manual',
        startedAt: new Date(Date.now() - 5 * 60_000),
      },
    });

    const result = await whatsappCampaignService.recoverOrphanRunningBatches();
    expect(result.count).toBeGreaterThanOrEqual(1);

    const orphanAfter = await prismaTest.dispatchBatch.findUnique({
      where: { id: orphan.id },
    });
    expect(orphanAfter?.status).toBe('scheduled');

    const recentAfter = await prismaTest.dispatchBatch.findUnique({
      where: { id: recent.id },
    });
    expect(recentAfter?.status).toBe('running');
  });

  it('quando nao ha batches orfaos: count=0', async () => {
    const account = await createAccount();

    await prismaTest.dispatchBatch.create({
      data: {
        accountId: account.id,
        totalContacts: 1,
        status: 'running',
        delaySeconds: 30,
        source: 'manual',
        startedAt: new Date(Date.now() - 2 * 60_000),
      },
    });

    const result = await whatsappCampaignService.recoverOrphanRunningBatches();
    expect(result.count).toBe(0);
  });
});
