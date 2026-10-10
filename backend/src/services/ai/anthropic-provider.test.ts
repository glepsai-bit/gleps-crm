/**
 * AnthropicProvider.testConnection — mock do SDK '@anthropic-ai/sdk'. Nunca bate em rede.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate, mockCtor } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockCtor: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
    constructor(opts: any) {
      mockCtor(opts);
    }
  },
}));

import { AnthropicProvider } from './anthropic-provider';

beforeEach(() => {
  mockCreate.mockReset();
  mockCtor.mockReset();
});

describe('AnthropicProvider.testConnection', () => {
  it('chave vazia -> ok:false sem chamar o SDK', async () => {
    const r = await new AnthropicProvider().testConnection('');
    expect(r).toEqual({ ok: false, message: 'Chave vazia' });
    expect(mockCtor).not.toHaveBeenCalled();
  });

  it('ping de 1 token ok -> ok:true', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'hi' }] });
    const r = await new AnthropicProvider().testConnection(' sk-ant ');
    expect(r.ok).toBe(true);
    expect(mockCtor.mock.calls[0][0].apiKey).toBe('sk-ant');
    expect(mockCreate.mock.calls[0][0].max_tokens).toBe(1);
  });

  it('401 -> "Chave invalida"; 403 -> sem permissao', async () => {
    const p = new AnthropicProvider();
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 401 }));
    expect((await p.testConnection('k')).message).toBe('Chave invalida (401)');
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 403 }));
    expect((await p.testConnection('k')).message).toBe('Chave sem permissao (403)');
  });
});
