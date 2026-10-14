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

import { chat, acceptsTemperature, sanitizeSchemaForStrictOutput, ehModeloDeRaciocinio, priceFor } from './chat';

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

/** Nó de JSON Schema. Evita espalhar cast pelas asserções. */
type No = Record<string, unknown>;
const prop = (schema: No, nome: string): No => (schema.properties as Record<string, No>)[nome];

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

/*
  ETAPA G — modelos de raciocínio da OpenAI (gpt-5*, o1*, o3*, o4*).

  Três diferenças de contrato, cada uma 400 se ignorada: max_tokens virou
  max_completion_tokens, temperature não existe, reasoning_effort é aceito.
  O piloto com gpt-5 quebrava na primeira mensagem do lead.
*/
describe('OpenAI — modelos de raciocínio', () => {
  const openaiCreate = vi.fn();
  const respostaOpenAI = (model: string) => ({
    choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
    model,
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });

  beforeEach(() => {
    openaiCreate.mockReset();
    getOpenAIMock.mockResolvedValue({ chat: { completions: { create: openaiCreate } } });
  });

  const corpo = () => openaiCreate.mock.calls[0][0];

  it('ehModeloDeRaciocinio reconhece a família, sem pegar gpt-4o nem gpt-4.1', () => {
    for (const m of ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o1', 'o3-mini', 'o4-mini', 'GPT-5-mini']) {
      expect(ehModeloDeRaciocinio(m), m).toBe(true);
    }
    // Qualquer sufixo/versão do gpt-5 e toda a série o1..o9 — o piloto novo cai aqui, não na lista fixa.
    for (const m of ['gpt-5.1', 'gpt-5.2', 'gpt-5.4-mini', 'gpt-5.1-codex', 'gpt-5-chat-latest', 'gpt-5-2025-08-07', 'o3-pro', 'o1-preview', 'o4-mini-2025-04-16']) {
      expect(ehModeloDeRaciocinio(m), m).toBe(true);
      expect(acceptsTemperature(m), m).toBe(false);
    }
    for (const m of ['gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4.5-preview', 'chatgpt-4o-latest', 'omni-moderation-latest']) {
      expect(ehModeloDeRaciocinio(m), m).toBe(false);
    }
    expect(acceptsTemperature('gpt-5-mini')).toBe(false);
  });

  it('gpt-5-mini recebe max_completion_tokens (piso 8192) e reasoning_effort, e NÃO recebe temperature', async () => {
    openaiCreate.mockResolvedValue(respostaOpenAI('gpt-5-mini'));
    await chat({
      accountId: ACCOUNT,
      provider: 'openai',
      model: 'gpt-5-mini',
      temperature: 0.7,
      maxTokens: 1024,
      reasoningEffort: 'minimal',
      messages: [{ role: 'user', content: 'oi' }],
    });
    const b = corpo();
    expect(b.max_completion_tokens).toBe(8192);
    expect(b.max_tokens).toBeUndefined();
    expect(b.temperature).toBeUndefined();
    expect(b.reasoning_effort).toBe('minimal');
  });

  it('o limite do agente vira 4x pro raciocínio (piso 8192); sem reasoningEffort o campo não vai', async () => {
    openaiCreate.mockResolvedValue(respostaOpenAI('gpt-5'));
    await chat({ accountId: ACCOUNT, provider: 'openai', model: 'gpt-5', maxTokens: 4000, messages: [{ role: 'user', content: 'oi' }] });
    expect(corpo().max_completion_tokens).toBe(16000);
    expect(corpo().reasoning_effort).toBeUndefined();
  });

  it('gpt-5.2 e gpt-5.4-mini (fora da lista antiga) também vão como raciocínio: max_completion_tokens, sem temperature', async () => {
    for (const m of ['gpt-5.2', 'gpt-5.4-mini']) {
      openaiCreate.mockReset();
      openaiCreate.mockResolvedValue(respostaOpenAI(m));
      await chat({ accountId: ACCOUNT, provider: 'openai', model: m, temperature: 0.7, maxTokens: 1024, reasoningEffort: 'minimal', messages: [{ role: 'user', content: 'oi' }] });
      const b = corpo();
      expect(b.max_completion_tokens, m).toBe(8192);
      expect(b.max_tokens, m).toBeUndefined();
      expect(b.temperature, m).toBeUndefined();
      // 'minimal' só existe no gpt-5 original.
      expect(b.reasoning_effort, m).toBe('low');
    }
  });

  it('gpt-5-chat-latest: raciocínio no contrato de tokens, mas SEM reasoning_effort (recusa o campo)', async () => {
    openaiCreate.mockResolvedValue(respostaOpenAI('gpt-5-chat-latest'));
    await chat({ accountId: ACCOUNT, provider: 'openai', model: 'gpt-5-chat-latest', temperature: 0.7, reasoningEffort: 'high', messages: [{ role: 'user', content: 'oi' }] });
    const b = corpo();
    expect(b.max_completion_tokens).toBe(8192);
    expect(b.temperature).toBeUndefined();
    expect(b.reasoning_effort).toBeUndefined();
  });

  it('length com texto vazio (raciocínio gastou tudo): repete UMA vez com effort low e o dobro do limite; soma o custo das duas', async () => {
    openaiCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: '', tool_calls: [] }, finish_reason: 'length' }], model: 'gpt-5-mini', usage: { prompt_tokens: 100, completion_tokens: 8192 } })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Oi! Como posso ajudar?', tool_calls: [] }, finish_reason: 'stop' }], model: 'gpt-5-mini', usage: { prompt_tokens: 100, completion_tokens: 300 } });
    const r = await chat({ accountId: ACCOUNT, provider: 'openai', model: 'gpt-5-mini', maxTokens: 1024, reasoningEffort: 'high', messages: [{ role: 'user', content: 'oi' }] });
    expect(openaiCreate).toHaveBeenCalledTimes(2);
    expect(openaiCreate.mock.calls[0][0]).toMatchObject({ max_completion_tokens: 8192, reasoning_effort: 'high' });
    expect(openaiCreate.mock.calls[1][0]).toMatchObject({ max_completion_tokens: 16384, reasoning_effort: 'low' });
    expect(r.text).toBe('Oi! Como posso ajudar?');
    expect(r.finishReason).toBe('stop');
    expect(r.usage.inputTokens).toBe(200);
    expect(r.usage.outputTokens).toBe(8492);
  });

  it('a nova tentativa é UMA só: se a segunda também estourar, devolve o que veio (sem terceira chamada)', async () => {
    const estourou = { choices: [{ message: { content: '', tool_calls: [] }, finish_reason: 'length' }], model: 'gpt-5', usage: { prompt_tokens: 10, completion_tokens: 8192 } };
    openaiCreate.mockResolvedValue(estourou);
    const r = await chat({ accountId: ACCOUNT, provider: 'openai', model: 'gpt-5', messages: [{ role: 'user', content: 'oi' }] });
    expect(openaiCreate).toHaveBeenCalledTimes(2);
    expect(r.text).toBe('');
    expect(r.finishReason).toBe('length');
  });

  it('length COM texto (resposta cortada no meio) e modelo comum não repetem a chamada', async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'Resposta longa cort', tool_calls: [] }, finish_reason: 'length' }], model: 'gpt-5', usage: { prompt_tokens: 10, completion_tokens: 50 } });
    await chat({ accountId: ACCOUNT, provider: 'openai', model: 'gpt-5', messages: [{ role: 'user', content: 'oi' }] });
    expect(openaiCreate).toHaveBeenCalledTimes(1);

    openaiCreate.mockReset();
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: '', tool_calls: [] }, finish_reason: 'length' }], model: 'gpt-4.1', usage: { prompt_tokens: 10, completion_tokens: 50 } });
    await chat({ accountId: ACCOUNT, provider: 'openai', model: 'gpt-4.1', messages: [{ role: 'user', content: 'oi' }] });
    expect(openaiCreate).toHaveBeenCalledTimes(1);
  });

  it('série o*: "minimal" vira "low" (o4-mini não aceita minimal)', async () => {
    openaiCreate.mockResolvedValue(respostaOpenAI('o4-mini'));
    await chat({ accountId: ACCOUNT, provider: 'openai', model: 'o4-mini', reasoningEffort: 'minimal', messages: [{ role: 'user', content: 'oi' }] });
    expect(corpo().reasoning_effort).toBe('low');
  });

  it('gpt-4.1 continua com max_tokens + temperature, e ignora reasoningEffort', async () => {
    openaiCreate.mockResolvedValue(respostaOpenAI('gpt-4.1'));
    await chat({ accountId: ACCOUNT, provider: 'openai', model: 'gpt-4.1', temperature: 0.5, maxTokens: 800, reasoningEffort: 'high', messages: [{ role: 'user', content: 'oi' }] });
    const b = corpo();
    expect(b.max_tokens).toBe(800);
    expect(b.temperature).toBe(0.5);
    expect(b.max_completion_tokens).toBeUndefined();
    expect(b.reasoning_effort).toBeUndefined();
  });

  it('toolChoice none vai como tool_choice: "none" (ferramentas continuam declaradas)', async () => {
    openaiCreate.mockResolvedValue(respostaOpenAI('gpt-4.1'));
    await chat({
      accountId: ACCOUNT,
      provider: 'openai',
      model: 'gpt-4.1',
      tools: [{ name: 'x', description: 'x', parameters: { type: 'object', properties: {} } }],
      toolChoice: 'none',
      messages: [{ role: 'user', content: 'oi' }],
    });
    expect(corpo().tool_choice).toBe('none');
    expect(corpo().tools).toHaveLength(1);
  });
});

