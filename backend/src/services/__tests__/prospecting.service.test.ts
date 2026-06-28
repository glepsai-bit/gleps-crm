/**
 * Unit tests for prospecting.service.ts — focus em getBatches filtros,
 * aggregateBatches e getCampaignTypes (T-022 historico de disparos rico).
 *
 * Mocka prisma via vi.hoisted (mesmo pattern de api-key.service.test).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Prisma Mock ──────────────────────────────────────────────────────────────

const prismaMock = vi.hoisted(() => ({
  dispatchBatch: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  dispatchLog: {
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    createManyAndReturn: vi.fn(),
  },
  apiUsageLog: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
  account: {
    findUnique: vi.fn(),
  },
  inbox: {
    findMany: vi.fn(),
  },
  $queryRaw: vi.fn(),
  $queryRawUnsafe: vi.fn(),
}));

vi.mock('../../config/database', () => ({
  prisma: prismaMock,
}));

vi.mock('../evolution.service', () => ({
  evolutionService: {
    sendText: vi.fn().mockResolvedValue({ id: 'm1' }),
  },
}));

vi.mock('../whatsapp-consent.service', () => ({
  whatsappConsentService: {
    normalizePhone: (p: string) => p,
    hasConsent: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../whatsapp-rate-limit.service', () => ({
  whatsappRateLimitService: {
    check: vi.fn().mockResolvedValue({ allowed: true }),
    record: vi.fn(),
  },
}));

import { prospectingService } from '../prospecting.service';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ProspectingService.getBatches — filtros', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.dispatchBatch.findMany.mockResolvedValue([]);
  });

  it('sem filtros: WHERE só com accountId, take=20', async () => {
    await prospectingService.getBatches('acc-1');

    expect(prismaMock.dispatchBatch.findMany).toHaveBeenCalledTimes(1);
    const arg = prismaMock.dispatchBatch.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ accountId: 'acc-1' });
    expect(arg.take).toBe(20);
    expect(arg.skip).toBe(0);
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('filtro source string: WHERE source=valor', async () => {
    await prospectingService.getBatches('acc-1', { source: 'n8n' });

    const arg = prismaMock.dispatchBatch.findMany.mock.calls[0][0];
    expect(arg.where.source).toBe('n8n');
  });

  it('filtro source array: WHERE source IN [...]', async () => {
    await prospectingService.getBatches('acc-1', { source: ['n8n', 'api', 'manual_scheduled'] });

    const arg = prismaMock.dispatchBatch.findMany.mock.calls[0][0];
    expect(arg.where.source).toEqual({ in: ['n8n', 'api', 'manual_scheduled'] });
  });

  it('filtro status array: WHERE status IN [...]', async () => {
    await prospectingService.getBatches('acc-1', { status: ['scheduled', 'paused'] });

    const arg = prismaMock.dispatchBatch.findMany.mock.calls[0][0];
    expect(arg.where.status).toEqual({ in: ['scheduled', 'paused'] });
  });

  it('filtro campaignType: usa metadata->>campaign_type (Prisma path equals)', async () => {
    await prospectingService.getBatches('acc-1', { campaignType: 'birthday' });

    const arg = prismaMock.dispatchBatch.findMany.mock.calls[0][0];
    expect(arg.where.AND).toBeDefined();
    expect(arg.where.AND[0]).toEqual({
      OR: [
        {
          metadata: {
            path: ['campaign_type'],
            equals: 'birthday',
          },
        },
      ],
    });
  });

  it('filtro campaignType array: OR de equals em metadata->campaign_type', async () => {
    await prospectingService.getBatches('acc-1', { campaignType: ['birthday', 'cobranca'] });

    const arg = prismaMock.dispatchBatch.findMany.mock.calls[0][0];
    expect(arg.where.AND).toBeDefined();
    expect(arg.where.AND[0].OR).toHaveLength(2);
    expect(arg.where.AND[0].OR[0]).toEqual({
      metadata: { path: ['campaign_type'], equals: 'birthday' },
    });
    expect(arg.where.AND[0].OR[1]).toEqual({
      metadata: { path: ['campaign_type'], equals: 'cobranca' },
    });
  });

  it('filtro q: ILIKE em keyword/triggerName/metadata + escape de % e _', async () => {
    await prospectingService.getBatches('acc-1', { q: '50%_off' });

    const arg = prismaMock.dispatchBatch.findMany.mock.calls[0][0];
    expect(arg.where.AND).toBeDefined();
    const orClause = arg.where.AND[0].OR;
    expect(orClause).toHaveLength(3);
    // ESCAPE: % e _ devem virar \% e \_
    expect(orClause[0]).toEqual({
      keyword: { contains: '50\\%\\_off', mode: 'insensitive' },
    });
    expect(orClause[1]).toEqual({
      triggerName: { contains: '50\\%\\_off', mode: 'insensitive' },
    });
    expect(orClause[2]).toEqual({
      metadata: { path: ['campaign_type'], string_contains: '50\\%\\_off' },
    });
  });

  it('filtro q vazio/whitespace: ignora', async () => {
    await prospectingService.getBatches('acc-1', { q: '   ' });

    const arg = prismaMock.dispatchBatch.findMany.mock.calls[0][0];
    expect(arg.where.AND).toBeUndefined();
  });

  it('filtros fromDate + toDate: WHERE createdAt range', async () => {
    const from = new Date('2026-06-01T00:00:00Z');
    const to = new Date('2026-06-30T23:59:59Z');
    await prospectingService.getBatches('acc-1', { fromDate: from, toDate: to });

    const arg = prismaMock.dispatchBatch.findMany.mock.calls[0][0];
    expect(arg.where.createdAt).toEqual({ gte: from, lte: to });
  });

  it('paginação: limit e offset respeitam clamp (max 200, min 0)', async () => {
    await prospectingService.getBatches('acc-1', { limit: 500, offset: -5 });

    const arg = prismaMock.dispatchBatch.findMany.mock.calls[0][0];
    expect(arg.take).toBe(200);
    expect(arg.skip).toBe(0);
  });

  it('multi-tenant: WHERE sempre escopado pelo accountId informado', async () => {
    await prospectingService.getBatches('acc-X');
    let arg = prismaMock.dispatchBatch.findMany.mock.calls[0][0];
    expect(arg.where.accountId).toBe('acc-X');

    await prospectingService.getBatches('acc-Y');
    arg = prismaMock.dispatchBatch.findMany.mock.calls[1][0];
    expect(arg.where.accountId).toBe('acc-Y');
  });
});

describe('ProspectingService.aggregateBatches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sem batches: retorna []', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);
    const result = await prospectingService.aggregateBatches('acc-1');
    expect(result).toEqual([]);
  });

  it('agrupa por campaign_type por default e calcula media', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([
      { k: 'birthday', batches_count: BigInt(12), total_sent: BigInt(1412), total_failed: BigInt(23) },
      { k: 'cobranca', batches_count: BigInt(8), total_sent: BigInt(423), total_failed: BigInt(5) },
      { k: null, batches_count: BigInt(5), total_sent: BigInt(230), total_failed: BigInt(0) },
    ]);

    const result = await prospectingService.aggregateBatches('acc-1');

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      key: 'birthday',
      campaignType: 'birthday',
      batchesCount: 12,
      totalSent: 1412,
      totalFailed: 23,
      avgSentPerBatch: 117.67,
    });
    expect(result[1].campaignType).toBe('cobranca');
    expect(result[1].avgSentPerBatch).toBeCloseTo(52.88, 1);
    expect(result[2].campaignType).toBeNull();
  });

  it('groupBy=source: campos source no retorno', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([
      { k: 'manual', batches_count: BigInt(10), total_sent: BigInt(100), total_failed: BigInt(2) },
      { k: 'n8n', batches_count: BigInt(5), total_sent: BigInt(60), total_failed: BigInt(0) },
    ]);

    const result = await prospectingService.aggregateBatches('acc-1', { groupBy: 'source' });

    expect(result[0].source).toBe('manual');
    expect((result[0] as any).campaignType).toBeUndefined();
    expect(result[1].source).toBe('n8n');
  });

  it('groupBy invalido: lança ValidationError', async () => {
    await expect(
      prospectingService.aggregateBatches('acc-1', { groupBy: 'malicious; DROP TABLE' as any })
    ).rejects.toThrow();
  });

  it('multi-tenant: passa accountId como primeiro binding do raw query', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);
    await prospectingService.aggregateBatches('acc-XYZ');
    const args = prismaMock.$queryRawUnsafe.mock.calls[0];
    // arg[0] é o SQL string, arg[1] é o accountId binding
    expect(args[1]).toBe('acc-XYZ');
  });
});

describe('ProspectingService.getCampaignTypes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retorna lista distinta de campaign_types', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { k: 'birthday' },
      { k: 'cobranca' },
      { k: 'promocao' },
    ]);

    const result = await prospectingService.getCampaignTypes('acc-1');

    expect(result).toEqual(['birthday', 'cobranca', 'promocao']);
  });

  it('vazio: retorna []', async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    const result = await prospectingService.getCampaignTypes('acc-1');
    expect(result).toEqual([]);
  });

  it('filtra valores falsy (null/undefined)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      { k: 'birthday' },
      { k: null as any },
      { k: 'cobranca' },
      { k: '' },
    ]);

    const result = await prospectingService.getCampaignTypes('acc-1');
    expect(result).toEqual(['birthday', 'cobranca']);
  });
});
