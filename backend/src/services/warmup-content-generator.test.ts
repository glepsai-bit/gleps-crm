/**
 * T-023 Fase 2 — WarmupContentGenerator tests
 *
 * Cobre as 4 branches principais do generator:
 *  - useAi=false -> sempre template (regressao zero)
 *  - useAi=true + provider habilitado + IA OK -> source=openai|anthropic
 *  - useAi=true + provider DISABLED -> template puro
 *  - useAi=true + provider habilitado + IA falha -> template marcado fallback
 *
 * Templates ficam no Postgres de teste (mesmo setup do resto da suite).
 * Os providers do registry sao mockados via vi.spyOn pra evitar rede.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { prismaTest } from '../test/setup';
import { warmupContentGenerator } from './warmup-content-generator';
import { openaiProvider } from './ai/openai-provider';
import { anthropicProvider } from './ai/anthropic-provider';

beforeEach(() => {
  vi.restoreAllMocks();
});

async function setupAccountAndPool(opts: {
  useAi?: boolean;
  aiProvider?: string | null;
  aiModel?: string | null;
  aiTone?: string | null;
} = {}) {
  const account = await prismaTest.account.create({
    data: { nome: 'Generator Test', timezone: 'America/Sao_Paulo' },
  });
  const pool = await prismaTest.warmupPool.create({
    data: {
      accountId: account.id,
      name: 'pool-gen',
      strategy: 'moderate',
      useAi: opts.useAi ?? false,
      aiProvider: opts.aiProvider ?? null,
      aiModel: opts.aiModel ?? null,
      aiTone: opts.aiTone ?? 'casual',
    },
  });
  const number = await prismaTest.warmupNumber.create({
    data: {
      poolId: pool.id,
      accountId: account.id,
      evolutionInstance: 'inst-gen',
      phoneE164: '5511999990001',
      status: 'warming',
      currentDay: 2, // forca text+greeting/response (fase 1)
      qualityScore: 100,
    },
  });
  return { account, pool, number };
}

async function seedMinimalTextTemplate(content = 'oi tudo bem') {
  await prismaTest.warmupTemplate.create({
    data: {
      accountId: null,
      type: 'text',
      category: 'greeting',
      content,
      weight: 1,
      language: 'pt-BR',
      isActive: true,
    },
  });
  await prismaTest.warmupTemplate.create({
    data: {
      accountId: null,
      type: 'text',
      category: 'response',
      content,
      weight: 1,
      language: 'pt-BR',
      isActive: true,
    },
  });
}

describe('WarmupContentGenerator — useAi=false (default)', () => {
  it('sempre retorna source=template e nao chama provider', async () => {
    const { pool, number } = await setupAccountAndPool({ useAi: false });
    await seedMinimalTextTemplate();

    const oaiSpy = vi.spyOn(openaiProvider, 'generate');
    const anthSpy = vi.spyOn(anthropicProvider, 'generate');

    const out = await warmupContentGenerator.pick(pool, null, number);
    expect(out.source).toBe('template');
    expect(out.content).toBe('oi tudo bem');
    expect(oaiSpy).not.toHaveBeenCalled();
    expect(anthSpy).not.toHaveBeenCalled();
  });
});

describe('WarmupContentGenerator — useAi=true + provider habilitado + IA OK', () => {
  it('OpenAI retorna conteudo -> source=openai', async () => {
    const { pool, number } = await setupAccountAndPool({
      useAi: true,
      aiProvider: 'openai',
    });
    await seedMinimalTextTemplate();

    vi.spyOn(openaiProvider, 'isEnabled').mockReturnValue(true);
    vi.spyOn(openaiProvider, 'generate').mockResolvedValue({
      source: 'openai',
      type: 'text',
      content: 'eai blz',
      model: 'gpt-4o-mini',
      cost: { inputTokens: 30, outputTokens: 3, usdEstimate: 0.0000063 },
    });

    const out = await warmupContentGenerator.pick(pool, null, number);
    expect(out.source).toBe('openai');
    expect(out.content).toBe('eai blz');
  });

  it('Anthropic retorna conteudo -> source=anthropic', async () => {
    const { pool, number } = await setupAccountAndPool({
      useAi: true,
      aiProvider: 'anthropic',
    });
    await seedMinimalTextTemplate();

    vi.spyOn(anthropicProvider, 'isEnabled').mockReturnValue(true);
    vi.spyOn(anthropicProvider, 'generate').mockResolvedValue({
      source: 'anthropic',
      type: 'text',
      content: 'beleza',
      model: 'claude-haiku-4-5-20251001',
      cost: { inputTokens: 20, outputTokens: 2, usdEstimate: 0.00003 },
    });

    const out = await warmupContentGenerator.pick(pool, null, number);
    expect(out.source).toBe('anthropic');
    expect(out.content).toBe('beleza');
  });
});

describe('WarmupContentGenerator — useAi=true + provider DESABILITADO', () => {
  it('cai em template puro (nao marca fallback)', async () => {
    const { pool, number } = await setupAccountAndPool({
      useAi: true,
      aiProvider: 'openai',
    });
    await seedMinimalTextTemplate();

    vi.spyOn(openaiProvider, 'isEnabled').mockReturnValue(false);
    const generateSpy = vi.spyOn(openaiProvider, 'generate');

    const out = await warmupContentGenerator.pick(pool, null, number);
    expect(out.source).toBe('template');
    expect(out.content).toBe('oi tudo bem');
    expect(generateSpy).not.toHaveBeenCalled();
  });
});

describe('WarmupContentGenerator — useAi=true + provider habilitado + IA FALHA', () => {
  it('cai em template marcado como fallback', async () => {
    const { pool, number } = await setupAccountAndPool({
      useAi: true,
      aiProvider: 'openai',
    });
    await seedMinimalTextTemplate('fallback-content');

    vi.spyOn(openaiProvider, 'isEnabled').mockReturnValue(true);
    vi.spyOn(openaiProvider, 'generate').mockResolvedValue(null);

    const out = await warmupContentGenerator.pick(pool, null, number);
    expect(out.source).toBe('fallback');
    expect(out.content).toBe('fallback-content');
  });
});

describe('WarmupContentGenerator — propaga tone e model pro provider', () => {
  it('passa tone customizado (gym) e aiModel override', async () => {
    const { pool, number } = await setupAccountAndPool({
      useAi: true,
      aiProvider: 'openai',
      aiTone: 'gym',
      aiModel: 'gpt-4o',
    });
    await seedMinimalTextTemplate();

    vi.spyOn(openaiProvider, 'isEnabled').mockReturnValue(true);
    const genSpy = vi
      .spyOn(openaiProvider, 'generate')
      .mockResolvedValue({
        source: 'openai',
        type: 'text',
        content: 'malhei pesado hj',
        model: 'gpt-4o',
      });

    await warmupContentGenerator.pick(pool, null, number);
    expect(genSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'gym', currentDay: 2 }),
      'gpt-4o',
    );
  });

  it('aiTone invalido cai em casual', async () => {
    const { pool, number } = await setupAccountAndPool({
      useAi: true,
      aiProvider: 'openai',
      aiTone: 'tone-inexistente',
    });
    await seedMinimalTextTemplate();

    vi.spyOn(openaiProvider, 'isEnabled').mockReturnValue(true);
    const genSpy = vi
      .spyOn(openaiProvider, 'generate')
      .mockResolvedValue({ source: 'openai', type: 'text', content: 'oi' });

    await warmupContentGenerator.pick(pool, null, number);
    expect(genSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'casual' }),
      undefined,
    );
  });
});

describe('WarmupContentGenerator — fetchHistory', () => {
  it('mapeia mensagens passadas para sender me/peer corretamente', async () => {
    const { account, pool, number } = await setupAccountAndPool({
      useAi: true,
      aiProvider: 'openai',
    });
    await seedMinimalTextTemplate();

    const peer = await prismaTest.warmupNumber.create({
      data: {
        poolId: pool.id,
        accountId: account.id,
        evolutionInstance: 'inst-peer',
        phoneE164: '5511999990002',
        status: 'warming',
        currentDay: 2,
      },
    });

    const [a, b] =
      number.id < peer.id ? [number, peer] : [peer, number];
    const conv = await prismaTest.warmupConversation.create({
      data: { poolId: pool.id, numberAId: a.id, numberBId: b.id, isActive: true },
    });

    // 3 mensagens: peer -> me -> peer
    await prismaTest.warmupMessage.create({
      data: {
        conversationId: conv.id,
        senderId: peer.id,
        receiverId: number.id,
        messageType: 'text',
        content: 'oi',
        status: 'sent',
      },
    });
    await prismaTest.warmupMessage.create({
      data: {
        conversationId: conv.id,
        senderId: number.id,
        receiverId: peer.id,
        messageType: 'text',
        content: 'tudo bem',
        status: 'sent',
      },
    });
    await prismaTest.warmupMessage.create({
      data: {
        conversationId: conv.id,
        senderId: peer.id,
        receiverId: number.id,
        messageType: 'text',
        content: 'sim',
        status: 'sent',
      },
    });

    vi.spyOn(openaiProvider, 'isEnabled').mockReturnValue(true);
    const genSpy = vi
      .spyOn(openaiProvider, 'generate')
      .mockResolvedValue({ source: 'openai', type: 'text', content: 'show' });

    await warmupContentGenerator.pick(pool, conv, number);
    const ctx = genSpy.mock.calls[0][0];
    expect(ctx.conversationHistory).toEqual([
      { sender: 'peer', content: 'oi' },
      { sender: 'me', content: 'tudo bem' },
      { sender: 'peer', content: 'sim' },
    ]);
  });
});
