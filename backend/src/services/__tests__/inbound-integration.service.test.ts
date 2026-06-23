/**
 * Unit tests for inbound-integration.service.ts — foco no handler
 * `handlePactoSync` (T-022 FitPark).
 *
 * Run with: npm test (vitest)
 *
 * O método é `private`, mas em TS isso é só checagem de compilação — em
 * runtime usamos `(svc as any).handlePactoSync(...)` pra invocar direto sem
 * passar pela camada HMAC/replay-window do `processWebhook` (testada à parte).
 *
 * Mockamos prisma + contactService + serviços auxiliares pra isolar a lógica
 * de roteamento por `event` e a aplicação correta das tags por evento.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const prismaMock = vi.hoisted(() => ({
  contact: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  tag: {
    findFirst: vi.fn(),
  },
}));

const contactServiceMock = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  applyTag: vi.fn(),
  removeTag: vi.fn(),
}));

const whatsappCampaignServiceMock = vi.hoisted(() => ({
  sendBatch: vi.fn(),
}));

const eventServiceMock = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config/database', () => ({
  prisma: prismaMock,
}));

vi.mock('../contact.service', () => ({
  contactService: contactServiceMock,
}));

vi.mock('../whatsapp-campaign.service', () => ({
  whatsappCampaignService: whatsappCampaignServiceMock,
}));

vi.mock('../event.service', () => ({
  eventService: eventServiceMock,
}));

import { inboundIntegrationService } from '../inbound-integration.service';

// Acesso runtime ao método private (TS-only constraint).
const svc = inboundIntegrationService as any;

const ACC = 'acc-fitpark';
const OTHER_ACC = 'acc-vizinha';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InboundIntegrationService.handlePactoSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── student.created ──────────────────────────────────────────────────────

  it("event 'student.created' cria contato (origem da integração Pacto)", async () => {
    // Sem contato existente
    prismaMock.contact.findFirst.mockResolvedValue(null);
    contactServiceMock.create.mockResolvedValue({
      id: 'contact-new-1',
      nome: 'Aluno Novo',
    });

    const result = await svc.handlePactoSync(ACC, {
      event: 'student.created',
      data: {
        nome: 'Aluno Novo',
        telefone: '11999998888',
        email: 'aluno@fitpark.test',
        matricula: 'FP-001',
        plano: 'mensal',
      },
    });

    expect(result.event).toBe('student.created');
    expect(result.contactId).toBe('contact-new-1');
    expect(result.action).toBe('contact_created');

    // contactService.create foi chamado com os dados normalizados e com
    // origem proveniente da integração Pacto (no schema atual = 'integration').
    expect(contactServiceMock.create).toHaveBeenCalledTimes(1);
    const createArg = contactServiceMock.create.mock.calls[0][0];
    expect(createArg.accountId).toBe(ACC);
    expect(createArg.nome).toBe('Aluno Novo');
    expect(createArg.telefone).toBe('11999998888');
    expect(createArg.email).toBe('aluno@fitpark.test');
    // origem foi definida pela integração (Pacto via n8n) — atualmente o
    // service usa o valor 'integration' (enum do schema); o importante é
    // que NÃO é null/undefined e identifica origem externa.
    expect(createArg.origem).toBeDefined();
    expect(createArg.origem).not.toBeNull();
  });

  // ── student.churned → tag 'churn' ────────────────────────────────────────

  it("event 'student.churned' aplica tag 'churn' ao contato resolvido por telefone", async () => {
    // resolvePactoContactId → busca por (accountId, telefone)
    prismaMock.contact.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.accountId === ACC && where.telefone === '11955554444') {
        return { id: 'contact-churn-1' };
      }
      return null;
    });
    // handleTagApply → valida ownership via contact.findFirst (id + accountId)
    // — o mock acima também atende esse caso por id, então adicionamos suporte:
    prismaMock.contact.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.accountId !== ACC) return null;
      if (where.telefone === '11955554444') return { id: 'contact-churn-1' };
      if (where.id === 'contact-churn-1') return { id: 'contact-churn-1' };
      return null;
    });
    // resolveTagId por nome 'churn'
    prismaMock.tag.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.accountId !== ACC) return null;
      if (where.slug === 'churn' || where.name === 'churn') {
        return { id: 'tag-churn' };
      }
      return null;
    });
    contactServiceMock.applyTag.mockResolvedValue({ id: 'contact-churn-1' });

    const result = await svc.handlePactoSync(ACC, {
      event: 'student.churned',
      data: { telefone: '11955554444', matricula: 'FP-007' },
    });

    expect(result.event).toBe('student.churned');
    expect(result.action).toBe('tag_churn_added');
    expect(result.contactId).toBe('contact-churn-1');

    // applyTag chamado com o tagId da 'churn'
    expect(contactServiceMock.applyTag).toHaveBeenCalledWith(
      'contact-churn-1',
      ACC,
      'tag-churn',
      'api'
    );
  });

  // ── checkin.created → tag 'frequente' ────────────────────────────────────

  it("event 'checkin.created' aplica tag 'frequente'", async () => {
    prismaMock.contact.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.accountId !== ACC) return null;
      if (where.telefone === '11933332222') return { id: 'contact-chk-1' };
      if (where.id === 'contact-chk-1') return { id: 'contact-chk-1' };
      return null;
    });
    prismaMock.tag.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.accountId !== ACC) return null;
      const slug = (where.slug ?? '').toLowerCase();
      const name = where.name ?? '';
      if (slug === 'frequente' || name === 'frequente') {
        return { id: 'tag-frequente' };
      }
      // 'frio' e 'churn' são tentados pra remoção — não existem aqui
      return null;
    });
    contactServiceMock.applyTag.mockResolvedValue({ id: 'contact-chk-1' });

    const result = await svc.handlePactoSync(ACC, {
      event: 'checkin.created',
      data: { telefone: '11933332222' },
    });

    expect(result.event).toBe('checkin.created');
    expect(result.action).toBe('tag_frequente_added');
    expect(result.contactId).toBe('contact-chk-1');

    // applyTag chamado com 'tag-frequente'
    expect(contactServiceMock.applyTag).toHaveBeenCalledWith(
      'contact-chk-1',
      ACC,
      'tag-frequente',
      'api'
    );
  });

  // ── contract.expiring com daysUntilExpiry=7 → tag 'renovacao-7d' ─────────

  it("event 'contract.expiring' com daysUntilExpiry=7 aplica tag 'renovacao-7d'", async () => {
    prismaMock.contact.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.accountId !== ACC) return null;
      if (where.telefone === '11922221111') return { id: 'contact-exp-1' };
      if (where.id === 'contact-exp-1') return { id: 'contact-exp-1' };
      return null;
    });
    prismaMock.tag.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.accountId !== ACC) return null;
      const slug = (where.slug ?? '').toLowerCase();
      const name = where.name ?? '';
      if (slug === 'renovacao-7d' || name === 'renovacao-7d') {
        return { id: 'tag-renovacao-7d' };
      }
      return null;
    });
    contactServiceMock.applyTag.mockResolvedValue({ id: 'contact-exp-1' });

    const result = await svc.handlePactoSync(ACC, {
      event: 'contract.expiring',
      data: { telefone: '11922221111', daysUntilExpiry: 7 },
    });

    expect(result.event).toBe('contract.expiring');
    expect(result.action).toBe('tag_renovacao-7d_added');
    expect(result.contactId).toBe('contact-exp-1');

    expect(contactServiceMock.applyTag).toHaveBeenCalledWith(
      'contact-exp-1',
      ACC,
      'tag-renovacao-7d',
      'api'
    );
  });

  // ── unknown event → ValidationError ──────────────────────────────────────

  it('event desconhecido → ValidationError (400 / VALIDATION_ERROR)', async () => {
    // Checamos shape (statusCode + code) em vez de `instanceof` porque o
    // service e o teste podem ter resolvido o módulo `../../utils/errors`
    // por caminhos ligeiramente diferentes (TS path resolution), o que faz
    // duas classes idênticas falharem em `instanceof`.
    await expect(
      svc.handlePactoSync(ACC, {
        event: 'student.exploded',
        data: { telefone: '11900000000' },
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  // ── multi-tenant ────────────────────────────────────────────────────────

  it('multi-tenant: contato de OUTRA conta não é afetado por student.churned', async () => {
    // O contato com este telefone só existe em OTHER_ACC; em ACC não existe.
    prismaMock.contact.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.accountId === OTHER_ACC && where.telefone === '11988887777') {
        return { id: 'contact-other-tenant' };
      }
      // Em ACC, ninguém — mesmo que o phone exista no DB global
      return null;
    });
    // Tag tampouco será encontrada em ACC
    prismaMock.tag.findFirst.mockResolvedValue(null);

    // resolvePactoContactId retorna undefined → handler lança NotFoundError
    // (checamos shape em vez de `instanceof` — vide nota no teste anterior).
    await expect(
      svc.handlePactoSync(ACC, {
        event: 'student.churned',
        data: { telefone: '11988887777' },
      })
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });

    // O contato da OUTRA conta NÃO foi tocado em momento algum.
    expect(contactServiceMock.applyTag).not.toHaveBeenCalled();
    expect(contactServiceMock.update).not.toHaveBeenCalled();

    // Sanity: a query foi feita escopada à conta ACC (não OTHER_ACC).
    const accountIdsConsultados = prismaMock.contact.findFirst.mock.calls.map(
      (c: any) => c[0].where.accountId
    );
    expect(accountIdsConsultados).toContain(ACC);
    expect(accountIdsConsultados).not.toContain(OTHER_ACC);
  });
});
