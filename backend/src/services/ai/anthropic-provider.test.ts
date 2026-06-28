/**
 * T-023 Fase 2 — AnthropicProvider unit tests
 *
 * Mock do SDK '@anthropic-ai/sdk'. Nunca bate em rede real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate, mockWarn } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
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

import { AnthropicProvider } from './anthropic-provider';
import type { ContentContext } from './types';

const baseCtx: ContentContext = {
  currentDay: 5,
  conversationHistory: [],
  tone: 'casual',
};

beforeEach(() => {
  mockCreate.mockReset();
  mockWarn.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
});

describe('AnthropicProvider — sem ANTHROPIC_API_KEY', () => {
  it('isEnabled retorna false e generate retorna null', async () => {
    const provider = new AnthropicProvider();
    (provider as any).client = null;
    expect(provider.isEnabled()).toBe(false);
    const out = await provider.generate(baseCtx);
    expect(out).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('AnthropicProvider — com client mockado', () => {
  function makeProvider() {
    const provider = new AnthropicProvider();
    (provider as any).client = { messages: { create: mockCreate } };
    return provider;
  }

  it('resposta valida -> source=anthropic, content limpo, cost calculado', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'tudo certo' }],
      usage: { input_tokens: 40, output_tokens: 6 },
    });
    const provider = makeProvider();
    const out = await provider.generate(baseCtx);
    expect(out).not.toBeNull();
    expect(out!.source).toBe('anthropic');
    expect(out!.type).toBe('text');
    expect(out!.content).toBe('tudo certo');
    expect(out!.cost?.inputTokens).toBe(40);
    expect(out!.cost?.outputTokens).toBe(6);
    // 40 * 1/1M + 6 * 5/1M = 0.00004 + 0.00003 = 0.00007
    expect(out!.cost?.usdEstimate).toBeCloseTo(0.00007, 10);
  });

  it('resposta com aspas -> remove aspas', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: "'oi blz?'" }],
      usage: { input_tokens: 10, output_tokens: 3 },
    });
    const provider = makeProvider();
    const out = await provider.generate(baseCtx);
    expect(out?.content).toBe('oi blz?');
  });

  it('content block nao-text -> retorna null', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', input: {} }],
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    const provider = makeProvider();
    const out = await provider.generate(baseCtx);
    expect(out).toBeNull();
  });

  it('resposta > 200 chars -> retorna null', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'a'.repeat(250) }],
      usage: { input_tokens: 10, output_tokens: 60 },
    });
    const provider = makeProvider();
    const out = await provider.generate(baseCtx);
    expect(out).toBeNull();
  });

  it('SDK throw -> retorna null e loga warn', async () => {
    mockCreate.mockRejectedValue(new Error('overloaded'));
    const provider = makeProvider();
    const out = await provider.generate(baseCtx);
    expect(out).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(
      '[warmup-ai/anthropic] erro, fallback',
      expect.objectContaining({ error: 'overloaded' }),
    );
  });

  it('passa model override para o SDK', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'oi' }],
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const provider = makeProvider();
    await provider.generate(baseCtx, 'claude-sonnet-4-5');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-5' }),
    );
  });
});
