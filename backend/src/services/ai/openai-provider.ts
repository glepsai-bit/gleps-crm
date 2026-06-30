/**
 * T-023 Fase 2 — OpenAI provider para warmup AI.
 *
 * Usa SDK oficial `openai`. Modelo default: gpt-4o-mini (configuravel via
 * OPENAI_MODEL). Custos estimados: $0.15/M input tokens, $0.60/M output tokens
 * (valores publicos em 2026-01, podem mudar). O custo eh apenas LOGADO,
 * nao persistido em DB pra MVP.
 *
 * Em qualquer erro (timeout, rate limit, resposta vazia, JSON malformado),
 * retorna null para que o warmup-content-generator caia em fallback/template.
 */

import OpenAI from 'openai';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { AiProvider, ContentContext, GeneratedContent } from './types';
import { buildWarmupPrompt, parseAiResponse } from './prompt-builder';

// Pricing em USD por TOKEN (nao por 1M) — calculo do custo:
//   inputTokens * INPUT_USD_PER_TOKEN + outputTokens * OUTPUT_USD_PER_TOKEN
const INPUT_USD_PER_TOKEN = 0.15 / 1_000_000; // $0.15/M
const OUTPUT_USD_PER_TOKEN = 0.6 / 1_000_000; // $0.60/M

export class OpenAIProvider implements AiProvider {
  readonly name = 'openai' as const;
  readonly defaultModel = env.OPENAI_MODEL;
  private client: OpenAI | null = null;

  constructor() {
    if (env.OPENAI_API_KEY) {
      this.client = new OpenAI({
        apiKey: env.OPENAI_API_KEY,
        timeout: env.WARMUP_AI_TIMEOUT_MS,
      });
    }
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  /**
   * T-025: testa uma API key arbitraria sem persistir.
   * Faz uma chamada minima (models.list com limit) para validar autenticacao.
   * NUNCA loga a chave; mensagens de erro vem do provider e sao seguras
   * (OpenAI nao ecoa a chave no payload de erro).
   */
  async testConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
    if (!apiKey || apiKey.trim() === '') {
      return { ok: false, message: 'Chave vazia' };
    }
    try {
      const tempClient = new OpenAI({
        apiKey: apiKey.trim(),
        timeout: env.WARMUP_AI_TIMEOUT_MS,
      });
      // Endpoint barato e suportado em todas as contas: models.list
      await tempClient.models.list();
      return { ok: true, message: 'Conexao OpenAI OK' };
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
      const response = await this.client.chat.completions.create({
        model: useModel,
        max_tokens: 60,
        temperature: 0.9,
        messages: [{ role: 'user', content: buildWarmupPrompt(ctx) }],
      });

      const raw = response.choices?.[0]?.message?.content ?? '';
      const content = parseAiResponse(typeof raw === 'string' ? raw : String(raw));
      if (!content) return null;

      const inputTokens = response.usage?.prompt_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? 0;
      const usdEstimate =
        inputTokens * INPUT_USD_PER_TOKEN + outputTokens * OUTPUT_USD_PER_TOKEN;

      return {
        source: 'openai',
        type: 'text',
        content,
        model: useModel,
        cost: { inputTokens, outputTokens, usdEstimate },
      };
    } catch (err) {
      logger.warn('[warmup-ai/openai] erro, fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

export const openaiProvider = new OpenAIProvider();
