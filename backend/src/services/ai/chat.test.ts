/**
 * T-027 — regressões da camada de chat.
 *
 * Os três casos aqui foram achados numa revisão adversarial antes do primeiro
 * uso real, e todos quebravam SÓ no caminho Anthropic — o tipo de defeito que
 * só aparece na conta que escolheu Claude, dias depois.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());
const getAnthropicMock = vi.hoisted(() => vi.fn());
const getOpenAIMock = vi.hoisted(() => vi.fn());

vi.mock('./client-factory', () => ({
  getAnthropic: getAnthropicMock,
  getOpenAI: getOpenAIMock,
  resolveKey: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { chat, acceptsTemperature, sanitizeSchemaForStrictOutput } from './chat';

const ACCOUNT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const okResponse = (text = 'ok') => ({
  content: [{ type: 'text', text }],
  model: 'claude-haiku-4-5-20251001',
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
});

beforeEach(() => {
  vi.clearAllMocks();
  getAnthropicMock.mockResolvedValue({ messages: { create: createMock } });
  createMock.mockResolvedValue(okResponse());
});

const bodyEnviado = () => createMock.mock.calls[0][0];

describe('acceptsTemperature', () => {
  it('modelos que aceitam sampling', () => {
    expect(acceptsTemperature('claude-haiku-4-5-20251001')).toBe(true);
    expect(acceptsTemperature('gpt-4o-mini')).toBe(true);
  });

  it('família 5 e Opus 4.7+ rejeitam — mandar temperature é 400', () => {
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5']) {
      expect(acceptsTemperature(m)).toBe(false);
    }
  });
});

describe('chatAnthropic — primeira mensagem precisa ser do usuário', () => {
  it('descarta assistant do início do histórico', async () => {
    await chat({
      accountId: ACCOUNT,
      provider: 'anthropic',
      messages: [
        // Conversa aberta por disparo: o bot falou primeiro.
        { role: 'assistant', content: 'Oi! Tudo bem?' },
        { role: 'assistant', content: 'Vi que você tem interesse.' },
        { role: 'user', content: 'quero saber o preço' },
      ],
    });

    const msgs = bodyEnviado().messages;
    expect(msgs[0].role).toBe('user');
    expect(msgs).toHaveLength(1);
  });

  it('histórico que já começa com user é preservado inteiro', async () => {
    await chat({
      accountId: ACCOUNT,
      provider: 'anthropic',
      messages: [
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: 'olá' },
        { role: 'user', content: 'preço?' },
      ],
    });

    expect(bodyEnviado().messages).toHaveLength(3);
    expect(bodyEnviado().messages[0].role).toBe('user');
  });

  it('só assistant vira erro claro, não 400 cru da API', async () => {
    await expect(
      chat({
        accountId: ACCOUNT,
        provider: 'anthropic',
        messages: [{ role: 'assistant', content: 'oi' }],
      })
    ).rejects.toThrow(/Nenhuma mensagem de usuário/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('temperature não é enviada pros modelos que a rejeitam', async () => {
    await chat({
      accountId: ACCOUNT,
      provider: 'anthropic',
      model: 'claude-opus-5',
      temperature: 0.7,
      messages: [{ role: 'user', content: 'oi' }],
    });

    expect(bodyEnviado().temperature).toBeUndefined();
  });
});

describe('sanitizeSchemaForStrictOutput', () => {
  it('fecha todo objeto com additionalProperties: false', () => {
    const out = sanitizeSchemaForStrictOutput({
      type: 'object',
      properties: {
        etapa: { type: 'string' },
        meta: { type: 'object', properties: { origem: { type: 'string' } } },
      },
    });

    expect(out.additionalProperties).toBe(false);
    expect((out.properties as Record<string, Record<string, unknown>>).meta.additionalProperties).toBe(false);
  });

  it('remove restrições numéricas — a causa mais comum de 400', () => {
    const out = sanitizeSchemaForStrictOutput({
      type: 'object',
      properties: { confianca: { type: 'number', minimum: 0, maximum: 1 } },
      required: ['confianca'],
    });

    const campo = (out.properties as Record<string, Record<string, unknown>>).confianca;
    expect(campo.minimum).toBeUndefined();
    expect(campo.maximum).toBeUndefined();
    expect(campo.type).toBe('number');
    expect(out.required).toEqual(['confianca']); // required é suportado, fica
  });

  it('preserva enum — é o que impede etapa inventada no kanban', () => {
    const out = sanitizeSchemaForStrictOutput({
      type: 'object',
      properties: { etapa: { type: 'string', enum: ['novo-lead', 'agendado'] } },
    });
    expect((out.properties as Record<string, Record<string, unknown>>).etapa.enum).toEqual(['novo-lead', 'agendado']);
  });

  it('não altera o schema original — o validador interno usa a versão completa', () => {
    const original = {
      type: 'object',
      properties: { n: { type: 'number', minimum: 0 } },
    };
    sanitizeSchemaForStrictOutput(original);
    expect((original.properties as Record<string, Record<string, unknown>>).n.minimum).toBe(0);
  });

  it('desce em items de array', () => {
    const out = sanitizeSchemaForStrictOutput({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'object', properties: { v: { type: 'string' } }, minItems: 2 } },
      },
    });
    const items = (out.properties as Record<string, Record<string, unknown>>).tags.items;
    expect(items.additionalProperties).toBe(false);
    expect((out.properties as Record<string, Record<string, unknown>>).tags.items.minItems).toBeUndefined();
  });
});

describe('saída estruturada rejeitada — cai pro modo instrução em vez de derrubar', () => {
  it('400 de schema vira segunda tentativa sem output_config', async () => {
    const erro = Object.assign(new Error('output_config.format: schema is invalid'), {
      status: 400,
    });
    createMock.mockRejectedValueOnce(erro).mockResolvedValueOnce(okResponse('{"etapa":"agendado"}'));

    const res = await chat({
      accountId: ACCOUNT,
      provider: 'anthropic',
      system: 'Você classifica.',
      messages: [{ role: 'user', content: 'oi' }],
      jsonSchema: { name: 'r', schema: { type: 'object', properties: { etapa: { type: 'string' } } } },
    });

    expect(createMock).toHaveBeenCalledTimes(2);
    const segunda = createMock.mock.calls[1][0];
    expect(segunda.output_config).toBeUndefined();
    // O schema vira instrução no system pra não perder o formato.
    expect(segunda.system).toContain('JSON Schema');
    expect(segunda.system).toContain('Você classifica.');
    expect(res.text).toContain('agendado');
  });

  it('erro que NÃO é de schema sobe — não mascara credencial/cota', async () => {
    const erro = Object.assign(new Error('rate limit exceeded'), { status: 429 });
    createMock.mockRejectedValueOnce(erro);

    await expect(
      chat({
        accountId: ACCOUNT,
        provider: 'anthropic',
        messages: [{ role: 'user', content: 'oi' }],
        jsonSchema: { name: 'r', schema: { type: 'object' } },
      })
    ).rejects.toThrow(/rate limit/);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe('recusa por política', () => {
  it('stop_reason refusal vira erro explicativo, não leitura de content vazio', async () => {
    createMock.mockResolvedValue({
      content: [],
      model: 'claude-opus-5',
      stop_reason: 'refusal',
      usage: { input_tokens: 5, output_tokens: 0 },
    });

    await expect(
      chat({
        accountId: ACCOUNT,
        provider: 'anthropic',
        messages: [{ role: 'user', content: 'oi' }],
      })
    ).rejects.toThrow(/recusou/i);
  });
});
