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

describe('WarmupContentGenerator — FIX-WARMUP-NO-TEMPLATE (sem template não trava)', () => {
  it('useAi=false e ZERO template de texto -> greeting hardcoded (content nunca vazio)', async () => {
    // Slate limpo de templates de texto pra exercitar o fallback hardcoded —
    // o bug era: sem WarmupTemplate, o gerador devolvia content='' e o tick
    // pulava com 'no-template' (aquecimento travado em 0 enviadas).
    await prismaTest.warmupTemplate.deleteMany({ where: { type: 'text' } });
    const { pool, number } = await setupAccountAndPool({ useAi: false });

    const out = await warmupContentGenerator.pick(pool, null, number);

    expect(out.type).toBe('text');
    expect(out.content).toBeTruthy(); // antes vinha ''
    expect(out.content.length).toBeGreaterThan(0);
    expect(out.source).toBe('fallback'); // veio do hardcoded, não do banco
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

// ============================================
// V2 — distribuicao por fase + fail-soft media + media fields
// ============================================

describe('WarmupContentGenerator V2 — distribuicao por fase do protocolo', () => {
  it('D1-D3: nunca retorna audio/sticker/image (so text/reaction)', async () => {
    const { pool, number } = await setupAccountAndPool({ useAi: false });
    await prismaTest.warmupNumber.update({
      where: { id: number.id },
      data: { currentDay: 2 },
    });
    // Seed apenas templates text + reaction (sem midia disponivel)
    await seedMinimalTextTemplate();
    await prismaTest.warmupTemplate.create({
      data: {
        accountId: null,
        type: 'reaction',
        category: 'reaction',
        content: '👍',
        weight: 1,
        language: 'pt-BR',
        isActive: true,
      },
    });

    // Roda 30x e confere que NUNCA aparece audio/sticker/image
    const numFresh = await prismaTest.warmupNumber.findUnique({
      where: { id: number.id },
    });
    for (let i = 0; i < 30; i++) {
      const out = await warmupContentGenerator.pick(pool, null, numFresh!);
      expect(['text', 'reaction']).toContain(out.type);
    }
  });

  it('D4-D7: distribuicao tem audio + image + sticker (com templates seedados)', async () => {
    const { pool, number } = await setupAccountAndPool({ useAi: false });
    await prismaTest.warmupNumber.update({
      where: { id: number.id },
      data: { currentDay: 5 },
    });
    // Seed templates de todos os tipos (com media)
    await seedMinimalTextTemplate();
    for (const t of ['audio', 'sticker', 'image']) {
      await prismaTest.warmupTemplate.create({
        data: {
          accountId: null,
          type: t,
          category: 'media',
          content: `${t}-tpl`,
          weight: 1,
          language: 'pt-BR',
          isActive: true,
          mediaPath: `dummy/warmup/${t}/file.bin`,
          mediaMimeType: t === 'audio' ? 'audio/ogg' : t === 'sticker' ? 'image/webp' : 'image/jpeg',
        },
      });
    }

    const numFresh = await prismaTest.warmupNumber.findUnique({
      where: { id: number.id },
    });

    // Roda muitas iteracoes e coleta tipos vistos
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const out = await warmupContentGenerator.pick(pool, null, numFresh!);
      seen.add(out.type);
    }

    // D4-D7 tem peso > 0 pra audio, sticker, image — em 200 amostras deve aparecer ao menos um de cada
    expect(seen.has('audio')).toBe(true);
    expect(seen.has('sticker') || seen.has('image')).toBe(true);
    // text sempre aparece
    expect(seen.has('text')).toBe(true);
  });

  it('fail-soft: se sorteia audio mas nao ha template audio, cai pra text', async () => {
    const { pool, number } = await setupAccountAndPool({ useAi: false });
    await prismaTest.warmupNumber.update({
      where: { id: number.id },
      data: { currentDay: 10 },
    });
    // Seed APENAS text (sem audio/sticker/image)
    await seedMinimalTextTemplate('fallback-msg');

    // Roda 50x — todos devem retornar text (nunca audio/sticker/image vazio)
    const numFresh = await prismaTest.warmupNumber.findUnique({
      where: { id: number.id },
    });
    for (let i = 0; i < 50; i++) {
      const out = await warmupContentGenerator.pick(pool, null, numFresh!);
      // Aceita text (fallback) ou reaction (se sorteia reaction sem template, retorna content vazio mas type=reaction)
      // Garantia principal: NAO retorna audio/sticker/image
      expect(['text', 'reaction']).toContain(out.type);
    }
  });

  it('template midia com mediaPath -> GeneratedContent traz mediaPath/mediaMimeType', async () => {
    const { pool, number } = await setupAccountAndPool({ useAi: false });
    await prismaTest.warmupNumber.update({
      where: { id: number.id },
      data: { currentDay: 10 },
    });

    // Seed APENAS template audio (forca audio sempre que sorteia audio)
    await prismaTest.warmupTemplate.create({
      data: {
        accountId: null,
        type: 'audio',
        category: 'media',
        content: 'audio-1',
        weight: 1,
        language: 'pt-BR',
        isActive: true,
        mediaPath: 'acc/warmup/audio/test.ogg',
        mediaMimeType: 'audio/ogg',
        mediaSizeBytes: 1234,
      },
    });
    // Tambem text como fallback (caso sorteie text)
    await seedMinimalTextTemplate();

    const numFresh = await prismaTest.warmupNumber.findUnique({
      where: { id: number.id },
    });

    // Roda ate sortear audio
    let audioOut: any = null;
    for (let i = 0; i < 500; i++) {
      const out = await warmupContentGenerator.pick(pool, null, numFresh!);
      if (out.type === 'audio') {
        audioOut = out;
        break;
      }
    }
    expect(audioOut).toBeTruthy();
    expect(audioOut.mediaPath).toBe('acc/warmup/audio/test.ogg');
    expect(audioOut.mediaMimeType).toBe('audio/ogg');
  });
});

describe('WarmupContentGenerator V2 — resolveMediaPayload', () => {
  it('prefere mediaUrl quando preenchido (URL absoluta)', async () => {
    const { resolveMediaPayload } = await import('./warmup-media-loader');
    const payload = await resolveMediaPayload({
      mediaUrl: 'https://cdn.example.com/audio.ogg',
      mediaPath: 'some/path/file.ogg',
    });
    expect(payload).toBe('https://cdn.example.com/audio.ogg');
  });

  it('path traversal -> throw', async () => {
    const { readMediaAsBase64 } = await import('./warmup-media-loader');
    await expect(readMediaAsBase64('../../../etc/passwd')).rejects.toThrow(
      /Path traversal detectado/,
    );
  });

  it('sem mediaPath e sem mediaUrl -> throw', async () => {
    const { resolveMediaPayload } = await import('./warmup-media-loader');
    await expect(resolveMediaPayload({})).rejects.toThrow(/Template sem media/);
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
