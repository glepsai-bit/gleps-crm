/**
 * Unit tests for whatsapp-consent.service.ts — focus on `checkBatch`
 * (T-022 Sprint 3 / compliance UI lookup em massa pré-disparo).
 *
 * Run with: npm test (vitest)
 *
 * Padrão de mock segue api-key.service.test.ts:
 *   - `vi.hoisted` para criar o mock de prisma (vi.mock factory é hoisted
 *     ao topo do arquivo pelo vitest);
 *   - mock dos services auxiliares (eventService, webhookOutboundService)
 *     pra impedir efeitos colaterais nos testes que não os exercitam.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Prisma mock ──────────────────────────────────────────────────────────────

const prismaMock = vi.hoisted(() => ({
  whatsappConsent: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    count: vi.fn(),
  },
  contact: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock('../../config/database', () => ({
  prisma: prismaMock,
}));

vi.mock('../event.service', () => ({
  eventService: {
    create: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../webhook-outbound.service', () => ({
  webhookOutboundService: {
    emit: vi.fn().mockResolvedValue(undefined),
  },
}));

import { whatsappConsentService } from '../whatsapp-consent.service';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WhatsappConsentService.checkBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lista vazia → não consulta DB e devolve totais zerados', async () => {
    const result = await whatsappConsentService.checkBatch('acc-1', []);

    expect(result).toEqual({ total: 0, optOutCount: 0, optedOutPhones: [] });
    expect(prismaMock.whatsappConsent.findMany).not.toHaveBeenCalled();
  });

  it('3 telefones, nenhum opted_out → optOutCount=0 e lista vazia', async () => {
    prismaMock.whatsappConsent.findMany.mockResolvedValue([]);

    const phones = ['5511988887777', '5511966665555', '5511944443333'];
    const result = await whatsappConsentService.checkBatch('acc-1', phones);

    expect(result.total).toBe(3);
    expect(result.optOutCount).toBe(0);
    expect(result.optedOutPhones).toEqual([]);

    expect(prismaMock.whatsappConsent.findMany).toHaveBeenCalledTimes(1);
    const callArg = prismaMock.whatsappConsent.findMany.mock.calls[0][0];
    expect(callArg.where.accountId).toBe('acc-1');
    expect(callArg.where.status).toBe('opted_out');
    // O service deduplica via Set; comparar sem ordem.
    expect(new Set(callArg.where.phone.in)).toEqual(new Set(phones));
  });

  it('3 telefones, 1 opted_out → optOutCount=1 e devolve o que está no DB', async () => {
    prismaMock.whatsappConsent.findMany.mockResolvedValue([
      { phone: '5511988887777' },
    ]);

    const result = await whatsappConsentService.checkBatch('acc-1', [
      '5511988887777',
      '5511966665555',
      '5511944443333',
    ]);

    expect(result.total).toBe(3);
    expect(result.optOutCount).toBe(1);
    expect(result.optedOutPhones).toEqual(['5511988887777']);
  });

  it('normaliza phones formatados — "+55 (11) 99999-8888" vira "5511999998888" no IN(...)', async () => {
    // O DB tem o telefone armazenado na forma normalizada (somente dígitos,
    // tipicamente com DDI 55 quando vem do WhatsApp). `normalizePhone` só faz
    // strip de não-dígitos — não injeta DDI. Por isso passamos o input já com
    // o "+55" pra que o IN(...) gerado bata com o que está no DB.
    prismaMock.whatsappConsent.findMany.mockImplementation(async ({ where }: any) => {
      const stored = '5511999998888';
      const requested: string[] = where.phone.in;
      expect(requested).toContain(stored);
      return [{ phone: stored }];
    });

    const result = await whatsappConsentService.checkBatch('acc-1', [
      '+55 (11) 99999-8888',
    ]);

    expect(result.total).toBe(1);
    expect(result.optOutCount).toBe(1);
    expect(result.optedOutPhones).toEqual(['5511999998888']);
  });

  it('multi-tenant: filtro accountId é enviado ao Prisma — DB de outra conta não vaza', async () => {
    // Mock simula uma "conta diferente": só retorna registros se o accountId
    // bater. Aqui o test pede acc-A mas o opt-out só existe na acc-B.
    prismaMock.whatsappConsent.findMany.mockImplementation(async ({ where }: any) => {
      if (where.accountId === 'acc-B') {
        return [{ phone: '5511988887777' }];
      }
      return [];
    });

    const result = await whatsappConsentService.checkBatch('acc-A', [
      '5511988887777',
      '5511966665555',
    ]);

    // Lookup em acc-A → nenhum opt-out, mesmo que o phone esteja opted-out em acc-B.
    expect(result.optOutCount).toBe(0);
    expect(result.optedOutPhones).toEqual([]);

    const callArg = prismaMock.whatsappConsent.findMany.mock.calls[0][0];
    expect(callArg.where.accountId).toBe('acc-A');
  });

  it('telefones inválidos (vazios/letras) são descartados antes do IN(...)', async () => {
    prismaMock.whatsappConsent.findMany.mockResolvedValue([]);

    // Total conta o input original (incluindo lixo), mas o IN só tem o válido.
    const result = await whatsappConsentService.checkBatch('acc-1', [
      '5511988887777',
      '',
      'abc',
      '   ',
    ]);

    expect(result.total).toBe(4);
    const callArg = prismaMock.whatsappConsent.findMany.mock.calls[0][0];
    expect(callArg.where.phone.in).toEqual(['5511988887777']);
  });

  it('deduplica telefones iguais antes do IN(...) (mesmo número formatado de jeitos diferentes)', async () => {
    prismaMock.whatsappConsent.findMany.mockResolvedValue([]);

    await whatsappConsentService.checkBatch('acc-1', [
      '5511988887777',
      '+55 (11) 98888-7777', // normaliza para o mesmo "5511988887777"
      '55 11 98888 7777',    // idem
    ]);

    const callArg = prismaMock.whatsappConsent.findMany.mock.calls[0][0];
    // Após normalização e dedupe deve sobrar 1 único phone no IN.
    expect(callArg.where.phone.in.length).toBe(1);
    expect(callArg.where.phone.in[0]).toBe('5511988887777');
  });
});
