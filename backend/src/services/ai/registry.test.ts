/**
 * T-023 Fase 2 — Registry tests
 *
 * Verifica:
 *  - getProvider retorna a instancia esperada (e null pra nome desconhecido)
 *  - listEnabledProviders reflete o estado de isEnabled() de cada singleton
 *  - isAnyProviderEnabled
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  getProvider,
  listEnabledProviders,
  isAnyProviderEnabled,
} from './registry';
import { openaiProvider } from './openai-provider';
import { anthropicProvider } from './anthropic-provider';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registry.getProvider', () => {
  it('retorna openaiProvider para "openai"', () => {
    expect(getProvider('openai')).toBe(openaiProvider);
  });

  it('retorna anthropicProvider para "anthropic"', () => {
    expect(getProvider('anthropic')).toBe(anthropicProvider);
  });

  it('retorna null para nome inexistente', () => {
    expect(getProvider('inexistente' as any)).toBeNull();
  });

  it('retorna null para null/undefined/string vazia', () => {
    expect(getProvider(null)).toBeNull();
    expect(getProvider(undefined)).toBeNull();
    expect(getProvider('')).toBeNull();
  });
});

describe('registry.listEnabledProviders', () => {
  it('reflete enabled=false quando providers nao tem client', () => {
    vi.spyOn(openaiProvider, 'isEnabled').mockReturnValue(false);
    vi.spyOn(anthropicProvider, 'isEnabled').mockReturnValue(false);
    const list = listEnabledProviders();
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'openai', enabled: false }),
        expect.objectContaining({ name: 'anthropic', enabled: false }),
      ]),
    );
    expect(isAnyProviderEnabled()).toBe(false);
  });

  it('reflete openai enabled quando isEnabled() retorna true', () => {
    vi.spyOn(openaiProvider, 'isEnabled').mockReturnValue(true);
    vi.spyOn(anthropicProvider, 'isEnabled').mockReturnValue(false);
    const list = listEnabledProviders();
    const oai = list.find(p => p.name === 'openai');
    const anth = list.find(p => p.name === 'anthropic');
    expect(oai?.enabled).toBe(true);
    expect(anth?.enabled).toBe(false);
    expect(isAnyProviderEnabled()).toBe(true);
  });

  it('expõe defaultModel de cada provider', () => {
    const list = listEnabledProviders();
    const oai = list.find(p => p.name === 'openai');
    const anth = list.find(p => p.name === 'anthropic');
    expect(oai?.defaultModel).toBeTruthy();
    expect(anth?.defaultModel).toBeTruthy();
  });
});
