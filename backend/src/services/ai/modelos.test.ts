/**
 * ETAPA G — o modelo existe, e a chave alcança ele?
 *
 * O que está em jogo: a listagem da OpenAI só roda uma vez por conta+chave a
 * cada 10 min; 401 (chave inválida) bloqueia com mensagem de chave; 403
 * (sem permissão de listar), rede fora e conta sem chave NÃO bloqueiam.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const listMock = vi.hoisted(() => vi.fn());
const getOpenAIMock = vi.hoisted(() => vi.fn());
const resolveKeyMock = vi.hoisted(() => vi.fn());

vi.mock('./client-factory', () => {
  class AiKeyMissingError extends Error {}
  return {
    getOpenAI: getOpenAIMock,
    resolveKey: resolveKeyMock,
    AiKeyMissingError,
  };
});
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { validarModelo, exigirModeloValido, invalidarCacheDeModelos, __limparCacheDeModelos } from './modelos';
import { AiKeyMissingError } from './client-factory';

const ACC = 'acc-1';

/** A lista paginada do SDK: um async iterable. */
function pagina(ids: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const id of ids) yield { id };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __limparCacheDeModelos();
  resolveKeyMock.mockResolvedValue({ key: 'sk-x', source: 'account' });
  getOpenAIMock.mockResolvedValue({ models: { list: listMock } });
  listMock.mockResolvedValue(pagina(['gpt-4.1', 'gpt-4.1-mini', 'gpt-5-mini', 'gpt-4o-mini']));
});

