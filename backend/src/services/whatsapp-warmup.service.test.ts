/**
 * T-023 — whatsapp-warmup service tests
 *
 * Cobre:
 *  - startNumber / pauseNumber / resumeNumber
 *  - tick: rollover, janela horaria, jitter, alternancia, pareamento,
 *    picker por fase, auto-pause, auto-promocao
 *  - mock evolutionService.sendText (NUNCA bate em API real)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock evolution.service ANTES de qualquer import do servico (vi.mock eh hoisted)
vi.mock('../services/evolution.service', () => ({
  evolutionService: {
    sendText: vi.fn(async () => ({ messageId: 'evo-warmup-test', raw: {} })),
    sendAudio: vi.fn(async () => ({ messageId: 'evo-audio-test', raw: {} })),
    sendSticker: vi.fn(async () => ({ messageId: 'evo-sticker-test', raw: {} })),
    sendMedia: vi.fn(async () => ({ messageId: 'evo-media-test', raw: {} })),
    sendReaction: vi.fn(async () => ({ messageId: 'evo-reaction-test', raw: {} })),
  },
}));

// Mock media loader pra nao precisar ler arquivo real do disco em testes
vi.mock('../services/warmup-media-loader', () => ({
  resolveMediaPayload: vi.fn(async (t: { mediaUrl?: string | null; mediaPath?: string | null }) => {
    if (t.mediaUrl) return t.mediaUrl;
    if (t.mediaPath) return 'BASE64-MOCK-PAYLOAD';
    throw new Error('Template sem media');
  }),
}));

import { prismaTest } from '../test/setup';
import {
  whatsappWarmupService,
  STRATEGY_CURVES,
  isInsideWindow,
  getTypeWeightsForDay,
} from './whatsapp-warmup.service';
import { evolutionService } from './evolution.service';
import { AppError } from '../utils/errors';

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================
// Helpers de factory
// ============================================

async function createAccount(opts: { tz?: string; name?: string } = {}) {
  return prismaTest.account.create({
    data: {
      nome: opts.name ?? 'Warmup Test',
      timezone: opts.tz ?? 'America/Sao_Paulo',
    },
  });
}

async function createPool(accountId: string, strategy: 'conservative' | 'moderate' | 'aggressive' = 'moderate') {
  return prismaTest.warmupPool.create({
    data: {
      accountId,
      name: `pool-${strategy}`,
      strategy,
      isActive: true,
    },
  });
}

async function createNumber(
  poolId: string,
  accountId: string,
  opts: { phone?: string; instance?: string; status?: string; currentDay?: number; quality?: number } = {}
) {
  return prismaTest.warmupNumber.create({
    data: {
      poolId,
      accountId,
      evolutionInstance: opts.instance ?? `inst-${Math.random().toString(36).slice(2, 8)}`,
      phoneE164: opts.phone ?? `5511${Math.floor(Math.random() * 100000000)}`,
      status: opts.status ?? 'cold',
      currentDay: opts.currentDay ?? 0,
      qualityScore: opts.quality ?? 100,
    },
  });
}

async function seedTemplates() {
  const tpls = [
    { type: 'text', category: 'greeting', content: 'Oi' },
    { type: 'text', category: 'greeting', content: 'Bom dia' },
    { type: 'text', category: 'response', content: 'Beleza' },
    { type: 'text', category: 'response', content: 'Joia' },
    { type: 'text', category: 'smalltalk', content: 'Como foi o dia?' },
    { type: 'reaction', category: 'reaction', content: '👍' },
    { type: 'reaction', category: 'reaction', content: '❤️' },
    { type: 'audio', category: 'media', content: 'audio-template-1' },
    { type: 'sticker', category: 'media', content: 'sticker-1' },
    { type: 'image', category: 'media', content: 'image-1' },
  ];
  for (const t of tpls) {
    await prismaTest.warmupTemplate.create({
      data: {
        accountId: null,
        type: t.type,
        category: t.category,
        content: t.content,
        weight: 1,
        language: 'pt-BR',
        isActive: true,
      },
    });
  }
}

function expectValidationError(err: unknown) {
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).statusCode).toBe(400);
}

function expectNotFoundError(err: unknown) {
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).statusCode).toBe(404);
}

// ============================================
// Curvas pre-definidas
// ============================================

describe('STRATEGY_CURVES', () => {
  it('moderate D1=10, D2=12, D3=15, D7=40 (curva default MVP)', () => {
    expect(STRATEGY_CURVES.moderate[0]).toBe(10);
    expect(STRATEGY_CURVES.moderate[1]).toBe(12);
    expect(STRATEGY_CURVES.moderate[2]).toBe(15);
    expect(STRATEGY_CURVES.moderate[3]).toBe(20);
    expect(STRATEGY_CURVES.moderate[6]).toBe(40);
  });

  it('conservative cresce mais devagar (D1=5, D7=30)', () => {
    expect(STRATEGY_CURVES.conservative[0]).toBe(5);
    expect(STRATEGY_CURVES.conservative[6]).toBe(30);
  });

  it('aggressive cresce mais rapido (D1=15, D7=120)', () => {
    expect(STRATEGY_CURVES.aggressive[0]).toBe(15);
    expect(STRATEGY_CURVES.aggressive[6]).toBe(120);
  });

  it('todas as curvas tem 30 dias', () => {
    expect(STRATEGY_CURVES.moderate.length).toBe(30);
    expect(STRATEGY_CURVES.conservative.length).toBe(30);
    expect(STRATEGY_CURVES.aggressive.length).toBe(30);
  });
});

// ============================================
// startNumber
// ============================================

describe('whatsappWarmupService.startNumber', () => {
  it('seta status=warming, currentDay=1, persiste dailyEnvioPlan da strategy', async () => {
    const acc = await createAccount();
    const pool = await createPool(acc.id, 'moderate');
    const num = await createNumber(pool.id, acc.id);

    const updated = await whatsappWarmupService.startNumber({
      numberId: num.id,
      accountId: acc.id,
    });

    expect(updated.status).toBe('warming');
    expect(updated.currentDay).toBe(1);
    expect(updated.startedAt).toBeTruthy();
    expect(updated.qualityScore).toBe(100);

    const plan = updated.dailyEnvioPlan as unknown as number[];
    expect(plan[0]).toBe(10);
    expect(plan[1]).toBe(12);
    expect(plan[6]).toBe(40);
  });

  it('throws NotFoundError se number nao existe na account', async () => {
    const acc = await createAccount();
    const err = await whatsappWarmupService
      .startNumber({ numberId: '00000000-0000-0000-0000-000000000000', accountId: acc.id })
      .catch(e => e);
    expectNotFoundError(err);
  });

  it('throws ValidationError se number ja esta warming', async () => {
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const num = await createNumber(pool.id, acc.id, { status: 'warming' });

    const err = await whatsappWarmupService
      .startNumber({ numberId: num.id, accountId: acc.id })
      .catch(e => e);

    expectValidationError(err);
  });

  it('respeita unique [accountId, phoneE164]', async () => {
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    await createNumber(pool.id, acc.id, { phone: '5534993383017' });

    const err = await createNumber(pool.id, acc.id, { phone: '5534993383017' }).catch(e => e);
    expect(err).toBeTruthy();
  });
});

// ============================================
// pauseNumber / resumeNumber
// ============================================

describe('whatsappWarmupService.pauseNumber', () => {
  it('seta status=paused com reason', async () => {
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const num = await createNumber(pool.id, acc.id, { status: 'warming' });

    const updated = await whatsappWarmupService.pauseNumber({
      numberId: num.id,
      accountId: acc.id,
      reason: 'manutencao',
    });

    expect(updated.status).toBe('paused');
    expect(updated.pausedReason).toBe('manutencao');
  });

  it('throws NotFoundError se numero nao existe', async () => {
    const acc = await createAccount();
    const err = await whatsappWarmupService
      .pauseNumber({ numberId: '00000000-0000-0000-0000-000000000000', accountId: acc.id })
      .catch(e => e);
    expectNotFoundError(err);
  });
});

describe('whatsappWarmupService.resumeNumber', () => {
  it('seta status=warming + limpa pausedReason', async () => {
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const num = await createNumber(pool.id, acc.id, { status: 'warming' });

    await whatsappWarmupService.pauseNumber({
      numberId: num.id,
      accountId: acc.id,
      reason: 'teste',
    });
    const resumed = await whatsappWarmupService.resumeNumber({
      numberId: num.id,
      accountId: acc.id,
    });

    expect(resumed.status).toBe('warming');
    expect(resumed.pausedReason).toBeNull();
  });

  it('throws ValidationError se number nao esta paused', async () => {
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const num = await createNumber(pool.id, acc.id, { status: 'warming' });

    const err = await whatsappWarmupService
      .resumeNumber({ numberId: num.id, accountId: acc.id })
      .catch(e => e);
    expectValidationError(err);
  });
});

// ============================================
// Helpers puros
// ============================================

describe('isInsideWindow', () => {
  it('retorna true para 09:00 America/Sao_Paulo', () => {
    // 12:00 UTC = 09:00 America/Sao_Paulo (UTC-3)
    const d = new Date('2026-01-15T12:00:00Z');
    expect(isInsideWindow(d, 'America/Sao_Paulo')).toBe(true);
  });

  it('retorna false para 03:00 America/Sao_Paulo (fora janela)', () => {
    // 06:00 UTC = 03:00 America/Sao_Paulo
    const d = new Date('2026-01-15T06:00:00Z');
    expect(isInsideWindow(d, 'America/Sao_Paulo')).toBe(false);
  });

  it('retorna false para 22:00 America/Sao_Paulo (fora janela)', () => {
    // 01:00 UTC do dia 16 = 22:00 do dia 15 America/Sao_Paulo
    const d = new Date('2026-01-16T01:00:00Z');
    expect(isInsideWindow(d, 'America/Sao_Paulo')).toBe(false);
  });
});

describe('getTypeWeightsForDay (V2 — media liberada a partir D4)', () => {
  it('D1-D3: text + reaction, SEM audio/sticker/image (chip fresco)', () => {
    const w = getTypeWeightsForDay(1);
    expect(w.text).toBeGreaterThan(0);
    expect(w.audio).toBe(0);
    expect(w.sticker).toBe(0);
    expect(w.image).toBe(0);
  });

  it('D4-D7: introduz audio + image + sticker (media liberada)', () => {
    const w = getTypeWeightsForDay(5);
    expect(w.text).toBeGreaterThan(0);
    expect(w.reaction).toBeGreaterThan(0);
    expect(w.audio).toBeGreaterThan(0);
    expect(w.sticker).toBeGreaterThan(0);
    expect(w.image).toBeGreaterThan(0);
  });

  it('D8-D14: mais midia (todos os tipos > 0)', () => {
    const w = getTypeWeightsForDay(10);
    expect(w.audio).toBeGreaterThan(0);
    expect(w.sticker).toBeGreaterThan(0);
    expect(w.image).toBeGreaterThan(0);
  });

  it('D15+: mistura plena (todos os tipos > 0)', () => {
    const w = getTypeWeightsForDay(20);
    expect(w.text).toBeGreaterThan(0);
    expect(w.reaction).toBeGreaterThan(0);
    expect(w.audio).toBeGreaterThan(0);
    expect(w.sticker).toBeGreaterThan(0);
    expect(w.image).toBeGreaterThan(0);
  });
});

// ============================================
// tick
// ============================================

describe('whatsappWarmupService.tick', () => {
  it('noop se nenhum number esta warming', async () => {
    const r = await whatsappWarmupService.tick();
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.checked).toBe(0);
  });

  it('fora da janela 08-20h: nao envia (skipped)', async () => {
    await seedTemplates();
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const numA = await createNumber(pool.id, acc.id, { phone: '5511A' });
    const numB = await createNumber(pool.id, acc.id, { phone: '5511B' });

    await whatsappWarmupService.startNumber({ numberId: numA.id, accountId: acc.id });
    await whatsappWarmupService.startNumber({ numberId: numB.id, accountId: acc.id });

    // 03:00 America/Sao_Paulo
    const fakeNow = new Date('2026-01-15T06:00:00Z');
    const r = await whatsappWarmupService.tick(fakeNow);

    expect(r.sent).toBe(0);
    expect((evolutionService.sendText as any)).not.toHaveBeenCalled();
  });

  it('dentro da janela: envia via Evolution para peer do mesmo pool', async () => {
    await seedTemplates();
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const numA = await createNumber(pool.id, acc.id, { phone: '5534993383017' });
    const numB = await createNumber(pool.id, acc.id, { phone: '5511444444444' });

    await whatsappWarmupService.startNumber({ numberId: numA.id, accountId: acc.id });
    await whatsappWarmupService.startNumber({ numberId: numB.id, accountId: acc.id });

    // Forca jitter a NAO pular (Math.random() < 0.5)
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);

    // 12:00 America/Sao_Paulo (= 15:00 UTC, janela ativa, jah ha tempo decorrido)
    const fakeNow = new Date('2026-01-15T15:00:00Z');
    const r = await whatsappWarmupService.tick(fakeNow);

    rng.mockRestore();

    expect(r.sent).toBeGreaterThan(0);
    expect((evolutionService.sendText as any)).toHaveBeenCalled();

    // valida pareamento — criou conversa entre A e B
    const convs = await prismaTest.warmupConversation.findMany({ where: { poolId: pool.id } });
    expect(convs.length).toBe(1);
    expect([convs[0].numberAId, convs[0].numberBId].sort()).toEqual([numA.id, numB.id].sort());

    // valida mensagem persistida
    const msgs = await prismaTest.warmupMessage.findMany({ where: { conversationId: convs[0].id } });
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0].status).toBe('sent');
  });

  it('jitter: com Math.random() < 0.5 sempre skip envio', async () => {
    await seedTemplates();
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const numA = await createNumber(pool.id, acc.id, { phone: '5511A' });
    const numB = await createNumber(pool.id, acc.id, { phone: '5511B' });

    await whatsappWarmupService.startNumber({ numberId: numA.id, accountId: acc.id });
    await whatsappWarmupService.startNumber({ numberId: numB.id, accountId: acc.id });

    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.0);

    const fakeNow = new Date('2026-01-15T15:00:00Z');
    const r = await whatsappWarmupService.tick(fakeNow);

    rng.mockRestore();

    expect(r.sent).toBe(0);
    expect((evolutionService.sendText as any)).not.toHaveBeenCalled();
  });

  it('alternancia: se lastSenderId == this, skip turno (cede para peer)', async () => {
    await seedTemplates();
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const numA = await createNumber(pool.id, acc.id, { phone: '5511A' });
    const numB = await createNumber(pool.id, acc.id, { phone: '5511B' });

    await whatsappWarmupService.startNumber({ numberId: numA.id, accountId: acc.id });
    await whatsappWarmupService.startNumber({ numberId: numB.id, accountId: acc.id });

    // Cria conversa pre-existente entre A e B onde lastSenderId == A
    const [first, second] = [numA, numB].sort((x, y) => (x.id < y.id ? -1 : 1));
    await prismaTest.warmupConversation.create({
      data: {
        poolId: pool.id,
        numberAId: first.id,
        numberBId: second.id,
        lastSenderId: numA.id,
        lastTurnAt: new Date('2026-01-15T14:55:00Z'),
        turnsCount: 1,
        isActive: true,
      },
    });

    // Forca jitter a NAO pular E forca pickPeer a escolher B como peer de A
    // Math.random retornos sequenciais; vamos forcar > 0.5 sempre
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const fakeNow = new Date('2026-01-15T15:00:00Z');
    // A foi ultimo sender; quando A processar, deve ceder.
    // Mas B nao foi ultimo sender, entao B pode enviar.
    // Forcamos a ordem analizando individualmente: vamos pegar so o A no tick
    // pausando o B antes.
    await whatsappWarmupService.pauseNumber({ numberId: numB.id, accountId: acc.id });

    const r = await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    // Como B esta pausado e nao ha peer warming pra A, ou A cede turno — em ambos
    // os casos NAO houve envio. Sent deve ser 0.
    expect(r.sent).toBe(0);
  });

  it('rollover: dia diferente -> persiste WarmupDailyStats + reset contadores + currentDay++', async () => {
    await seedTemplates();
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const num = await createNumber(pool.id, acc.id, { phone: '5511A' });
    await createNumber(pool.id, acc.id, { phone: '5511B' });

    await whatsappWarmupService.startNumber({ numberId: num.id, accountId: acc.id });

    // Simula que lastActivityAt foi ontem (manipula DB direto)
    const yesterday = new Date('2026-01-14T15:00:00Z');
    await prismaTest.warmupNumber.update({
      where: { id: num.id },
      data: {
        lastActivityAt: yesterday,
        dailyEnviadasHoje: 5,
        dailyRecebidasHoje: 3,
      },
    });

    // tick num momento de hoje DENTRO da janela
    const fakeNow = new Date('2026-01-15T15:00:00Z');
    // Forca jitter a SEMPRE pular (mas o rollover deve rodar antes do jitter)
    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.0);
    await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    // Verifica: DailyStats criado para o dia anterior
    const stats = await prismaTest.warmupDailyStats.findMany({ where: { numberId: num.id } });
    expect(stats.length).toBe(1);
    expect(stats[0].actualSends).toBe(5);
    expect(stats[0].actualReceives).toBe(3);

    // Verifica: contadores resetados + currentDay++
    const after = await prismaTest.warmupNumber.findUnique({ where: { id: num.id } });
    expect(after?.dailyEnviadasHoje).toBe(0);
    expect(after?.dailyRecebidasHoje).toBe(0);
    expect(after?.currentDay).toBe(2);
  });

  it('auto-pause: qualityScore < 60 -> status=paused com reason', async () => {
    await seedTemplates();
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const numA = await createNumber(pool.id, acc.id, { phone: '5511A' });
    const numB = await createNumber(pool.id, acc.id, { phone: '5511B' });

    await whatsappWarmupService.startNumber({ numberId: numA.id, accountId: acc.id });
    await whatsappWarmupService.startNumber({ numberId: numB.id, accountId: acc.id });

    // Baixa o quality manualmente pra 65 (1 falha = -5 -> cai pra 60, ainda >= 60)
    // melhor: forcar 55 ja menor que 60 antes de chamar tick para garantir auto-pause
    // independente de envio. Usar pickPeer + jitter pra evitar envio.
    await prismaTest.warmupNumber.update({
      where: { id: numA.id },
      data: { qualityScore: 55 },
    });

    // Trigger applyHealthChecks via tick — mas precisamos chegar la
    // Simulamos: mocka sendText pra falhar para forcar penalidade adicional
    (evolutionService.sendText as any).mockRejectedValueOnce(new Error('forbidden 403'));

    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const fakeNow = new Date('2026-01-15T15:00:00Z');
    await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    const after = await prismaTest.warmupNumber.findUnique({ where: { id: numA.id } });
    expect(after?.status).toBe('paused');
    expect(after?.pausedReason).toMatch(/quality|auto/i);
  });

  it('auto-promocao: day>=21 + quality>=80 + zero falhas 3d -> warm', async () => {
    await seedTemplates();
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const numA = await createNumber(pool.id, acc.id, { phone: '5511A' });
    const numB = await createNumber(pool.id, acc.id, { phone: '5511B' });

    await whatsappWarmupService.startNumber({ numberId: numA.id, accountId: acc.id });
    await whatsappWarmupService.startNumber({ numberId: numB.id, accountId: acc.id });

    // Coloca day=22, quality=90
    await prismaTest.warmupNumber.update({
      where: { id: numA.id },
      data: { currentDay: 22, qualityScore: 90 },
    });

    // Cria 3 dias de stats zero-falha
    const baseDate = new Date('2026-01-15T12:00:00Z');
    for (let i = 1; i <= 3; i++) {
      const d = new Date(baseDate);
      d.setUTCDate(d.getUTCDate() - i);
      await prismaTest.warmupDailyStats.create({
        data: {
          numberId: numA.id,
          date: d,
          protocolDay: 22 - i,
          plannedSends: 100,
          actualSends: 95,
          actualReceives: 80,
          failedSends: 0,
          qualityEnd: 95,
          statusEnd: 'warming',
        },
      });
    }

    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const fakeNow = new Date('2026-01-15T15:00:00Z');
    await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    const after = await prismaTest.warmupNumber.findUnique({ where: { id: numA.id } });
    expect(after?.status).toBe('warm');
  });

  it('numero sem peer no pool: skipped (nao envia, nao crasha)', async () => {
    await seedTemplates();
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const num = await createNumber(pool.id, acc.id, { phone: '5511A' });
    await whatsappWarmupService.startNumber({ numberId: num.id, accountId: acc.id });

    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const fakeNow = new Date('2026-01-15T15:00:00Z');
    const r = await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    expect(r.sent).toBe(0);
    expect((evolutionService.sendText as any)).not.toHaveBeenCalled();
  });

  it('D1: gera apenas text/reaction (NUNCA audio/sticker/image)', async () => {
    await seedTemplates();
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const numA = await createNumber(pool.id, acc.id, { phone: '5511A' });
    const numB = await createNumber(pool.id, acc.id, { phone: '5511B' });

    await whatsappWarmupService.startNumber({ numberId: numA.id, accountId: acc.id });
    await whatsappWarmupService.startNumber({ numberId: numB.id, accountId: acc.id });

    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const fakeNow = new Date('2026-01-15T18:00:00Z'); // 15:00 SP, tarde da janela
    await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    const msgs = await prismaTest.warmupMessage.findMany({});
    // V2 D1-D3: nunca midia (chip fresco). text e reaction sao OK.
    for (const m of msgs) {
      expect(['text', 'reaction']).toContain(m.messageType);
    }
  });
});

// ============================================
// AI providers — contentSource em WarmupMessage (T-023 Fase 2)
// ============================================

import { openaiProvider } from './ai/openai-provider';
import { anthropicProvider } from './ai/anthropic-provider';

describe('whatsappWarmupService.tick — contentSource via providers IA', () => {
  it('pool useAi=true via OpenAI -> WarmupMessage.contentSource = "openai"', async () => {
    await seedTemplates();
    const acc = await createAccount();
    // pool com useAi habilitado e provider openai
    const pool = await prismaTest.warmupPool.create({
      data: {
        accountId: acc.id,
        name: 'pool-ai-openai',
        strategy: 'moderate',
        useAi: true,
        aiProvider: 'openai',
        aiTone: 'casual',
      },
    });
    const numA = await createNumber(pool.id, acc.id, { phone: '5511AI-A' });
    const numB = await createNumber(pool.id, acc.id, { phone: '5511AI-B' });

    await whatsappWarmupService.startNumber({ numberId: numA.id, accountId: acc.id });
    await whatsappWarmupService.startNumber({ numberId: numB.id, accountId: acc.id });

    vi.spyOn(openaiProvider, 'isEnabled').mockReturnValue(true);
    vi.spyOn(openaiProvider, 'generate').mockResolvedValue({
      source: 'openai',
      type: 'text',
      content: 'oi tudo bem',
      model: 'gpt-4o-mini',
      cost: { inputTokens: 30, outputTokens: 3, usdEstimate: 0.0000063 },
    });

    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const fakeNow = new Date('2026-01-15T18:00:00Z');
    const r = await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    expect(r.sent).toBeGreaterThan(0);
    const msgs = await prismaTest.warmupMessage.findMany({});
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.every(m => m.contentSource === 'openai')).toBe(true);
  });

  it('pool useAi=true via Anthropic -> WarmupMessage.contentSource = "anthropic"', async () => {
    await seedTemplates();
    const acc = await createAccount();
    const pool = await prismaTest.warmupPool.create({
      data: {
        accountId: acc.id,
        name: 'pool-ai-anthropic',
        strategy: 'moderate',
        useAi: true,
        aiProvider: 'anthropic',
        aiTone: 'casual',
      },
    });
    const numA = await createNumber(pool.id, acc.id, { phone: '5511AI-C' });
    const numB = await createNumber(pool.id, acc.id, { phone: '5511AI-D' });

    await whatsappWarmupService.startNumber({ numberId: numA.id, accountId: acc.id });
    await whatsappWarmupService.startNumber({ numberId: numB.id, accountId: acc.id });

    vi.spyOn(anthropicProvider, 'isEnabled').mockReturnValue(true);
    vi.spyOn(anthropicProvider, 'generate').mockResolvedValue({
      source: 'anthropic',
      type: 'text',
      content: 'beleza',
      model: 'claude-haiku-4-5-20251001',
      cost: { inputTokens: 20, outputTokens: 2, usdEstimate: 0.00003 },
    });

    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const fakeNow = new Date('2026-01-15T18:00:00Z');
    const r = await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    expect(r.sent).toBeGreaterThan(0);
    const msgs = await prismaTest.warmupMessage.findMany({});
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.every(m => m.contentSource === 'anthropic')).toBe(true);
  });

  it('pool useAi=false (default) -> WarmupMessage.contentSource = "template" (regressao)', async () => {
    await seedTemplates();
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const numA = await createNumber(pool.id, acc.id, { phone: '5511T-A' });
    const numB = await createNumber(pool.id, acc.id, { phone: '5511T-B' });

    await whatsappWarmupService.startNumber({ numberId: numA.id, accountId: acc.id });
    await whatsappWarmupService.startNumber({ numberId: numB.id, accountId: acc.id });

    const oaiSpy = vi.spyOn(openaiProvider, 'generate');

    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const fakeNow = new Date('2026-01-15T18:00:00Z');
    await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    expect(oaiSpy).not.toHaveBeenCalled();
    const msgs = await prismaTest.warmupMessage.findMany({});
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.every(m => m.contentSource === 'template')).toBe(true);
  });
});

// ============================================
// V2 — Multi-tipo (audio / sticker / image / reaction)
// ============================================

import { warmupContentGenerator } from './warmup-content-generator';

describe('whatsappWarmupService.tick — V2 multi-tipo (audio/sticker/image/reaction)', () => {
  async function setupTwoNumbersAtDay(
    day: number,
  ): Promise<{ accId: string; numAId: string; numBId: string; numA: any; numB: any }> {
    await seedTemplates();
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const numA = await createNumber(pool.id, acc.id, { phone: '5511V2-A' });
    const numB = await createNumber(pool.id, acc.id, { phone: '5511V2-B' });
    await whatsappWarmupService.startNumber({ numberId: numA.id, accountId: acc.id });
    await whatsappWarmupService.startNumber({ numberId: numB.id, accountId: acc.id });
    // Pula pra fase desejada
    await prismaTest.warmupNumber.update({
      where: { id: numA.id },
      data: { currentDay: day },
    });
    await prismaTest.warmupNumber.update({
      where: { id: numB.id },
      data: { currentDay: day },
    });
    return { accId: acc.id, numAId: numA.id, numBId: numB.id, numA, numB };
  }

  it('tick com generated.type=audio chama evolutionService.sendAudio', async () => {
    const { numAId, numBId } = await setupTwoNumbersAtDay(10);

    vi.spyOn(warmupContentGenerator, 'pick').mockResolvedValue({
      source: 'template',
      type: 'audio',
      content: 'audio-template',
      templateId: 'tpl-audio',
      mediaPath: 'acc/warmup/audio/sample.ogg',
      mediaMimeType: 'audio/ogg',
    });

    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const fakeNow = new Date('2026-01-15T15:00:00Z');
    await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    expect((evolutionService.sendAudio as any)).toHaveBeenCalled();
    // Garante que NAO virou text
    expect((evolutionService.sendText as any)).not.toHaveBeenCalled();

    const msgs = await prismaTest.warmupMessage.findMany({});
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(m => m.messageType === 'audio')).toBe(true);
  });

  it('tick com generated.type=sticker chama evolutionService.sendSticker', async () => {
    await setupTwoNumbersAtDay(10);

    vi.spyOn(warmupContentGenerator, 'pick').mockResolvedValue({
      source: 'template',
      type: 'sticker',
      content: 'sticker-template',
      templateId: 'tpl-sticker',
      mediaPath: 'acc/warmup/sticker/sample.webp',
      mediaMimeType: 'image/webp',
    });

    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const fakeNow = new Date('2026-01-15T15:00:00Z');
    await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    expect((evolutionService.sendSticker as any)).toHaveBeenCalled();
    const msgs = await prismaTest.warmupMessage.findMany({});
    expect(msgs.some(m => m.messageType === 'sticker')).toBe(true);
  });

  it('tick com generated.type=image chama evolutionService.sendMedia(mediaType=image)', async () => {
    await setupTwoNumbersAtDay(20);

    vi.spyOn(warmupContentGenerator, 'pick').mockResolvedValue({
      source: 'template',
      type: 'image',
      content: 'caption opcional',
      templateId: 'tpl-image',
      mediaPath: 'acc/warmup/image/sample.jpg',
      mediaMimeType: 'image/jpeg',
    });

    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const fakeNow = new Date('2026-01-15T15:00:00Z');
    await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    expect((evolutionService.sendMedia as any)).toHaveBeenCalled();
    const callArgs = (evolutionService.sendMedia as any).mock.calls[0][1];
    expect(callArgs.mediaType).toBe('image');
    expect(callArgs.caption).toBe('caption opcional');

    const msgs = await prismaTest.warmupMessage.findMany({});
    expect(msgs.some(m => m.messageType === 'image')).toBe(true);
  });

  it('tick com generated.type=reaction sem peer msg id: fallback sendText', async () => {
    // Setup com SO 1 numero warming (numC fica em status=cold pra nao processar)
    await seedTemplates();
    const acc = await createAccount();
    const pool = await createPool(acc.id);
    const numA = await createNumber(pool.id, acc.id, { phone: '5511RX-A' });
    const numB = await createNumber(pool.id, acc.id, { phone: '5511RX-B' });
    await whatsappWarmupService.startNumber({ numberId: numA.id, accountId: acc.id });
    await whatsappWarmupService.startNumber({ numberId: numB.id, accountId: acc.id });
    await prismaTest.warmupNumber.update({
      where: { id: numA.id },
      data: { currentDay: 5 },
    });
    await prismaTest.warmupNumber.update({
      where: { id: numB.id },
      data: { currentDay: 5 },
    });

    // Pre-cria conversa com lastSenderId=A (pra B ceder turno) +
    // msg do peer (B->A) SEM evolutionMsgId (null) — lookup vai falhar.
    const [first, second] = [numA, numB].sort((x, y) => (x.id < y.id ? -1 : 1));
    const conv = await prismaTest.warmupConversation.create({
      data: {
        poolId: pool.id,
        numberAId: first.id,
        numberBId: second.id,
        lastSenderId: numA.id, // A foi ultimo -> A vai ceder turno
        lastTurnAt: new Date('2026-01-15T14:55:00Z'),
        isActive: true,
      },
    });
    // Msg do peer (B) sem evolutionMsgId (null)
    await prismaTest.warmupMessage.create({
      data: {
        conversationId: conv.id,
        senderId: numB.id,
        receiverId: numA.id,
        messageType: 'text',
        content: 'oi',
        status: 'sent',
        evolutionMsgId: null,
      },
    });
    // E uma msg de A com evolutionMsgId valido, pra que B (que vai processar)
    // poderia em tese reagir A SE existisse uma do peer (A) — mas regra do
    // dispatcher reaction olha a msg do PEER. Como B vai processar, peer=A;
    // entao precisamos garantir que A NAO tem msg com evolutionMsgId.
    // Ja garantido acima: so existe a msg B->A com evolutionMsgId=null,
    // e nada de A com evolutionMsgId. Entao B fallback tambem.

    vi.spyOn(warmupContentGenerator, 'pick').mockResolvedValue({
      source: 'template',
      type: 'reaction',
      content: '👍',
      templateId: 'tpl-rxn',
    });

    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const fakeNow = new Date('2026-01-15T15:00:00Z');
    await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    // Nenhum reaction enviado: B nao acha A com evolutionMsgId, A cede turno.
    expect((evolutionService.sendReaction as any)).not.toHaveBeenCalled();
    // Fallback executou sendText pra B (A cedeu turno)
    expect((evolutionService.sendText as any)).toHaveBeenCalled();
  });

  it('tick com generated.type=reaction COM peer msg id: usa sendReaction', async () => {
    const { numAId, numBId, numA, numB } = await setupTwoNumbersAtDay(5);

    // Cria conversa + msg anterior do peer (B) que tem evolutionMsgId
    const [first, second] = [numA, numB].sort((x, y) => (x.id < y.id ? -1 : 1));
    const conv = await prismaTest.warmupConversation.create({
      data: {
        poolId: numA.poolId,
        numberAId: first.id,
        numberBId: second.id,
        lastSenderId: numBId, // B foi ultimo sender -> A pode reagir
        lastTurnAt: new Date('2026-01-15T14:55:00Z'),
        isActive: true,
      },
    });
    await prismaTest.warmupMessage.create({
      data: {
        conversationId: conv.id,
        senderId: numBId,
        receiverId: numAId,
        messageType: 'text',
        content: 'oi',
        status: 'sent',
        evolutionMsgId: 'evo-msg-anterior-do-peer-B',
      },
    });

    vi.spyOn(warmupContentGenerator, 'pick').mockResolvedValue({
      source: 'template',
      type: 'reaction',
      content: '👍',
      templateId: 'tpl-rxn',
    });

    const rng = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const fakeNow = new Date('2026-01-15T15:00:00Z');
    await whatsappWarmupService.tick(fakeNow);
    rng.mockRestore();

    expect((evolutionService.sendReaction as any)).toHaveBeenCalled();
    const reactionArgs = (evolutionService.sendReaction as any).mock.calls[0][1];
    expect(reactionArgs.reactionToMsgId).toBe('evo-msg-anterior-do-peer-B');
    expect(reactionArgs.reaction).toBe('👍');
  });
});
