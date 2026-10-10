/**
 * OpenAIProvider.testConnection — mock do SDK 'openai'. Nunca bate em rede.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockList, mockCtor } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockCtor: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    models = { list: mockList };
    constructor(opts: any) {
      mockCtor(opts);
    }
  },
}));

import { OpenAIProvider, TIMEOUT_TESTE_DE_CHAVE_MS } from './openai-provider';

beforeEach(() => {
  mockList.mockReset();
  mockCtor.mockReset();
});

describe('OpenAIProvider.testConnection', () => {
  it('chave vazia -> ok:false sem chamar o SDK', async () => {
    const r = await new OpenAIProvider().testConnection('   ');
    expect(r).toEqual({ ok: false, message: 'Chave vazia' });
    expect(mockCtor).not.toHaveBeenCalled();
  });

  it('models.list ok -> ok:true, chave passada trimada e com timeout curto', async () => {
    mockList.mockResolvedValue({ data: [] });
    const r = await new OpenAIProvider().testConnection('  sk-abc  ');
    expect(r.ok).toBe(true);
    expect(mockCtor).toHaveBeenCalledWith({ apiKey: 'sk-abc', timeout: TIMEOUT_TESTE_DE_CHAVE_MS });
  });

  it('401 -> "Chave invalida"; 429 -> rate limit; outro erro -> mensagem truncada', async () => {
    const p = new OpenAIProvider();

    mockList.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }));
    expect((await p.testConnection('sk-x')).message).toBe('Chave invalida (401)');

    mockList.mockRejectedValueOnce(Object.assign(new Error('Too many'), { status: 429 }));
    expect((await p.testConnection('sk-x')).message).toBe('Rate limit atingido (429)');

    mockList.mockRejectedValueOnce(new Error('x'.repeat(300)));
    const r = await p.testConnection('sk-x');
    expect(r.ok).toBe(false);
    expect(r.message.length).toBeLessThanOrEqual('Falha na conexao: '.length + 200);
  });
});