describe('OpenAI', () => {
  it('modelo da lista passa; fora da lista é recusado com a mensagem do contrato', async () => {
    expect(await validarModelo({ accountId: ACC, provider: 'openai', model: 'gpt-5-mini' })).toEqual({ ok: true, model: 'gpt-5-mini', verificado: true });
    const r = await validarModelo({ accountId: ACC, provider: 'openai', model: 'gpt-5-ultra' });
    expect(r).toMatchObject({ ok: false, codigo: 'MODELO_INEXISTENTE' });
    expect((r as { motivo: string }).motivo).toBe('Modelo "gpt-5-ultra" não existe ou a chave não tem acesso. Confira o nome do modelo e a chave de IA da conta.');
  });

  it('a listagem roda UMA vez por conta em 10 min — e invalidar derruba o cache', async () => {
    await validarModelo({ accountId: ACC, provider: 'openai', model: 'gpt-4.1' });
    await validarModelo({ accountId: ACC, provider: 'openai', model: 'gpt-4.1-mini' });
    await validarModelo({ accountId: ACC, provider: 'openai', model: 'nao-existe' });
    expect(listMock).toHaveBeenCalledTimes(1);

    // Outra conta, outra chave: lista de novo.
    await validarModelo({ accountId: 'acc-2', provider: 'openai', model: 'gpt-4.1' });
    expect(listMock).toHaveBeenCalledTimes(2);

    invalidarCacheDeModelos(ACC);
    await validarModelo({ accountId: ACC, provider: 'openai', model: 'gpt-4.1' });
    expect(listMock).toHaveBeenCalledTimes(3);
  });

  it('401 = chave INVÁLIDA: bloqueia dizendo isso (não "modelo não existe")', async () => {
    listMock.mockRejectedValue(Object.assign(new Error('Incorrect API key'), { status: 401 }));
    const r = await validarModelo({ accountId: ACC, provider: 'openai', model: 'gpt-4.1' });
    expect(r).toMatchObject({ ok: false, codigo: 'CHAVE_SEM_ACESSO' });
    expect((r as { motivo: string }).motivo).toContain('chave OpenAI da conta é inválida');
    expect((r as { motivo: string }).motivo).not.toContain('não existe');
    await expect(exigirModeloValido({ accountId: ACC, provider: 'openai', model: 'gpt-4.1' })).rejects.toThrow(/é inválida/);
  });

  it('403 (chave restrita, sem permissão de listar) NÃO bloqueia: passa sem conferir, com aviso', async () => {
    listMock.mockRejectedValue(Object.assign(new Error('insufficient permissions'), { status: 403 }));
    const r = await validarModelo({ accountId: ACC, provider: 'openai', model: 'gpt-4.1' });
    expect(r).toMatchObject({ ok: true, model: 'gpt-4.1', verificado: false });
    expect((r as { aviso: string }).aviso).toContain('não tem permissão para listar os modelos');
  });

  it('o cache é por CHAVE: trocar a chave da conta lista de novo, sem ninguém invalidar', async () => {
    await validarModelo({ accountId: ACC, provider: 'openai', model: 'gpt-4.1' });
    await validarModelo({ accountId: ACC, provider: 'openai', model: 'gpt-4.1-mini' });
    expect(listMock).toHaveBeenCalledTimes(1);

    // A chave mudou (Integrações / PUT /accounts): o cache da chave antiga não vale.
    resolveKeyMock.mockResolvedValue({ key: 'sk-outra-chave', source: 'account' });
    listMock.mockResolvedValue(pagina(['gpt-4.1']));
    const nova = await validarModelo({ accountId: ACC, provider: 'openai', model: 'gpt-5-mini' });
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(nova).toMatchObject({ ok: false, codigo: 'MODELO_INEXISTENTE' }); // a chave nova NÃO alcança o gpt-5-mini

    // Voltar à chave antiga reencontra a entrada dela (ainda dentro dos 10 min).
    resolveKeyMock.mockResolvedValue({ key: 'sk-x', source: 'account' });
    expect(await validarModelo({ accountId: ACC, provider: 'openai', model: 'gpt-5-mini' })).toMatchObject({ ok: true, verificado: true });
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('rede fora NÃO bloqueia: passa sem conferir, com aviso', async () => {
    listMock.mockRejectedValue(Object.assign(new Error('ECONNRESET'), { status: undefined }));
    const r = await validarModelo({ accountId: ACC, provider: 'openai', model: 'gpt-4.1' });
    expect(r).toMatchObject({ ok: true, verificado: false });
    expect((r as { aviso: string }).aviso).toContain('Não foi possível conferir');
  });

  it('conta sem chave NÃO bloqueia: não há o que conferir', async () => {
    resolveKeyMock.mockRejectedValue(new AiKeyMissingError('openai'));
    const r = await validarModelo({ accountId: ACC, provider: 'openai', model: 'gpt-4.1' });
    expect(r).toMatchObject({ ok: true, verificado: false });
    expect(listMock).not.toHaveBeenCalled();
  });

  it('modelo vazio = padrão do provider: sempre ok, sem listar', async () => {
    expect(await validarModelo({ accountId: ACC, provider: 'openai', model: '' })).toMatchObject({ ok: true, verificado: true });
    expect(await validarModelo({ accountId: ACC, provider: 'openai', model: null })).toMatchObject({ ok: true });
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe('Anthropic — tabela fixa por família', () => {
  it('aceita as famílias conhecidas, com ou sem data; recusa o resto', async () => {
    for (const m of ['claude-haiku-4-5-20251001', 'claude-opus-4-1', 'claude-sonnet-5', 'claude-fable-5-1']) {
      expect((await validarModelo({ accountId: ACC, provider: 'anthropic', model: m })).ok, m).toBe(true);
    }
    expect((await validarModelo({ accountId: ACC, provider: 'anthropic', model: 'claude-6' })).ok).toBe(false);
    expect((await validarModelo({ accountId: ACC, provider: 'anthropic', model: 'gpt-4.1' })).ok).toBe(false);
    expect(getOpenAIMock).not.toHaveBeenCalled();
  });
});

describe('exigirModeloValido', () => {
  it('lança 400 com a mensagem; devolve o resultado quando passa', async () => {
    await expect(exigirModeloValido({ accountId: ACC, provider: 'openai', model: 'nope' })).rejects.toThrow(/Modelo "nope" não existe ou a chave não tem acesso/);
    const r = await exigirModeloValido({ accountId: ACC, provider: 'openai', model: 'gpt-4.1' });
    expect(r.verificado).toBe(true);
  });
});
