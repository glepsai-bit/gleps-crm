/**
 * T-027 Fase 1 — chamada de chat unificada (OpenAI + Anthropic).
 *
 * O provider layer do warmup só sabe "gerar uma frase". O atendimento precisa
 * de três coisas que ele não tem: histórico de conversa, FERRAMENTAS (function
 * calling) e SAÍDA ESTRUTURADA validada — que é o que o `Output_Parser` do n8n
 * faz hoje.
 *
 * O formato aqui é neutro de propósito: o executor de nó `ai.agent` não pode
 * saber qual provider a conta escolheu. Cada adapter traduz pro SDK e devolve
 * o mesmo `ChatResult`.
 */

import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { getOpenAI, getAnthropic, type AiProviderName } from './client-factory';
import { logger } from '../../utils/logger';
import { AppError } from '../../utils/errors';

const DEFAULT_TIMEOUT_MS = 60_000;

export const DEFAULT_MODEL: Record<AiProviderName, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
};

export interface ChatToolDef {
  name: string;
  description: string;
  /** JSON Schema dos argumentos. */
  parameters: Record<string, unknown>;
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** role='assistant' que pediu ferramentas */
  toolCalls?: ChatToolCall[];
  /** role='tool' — id da chamada que este resultado responde */
  toolCallId?: string;
}

export interface ChatRequest {
  accountId: string;
  provider: AiProviderName;
  model?: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ChatToolDef[];
  /** JSON Schema da resposta. Presente = saída estruturada obrigatória. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  usdEstimate: number;
  /** false quando o modelo não está na tabela de preços — o custo é 0 e não deve virar cobrança. */
  priced: boolean;
}

export interface ChatResult {
  text: string;
  toolCalls: ChatToolCall[];
  model: string;
  provider: AiProviderName;
  usage: ChatUsage;
  finishReason: string;
}

// ============================================
// Preços (USD por 1M tokens)
// ============================================
// Só entram modelos com preço confirmado. Modelo fora da tabela devolve
// priced:false em vez de um número inventado — custo estimado errado é pior
// que custo ausente, porque vira teto de gasto e cobrança pro cliente.
const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // OpenAI
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

/** Casa 'claude-haiku-4-5-20251001' com a entrada 'claude-haiku-4-5'. */
function priceFor(model: string): { input: number; output: number } | null {
  if (PRICING[model]) return PRICING[model];
  const prefix = Object.keys(PRICING).find((k) => model.startsWith(k));
  return prefix ? PRICING[prefix] : null;
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): ChatUsage {
  const p = priceFor(model);
  if (!p) {
    logger.warn('[ai/chat] modelo sem preço na tabela — custo não estimado', { model });
    return { inputTokens, outputTokens, usdEstimate: 0, priced: false };
  }
  return {
    inputTokens,
    outputTokens,
    usdEstimate: (inputTokens * p.input + outputTokens * p.output) / 1_000_000,
    priced: true,
  };
}

/**
 * Modelos que REJEITAM `temperature` com HTTP 400.
 *
 * Claude Opus 4.7+ e a família 5 removeram os parâmetros de sampling. Mandar
 * temperature pra eles não é "ignorado": derruba a requisição inteira. Como a
 * temperatura é um campo editável do agente na tela, o usuário pode salvar 0.7,
 * trocar o modelo pra Opus 5 e quebrar o atendimento sem nenhuma pista — por
 * isso o filtro é aqui, no adapter, e não na validação do formulário.
 */
const NO_SAMPLING_PREFIXES = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-mythos-5',
];

export function acceptsTemperature(model: string): boolean {
  return !NO_SAMPLING_PREFIXES.some((p) => model.startsWith(p));
}

// ============================================
// Entrada única
// ============================================

export async function chat(req: ChatRequest): Promise<ChatResult> {
  const model = req.model?.trim() || DEFAULT_MODEL[req.provider];
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (req.provider === 'anthropic') return chatAnthropic(req, model, timeoutMs);
  if (req.provider === 'openai') return chatOpenAI(req, model, timeoutMs);
  throw new AppError(`Provider de IA desconhecido: ${req.provider}`, 400);
}