describe('tabela de preços', () => {
  it('vence o prefixo MAIS LONGO: o mini não é cobrado como o grande', () => {
    expect(priceFor('gpt-4.1-mini-2025-04-14')).toEqual({ input: 0.4, output: 1.6 });
    expect(priceFor('gpt-4.1-2025-04-14')).toEqual({ input: 2, output: 8 });
    expect(priceFor('gpt-5-nano')).toEqual({ input: 0.05, output: 0.4 });
    expect(priceFor('gpt-5')).toEqual({ input: 1.25, output: 10 });
    expect(priceFor('o4-mini-2025-04-16')).toEqual({ input: 1.1, output: 4.4 });
    expect(priceFor('gpt-4o-2024-08-06')).toEqual({ input: 2.5, output: 10 });
    expect(priceFor('gpt-4o-mini')).toEqual({ input: 0.15, output: 0.6 });
    expect(priceFor('modelo-desconhecido')).toBeNull();
  });

  it('o prefixo precisa de FRONTEIRA: gpt-5.1-mini / gpt-5.1 / gpt-5-pro não são o gpt-5 — sem preço, não chute', () => {
    for (const m of ['gpt-5.1-mini', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4-mini', 'gpt-5-pro', 'gpt-5-chat-latest', 'gpt-4o-audio-preview', 'o4-mini-deep-research']) {
      expect(priceFor(m), m).toBeNull();
    }
    // O carimbo de versão continua casando com a entrada.
    expect(priceFor('gpt-5-mini-2025-08-07')).toEqual({ input: 0.25, output: 2 });
    expect(priceFor('gpt-5-2025-08-07')).toEqual({ input: 1.25, output: 10 });
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 });
    expect(priceFor('gpt-4o-mini-2024-07-18')).toEqual({ input: 0.15, output: 0.6 });
  });

  it('modelo de versão não listada volta priced:false com custo 0 (não vira cobrança)', async () => {
    getOpenAIMock.mockResolvedValue({
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }], model: 'gpt-5.1-mini', usage: { prompt_tokens: 1000, completion_tokens: 500 } }) } },
    });
    const r = await chat({ accountId: ACCOUNT, provider: 'openai', model: 'gpt-5.1-mini', messages: [{ role: 'user', content: 'oi' }] });
    expect(r.usage).toMatchObject({ priced: false, usdEstimate: 0, inputTokens: 1000, outputTokens: 500 });
  });

  it('toolChoice none na Anthropic vai como { type: "none" }', async () => {
    await chat({
      accountId: ACCOUNT,
      provider: 'anthropic',
      tools: [{ name: 'x', description: 'x', parameters: { type: 'object', properties: {} } }],
      toolChoice: 'none',
      messages: [{ role: 'user', content: 'oi' }],
    });
    expect(bodyEnviado().tool_choice).toEqual({ type: 'none' });
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
    expect(prop(out, 'meta').additionalProperties).toBe(false);
  });

  it('remove restrições numéricas — a causa mais comum de 400', () => {
    const out = sanitizeSchemaForStrictOutput({
      type: 'object',
      properties: { confianca: { type: 'number', minimum: 0, maximum: 1 } },
      required: ['confianca'],
    });

    const campo = prop(out, 'confianca');
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
    expect(prop(out, 'etapa').enum).toEqual(['novo-lead', 'agendado']);
  });

  it('não altera o schema original — o validador interno usa a versão completa', () => {
    const original = {
      type: 'object',
      properties: { n: { type: 'number', minimum: 0 } },
    };
    sanitizeSchemaForStrictOutput(original);
    expect(prop(original, 'n').minimum).toBe(0);
  });

  it('desce em items de array', () => {
    const out = sanitizeSchemaForStrictOutput({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'object', properties: { v: { type: 'string' } }, minItems: 2 } },
      },
    });
    const items = prop(out, 'tags').items as No;
    expect(items.additionalProperties).toBe(false);
    expect(items.minItems).toBeUndefined();
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
