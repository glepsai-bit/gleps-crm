/**
 * T-023 Fase 2 — Anthropic provider para warmup AI.
 *
 * Usa SDK oficial `@anthropic-ai/sdk`. Modelo default:
 * claude-haiku-4-5-20251001 (configuravel via ANTHROPIC_MODEL).
 * Custos estimados Haiku 4.5: $1/M input tokens, $5/M output tokens.
 * O custo eh apenas LOGADO, nao persistido em DB pra MVP.
 *
 * Em qualquer erro (timeout, rate limit, resposta vazia, content block nao-text),
 * retorna null para que o warmup-content-generator caia em fallback/template.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { AiProvider, ContentContext, GeneratedContent } from './types';
import { buildWarmupPrompt, parseAiResponse } from './prompt-builder';

// Pricing em USD por TOKEN — Claude Haiku 4.5:
//   $1/M input, $5/M output.
const INPUT_USD_PER_TOKEN = 1.0 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 5.0 / 1_000_000;

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;
  readonly defaultModel = env.ANTHROPIC_MODEL;
  private client: Anthropic | null = null;

  constructor() {
    if (env.ANTHROPIC_API_KEY) {
      this.client = new Anthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        timeout: env.WARMUP_AI_TIMEOUT_MS,
      });
    }
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  /**
   * T-025: testa uma API key arbitraria sem persistir.
   * Anthropic SDK nao tem endpoint "list models" publico, entao mandamos uma
   * mensagem minima ao haiku com max_tokens=1 (custo desprezivel, < 0.0001 USD).
   * NUNCA loga a chave.
   */
  async testConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
    if (!apiKey || apiKey.trim() === '') {
      return { ok: false, message: 'Chave vazia' };
    }
    try {
      const tempClient = new Anthropic({
        apiKey: apiKey.trim(),
        timeout: env.WARMUP_AI_TIMEOUT_MS,
      });
      await tempClient.messages.create({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      return { ok: true, message: 'Conexao Anthropic OK' };
    } catch (err: any) {
      const status = err?.status ?? err?.statusCode;
      const msg = err?.message ?? String(err);
      if (status === 401) return { ok: false, message: 'Chave invalida (401)' };
      if (status === 403) return { ok: false, message: 'Chave sem permissao (403)' };
      if (status === 429) return { ok: false, message: 'Rate limit atingido (429)' };
      return { ok: false, message: `Falha na conexao: ${msg.slice(0, 200)}` };
    }
  }

  async generate(ctx: ContentContext, model?: string): Promise<GeneratedContent | null> {
    if (!this.client) return null;
    const useModel = model ?? this.defaultModel;

    try {
      const response = await this.client.messages.create({
        model: useModel,
        max_tokens: 60,
        temperature: 0.9,
        messages: [{ role: 'user', content: buildWarmupPrompt(ctx) }],
      });

      // response.content eh array de blocks. Pegamos o primeiro block do tipo 'text'.
      const blocks = Array.isArray(response.content) ? response.content : [];
      const textBlock = blocks.find((b: any) => b && b.type === 'text') as
        | { type: 'text'; text: string }
        | undefined;
      const raw = textBlock?.text ?? '';
      const content = parseAiResponse(raw);
      if (!content) return null;

      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      const usdEstimate =
        inputTokens * INPUT_USD_PER_TOKEN + outputTokens * OUTPUT_USD_PER_TOKEN;

      return {
        source: 'anthropic',
        type: 'text',
        content,
        model: useModel,
        cost: { inputTokens, outputTokens, usdEstimate },
      };
    } catch (err) {
      logger.warn('[warmup-ai/anthropic] erro, fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

export const anthropicProvider = new AnthropicProvider();
