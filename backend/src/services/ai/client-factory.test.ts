/**
 * T-027 Fase 1 — resolução de chave de IA por conta.
 *
 * A regra que importa: a chave da CONTA ganha da chave do ENV. Se isso
 * inverter, um tenant passa a gastar a cota da plataforma sem ninguém perceber
 * — e o custo aparece na fatura da Mychooice, não na dele.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  account: { findUnique: vi.fn() },
}));
vi.mock('../../config/database', () => ({ prisma: prismaMock }));

vi.mock('../../config/env', () => ({
  env: { OPENAI_API_KEY: 'env-openai-key', ANTHROPIC_API_KEY: '' },
}));

import {
  resolveKey,
  hasProvider,
  invalidateAccountKeys,
  __clearKeyCache,
} from './client-factory';

const ACCOUNT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

beforeEach(() => {
  vi.clearAllMocks();
  __clearKeyCache();
});

describe('resolveKey', () => {
  it('chave da conta ganha da chave do env', async () => {
    prismaMock.account.findUnique.mockResolvedValue({
      openaiApiKey: 'conta-openai-key',
      anthropicApiKey: null,
    });

    expect(await resolveKey(ACCOUNT, 'openai')).toEqual({
      key: 'conta-openai-key',
      source: 'account',
    });
  });

  it('sem chave na conta, cai no env e sinaliza a origem', async () => {
    prismaMock.account.findUnique.mockResolvedValue({
      openaiApiKey: null,
      anthropicApiKey: null,
    });

    expect(await resolveKey(ACCOUNT, 'openai')).toEqual({ key: 'env-openai-key', source: 'env' });
  });

  it('string vazia na conta conta como ausente (a tela grava "" pra limpar)', async () => {
    prismaMock.account.findUnique.mockResolvedValue({
      openaiApiKey: '   ',
      anthropicApiKey: null,
    });

    expect((await resolveKey(ACCOUNT, 'openai')).source).toBe('env');
  });

  it('sem chave em lugar nenhum falha alto, com instrução de onde cadastrar', async () => {
    prismaMock.account.findUnique.mockResolvedValue({
      openaiApiKey: null,
      anthropicApiKey: null,
    });

    // Asserção por statusCode/mensagem, não por `instanceof AiKeyMissingError`:
    // o construtor de AppError faz setPrototypeOf(this, AppError.prototype), o
    // que achata TODA subclasse — `instanceof` de subclasse é sempre false no
    // projeto hoje. Bug pré-existente de utils/errors.ts, fora do escopo daqui.
    await expect(resolveKey(ACCOUNT, 'anthropic')).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringMatching(/Integrações/),
    });
  });

  it('conta inexistente não explode — trata como sem chave própria', async () => {
    prismaMock.account.findUnique.mockResolvedValue(null);
    expect((await resolveKey(ACCOUNT, 'openai')).source).toBe('env');
  });

  it('cacheia a leitura: 2 chamadas, 1 query', async () => {
    prismaMock.account.findUnique.mockResolvedValue({
      openaiApiKey: 'k',
      anthropicApiKey: null,
    });

    await resolveKey(ACCOUNT, 'openai');
    await resolveKey(ACCOUNT, 'openai');

    expect(prismaMock.account.findUnique).toHaveBeenCalledTimes(1);
  });

  it('invalidateAccountKeys derruba o cache — chave nova vale na mensagem seguinte', async () => {
    prismaMock.account.findUnique.mockResolvedValueOnce({
      openaiApiKey: 'antiga',
      anthropicApiKey: null,
    });
    expect((await resolveKey(ACCOUNT, 'openai')).key).toBe('antiga');

    invalidateAccountKeys(ACCOUNT);
    prismaMock.account.findUnique.mockResolvedValueOnce({
      openaiApiKey: 'nova',
      anthropicApiKey: null,
    });

    expect((await resolveKey(ACCOUNT, 'openai')).key).toBe('nova');
  });
});

describe('hasProvider', () => {
  it('true quando há chave, false quando não há — sem lançar', async () => {
    prismaMock.account.findUnique.mockResolvedValue({
      openaiApiKey: null,
      anthropicApiKey: null,
    });

    expect(await hasProvider(ACCOUNT, 'openai')).toBe(true); // via env
    expect(await hasProvider(ACCOUNT, 'anthropic')).toBe(false); // env vazio
  });
});
