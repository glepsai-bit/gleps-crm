/**
 * Integration tests for contact.service.applyTag — foco em:
 *  - Transação (leadTag + tagHistory atômicos)
 *  - Swap de stage (remove a antiga, adiciona a nova)
 *  - Race condition (5 Promise.all paralelos no MESMO contact)
 *  - Idempotência (aplicar mesma stage 2x = noop)
 *  - Audit trail com apiKeyId (actorType=external)
 *  - reason persistido no TagHistory
 *
 * Roda contra o DB de teste (gleps_crm_test). beforeEach do setup.ts limpa
 * todas as tabelas. Cada teste cria seu proprio estado via helpers.
 */

import { describe, it, expect } from 'vitest';
import { prismaTest } from '../test/setup';
import {
  createTestAccount,
  createTestFunnelWithStages,
  createTestContact,
} from '../test/helpers';
import { contactService } from './contact.service';

describe('ContactService.applyTag', () => {
  it('aplica stage tag em transaction: cria leadTag + tagHistory atomicamente', async () => {
    const { account, user } = await createTestAccount();
    const { tags } = await createTestFunnelWithStages(account.id, ['Novo', 'Em Contato']);
    const contact = await createTestContact(account.id);

    await contactService.applyTag(contact.id, account.id, tags[0].id, 'kanban', user.id);

    const leadTags = await prismaTest.leadTag.findMany({
      where: { contactId: contact.id },
    });
    expect(leadTags.length).toBe(1);
    expect(leadTags[0].tagId).toBe(tags[0].id);

    const history = await prismaTest.tagHistory.findMany({
      where: { contactId: contact.id },
    });
    expect(history.length).toBe(1);
    expect(history[0].action).toBe('added');
    expect(history[0].tagId).toBe(tags[0].id);
  });

  it('swap: aplicar stage B em contato com stage A -> tagHistory tem 1 removed (A) + 1 added (B), leadTag count = 1', async () => {
    const { account, user } = await createTestAccount();
    const { tags } = await createTestFunnelWithStages(account.id, ['Stage A', 'Stage B']);
    const contact = await createTestContact(account.id);

    // Aplica A
    await contactService.applyTag(contact.id, account.id, tags[0].id, 'kanban', user.id);
    // Aplica B (deve remover A automaticamente — invariante: 1 lead = 1 stage)
    await contactService.applyTag(contact.id, account.id, tags[1].id, 'kanban', user.id);

    const leadTags = await prismaTest.leadTag.findMany({
      where: { contactId: contact.id },
    });
    expect(leadTags.length).toBe(1);
    expect(leadTags[0].tagId).toBe(tags[1].id); // só B presente

    const history = await prismaTest.tagHistory.findMany({
      where: { contactId: contact.id },
      orderBy: { createdAt: 'asc' },
    });

    const removed = history.filter((h) => h.action === 'removed');
    const added = history.filter((h) => h.action === 'added');
    expect(removed.length).toBe(1);
    expect(removed[0].tagId).toBe(tags[0].id);
    expect(added.length).toBe(2); // 1 add inicial de A + 1 add de B
    expect(added[added.length - 1].tagId).toBe(tags[1].id);
  });

  it('CRITICAL race: 5 Promise.all em parallel no MESMO contact com stages diferentes -> leadTag count final = 1 (advisory_xact_lock)', async () => {
    const { account, user } = await createTestAccount();
    const { tags } = await createTestFunnelWithStages(account.id, [
      'S1',
      'S2',
      'S3',
      'S4',
      'S5',
    ]);
    const contact = await createTestContact(account.id);

    // 5 stage tags diferentes aplicadas SIMULTANEAMENTE no MESMO contact.
    // O advisory_xact_lock(contactId) deve serializar a execução em fila,
    // garantindo que apenas a última vença (1 lead = 1 stage no fim).
    const results = await Promise.allSettled(
      tags.map((t) => contactService.applyTag(contact.id, account.id, t.id, 'kanban', user.id))
    );

    // Não exigimos sucesso de todas (a corrida residual pode virar 409); o
    // ponto crítico é o invariante final.
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    expect(fulfilled).toBeGreaterThanOrEqual(1);

    const leadTags = await prismaTest.leadTag.findMany({
      where: { contactId: contact.id },
      include: { tag: true },
    });
    // INVARIANTE CRITICO: apenas 1 stage tag aplicada ao final
    const stageLeadTags = leadTags.filter((lt) => lt.tag.type === 'stage');
    expect(stageLeadTags.length).toBe(1);

    // TagHistory: deve ter N-1 removed + 1 added (no minimo).
    // Numero pode ser maior se houve sucesso em multiplas escritas (cada
    // sucesso = 1 add + ate K removes). O que importa eh ter pelo menos
    // 1 added e que existe historia de removidos quando >1 sucesso.
    const history = await prismaTest.tagHistory.findMany({
      where: { contactId: contact.id },
    });
    const added = history.filter((h) => h.action === 'added');
    const removed = history.filter((h) => h.action === 'removed');
    expect(added.length).toBeGreaterThanOrEqual(1);
    // Se mais de 1 succeed, vai haver removed (cada novo sucesso remove o anterior)
    if (fulfilled > 1) {
      expect(removed.length).toBeGreaterThanOrEqual(fulfilled - 1);
    }
  });

  it('idempotente: aplicar mesmo stage 2x -> 2a chamada eh noop (sem duplicar leadTag nem tagHistory.added)', async () => {
    const { account, user } = await createTestAccount();
    const { tags } = await createTestFunnelWithStages(account.id, ['Unica']);
    const contact = await createTestContact(account.id);

    await contactService.applyTag(contact.id, account.id, tags[0].id, 'kanban', user.id);
    await contactService.applyTag(contact.id, account.id, tags[0].id, 'kanban', user.id);

    const leadTags = await prismaTest.leadTag.findMany({
      where: { contactId: contact.id },
    });
    expect(leadTags.length).toBe(1);

    const added = await prismaTest.tagHistory.findMany({
      where: { contactId: contact.id, action: 'added' },
    });
    // Apenas 1 added — a 2a chamada nao gera ruido no audit
    expect(added.length).toBe(1);
  });

  it('com options.apiKeyId: tagHistory.actorType=external + actorId=apiKeyId', async () => {
    const { account } = await createTestAccount();
    const { tags } = await createTestFunnelWithStages(account.id, ['ApiStage']);
    const contact = await createTestContact(account.id);
    const apiKeyId = '11111111-2222-3333-4444-555555555555';

    await contactService.applyTag(
      contact.id,
      account.id,
      tags[0].id,
      'api',
      undefined,
      { apiKeyId }
    );

    const history = await prismaTest.tagHistory.findFirst({
      where: { contactId: contact.id, action: 'added' },
    });
    expect(history).toBeTruthy();
    expect(history!.actorType).toBe('external');
    expect(history!.actorId).toBe(apiKeyId);
    expect(history!.source).toBe('api');
  });

  it('com options.reason: persistido no tagHistory.reason', async () => {
    const { account } = await createTestAccount();
    const { tags } = await createTestFunnelWithStages(account.id, ['ReasonStage']);
    const contact = await createTestContact(account.id);
    const reason = 'Migração automática pelo n8n — student.created';

    await contactService.applyTag(
      contact.id,
      account.id,
      tags[0].id,
      'api',
      undefined,
      { reason, apiKeyId: '99999999-9999-9999-9999-999999999999' }
    );

    const history = await prismaTest.tagHistory.findFirst({
      where: { contactId: contact.id, action: 'added' },
    });
    expect(history).toBeTruthy();
    expect(history!.reason).toBe(reason);
  });
});