// ============================================
// OpenAI
// ============================================

async function chatOpenAI(
  req: ChatRequest,
  model: string,
  timeoutMs: number
): Promise<ChatResult> {
  const client = await getOpenAI(req.accountId, timeoutMs);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });

  for (const m of req.messages) {
    if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content });
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      messages.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: JSON.stringify(t.arguments) },
        })),
      });
    } else {
      messages.push({ role: m.role as 'user' | 'assistant', content: m.content });
    }
  }

  const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    max_tokens: req.maxTokens ?? 1024,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: req.jsonSchema.name,
        schema: req.jsonSchema.schema,
        // strict exige additionalProperties:false em todo nível do schema —
        // o schema vem do usuário (campo do agente), então não dá pra garantir.
        strict: false,
      },
    };
  }

  const res = await client.chat.completions.create(body);
  const choice = res.choices[0];
  const rawCalls = choice?.message?.tool_calls ?? [];

  return {
    text: choice?.message?.content ?? '',
    toolCalls: rawCalls
      .filter((c): c is typeof c & { function: { name: string; arguments: string } } =>
        'function' in c
      )
      .map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: safeParseArgs(c.function.arguments, c.function.name),
      })),
    model: res.model || model,
    provider: 'openai',
    usage: estimateCost(
      res.model || model,
      res.usage?.prompt_tokens ?? 0,
      res.usage?.completion_tokens ?? 0
    ),
    finishReason: choice?.finish_reason ?? 'unknown',
  };
}

// ============================================
// Anthropic
// ============================================

async function chatAnthropic(
  req: ChatRequest,
  model: string,
  timeoutMs: number
): Promise<ChatResult> {
  const client = await getAnthropic(req.accountId, timeoutMs);

  const messages: Anthropic.MessageParam[] = req.messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: m.toolCallId ?? '',
            content: m.content,
          },
        ],
      };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const t of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.arguments });
      }
      return { role: 'assistant' as const, content: blocks };
    }
    return { role: m.role as 'user' | 'assistant', content: m.content };
  });

  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: req.maxTokens ?? 1024,
    messages,
  };
  if (req.system) body.system = req.system;
  // Ver NO_SAMPLING_PREFIXES: mandar temperature pros modelos novos é 400.
  if (req.temperature !== undefined && acceptsTemperature(model)) {
    body.temperature = req.temperature;
  }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
  }
  if (req.jsonSchema) {
    body.output_config = {
      format: { type: 'json_schema', schema: req.jsonSchema.schema },
    } as Anthropic.MessageCreateParams['output_config'];
  }

  const res = await client.messages.create(body);

  // Refusal: HTTP 200 com stop_reason 'refusal' e content vazio ou parcial —
  // os classificadores de segurança recusam antes de gerar. Não é exceção do
  // SDK, então quem lê content[0] direto quebra sem entender o motivo.
  if (res.stop_reason === 'refusal') {
    throw new AppError(
      'A IA recusou a solicitação por política de segurança do provedor. Revise o prompt do agente.',
      422
    );
  }

  let text = '';
  const toolCalls: ChatToolCall[] = [];
  for (const block of res.content) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }

  return {
    text,
    toolCalls,
    model: res.model || model,
    provider: 'anthropic',
    usage: estimateCost(
      res.model || model,
      res.usage?.input_tokens ?? 0,
      res.usage?.output_tokens ?? 0
    ),
    finishReason: res.stop_reason ?? 'unknown',
  };
}

/**
 * Argumento de ferramenta vem como string JSON. Malformado não pode derrubar o
 * atendimento inteiro: devolve {} e loga, e o executor da ferramenta reclama do
 * argumento que falta — erro localizado em vez de exceção no meio do fluxo.
 */
function safeParseArgs(raw: string, toolName: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    logger.warn('[ai/chat] argumentos de ferramenta com JSON inválido', { toolName });
    return {};
  }
}
