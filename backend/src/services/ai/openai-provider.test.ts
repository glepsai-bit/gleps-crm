/**
 * T-023 Fase 2 — OpenAIProvider unit tests
 *
 * Mock do SDK 'openai'. Nunca bate em rede real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock do SDK ANTES de qualquer import — vi.mock eh hoisted. Usa vi.hoisted
// pra acessar as fn refs apos o hoist sem ReferenceError.
const { mockCreate, mockWarn } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockCreate } };
      constructor(_opts: any) {}
    },
  };
});

vi.mock('../../utils/logger', () => ({
  logger: {
    warn: mockWarn,
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { OpenAIProvider } from './openai-provider';
import type { ContentContext } from './types';

const baseCtx: ContentContext = {
  currentDay: 5,
  conversationHistory: [],
  tone: 'casual',
};

beforeEach(() => {
  mockCreate.mockReset();
  mockWarn.mockReset();
  delete process.env.OPENAI_API_KEY;
});

describe('OpenAIProvider — sem OPENAI_API_KEY', () => {
  it('isEnabled retorna false e generate retorna null', async () => {
    // env eh resolvido na hora do import; reinstanciar manualmente sem key
    const provider = new OpenAIProvider();
    // Forcamos o estado interno — env do vitest tem key vazia
    (provider as any).client = null;
    expect(provider.isEnabled()).toBe(false);
    const out = await provider.generate(baseCtx);
    expect(out).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('OpenAIProvider — com client mockado', () => {
  function makeProvider() {
    const provider = new OpenAIProvider();
    // Garante client mesmo se env nao tem key
    (provider as any).client = {
      chat: { completions: { create: mockCreate } },
    };
    return provider;
  }

  it('resposta valida -> source=openai, content limpo, cost calculado', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'bom dia' } }],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    });
    const provider = makeProvider();
    const out = await provider.generate(baseCtx);
    expect(out).not.toBeNull();
    expect(out!.source).toBe('openai');
    expect(out!.type).toBe('text');
    expect(out!.content).toBe('bom dia');
    expect(out!.cost?.inputTokens).toBe(50);
    expect(out!.cost?.outputTokens).toBe(5);
    // 50 * 0.15/1M + 5 * 0.60/1M = 0.0000075 + 0.000003 = 0.0000105
    expect(out!.cost?.usdEstimate).toBeCloseTo(0.0000105, 10);
  });

  it('resposta com aspas -> remove aspas', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '"oi blz?"' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    });
    const provider = makeProvider();
    const out = await provider.generate(baseCtx);
    expect(out?.content).toBe('oi blz?');
  });

  it('resposta com prefixo "Eu:" -> remove', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Eu: e ai mano' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
    const provider = makeProvider();
    const out = await provider.generate(baseCtx);
    expect(out?.content).toBe('e ai mano');
  });

  it('resposta > 200 chars -> retorna null', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'x'.repeat(250) } }],
      usage: { prompt_tokens: 10, completion_tokens: 60 },
    });
    const provider = makeProvider();
    const out = await provider.generate(baseCtx);
    expect(out).toBeNull();
  });

  it('resposta vazia -> retorna null', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '   ' } }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });
    const provider = makeProvider();
    const out = await provider.generate(baseCtx);
    expect(out).toBeNull();
  });

  it('SDK throw -> retorna null e loga warn', async () => {
    mockCreate.mockRejectedValue(new Error('rate limit'));
    const provider = makeProvider();
    const out = await provider.generate(baseCtx);
    expect(out).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(
      '[warmup-ai/openai] erro, fallback',
      expect.objectContaining({ error: 'rate limit' }),
    );
  });

  it('passa model override para o SDK', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'oi' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
    const provider = makeProvider();
    await provider.generate(baseCtx, 'gpt-4o');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o' }),
    );
  });
});
