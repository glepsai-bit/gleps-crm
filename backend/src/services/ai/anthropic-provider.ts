/**
 * Anthropic — "testar conexão" de uma chave (T-025, Administração › Integrações).
 *
 * A geração de conteúdo que vivia aqui era do aquecimento antigo e saiu na
 * etapa C1; o que o sistema usa pra conversar com a IA é ai/chat.ts +
 * ai/client-factory.ts. Este arquivo só valida uma chave sem persistir.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { TIMEOUT_TESTE_DE_CHAVE_MS } from './openai-provider';

export class AnthropicProvider {
  readonly name = 'anthropic' as const;

  /**
   * Testa uma API key arbitraria sem persistir.
   * Anthropic nao tem endpoint "list models" publico, entao mandamos uma
   * mensagem minima com max_tokens=1 (custo desprezivel, < 0.0001 USD).
   * NUNCA loga a chave.
   */
  async testConnection(apiKey: string): Promise<{ ok: boolean; message: string; status?: number }> {
    if (!apiKey || apiKey.trim() === '') {
      return { ok: false, message: 'Chave vazia' };
    }
    try {
      const tempClient = new Anthropic({
        apiKey: apiKey.trim(),
        timeout: TIMEOUT_TESTE_DE_CHAVE_MS,
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
      // `status` (HTTP do provider) deixa quem chama decidir sem ler a mensagem: 401 = chave recusada.
      if (status === 401) return { ok: false, status, message: 'Chave invalida (401)' };
      if (status === 403) return { ok: false, status, message: 'Chave sem permissao (403)' };
      if (status === 429) return { ok: false, status, message: 'Rate limit atingido (429)' };
      return { ok: false, status, message: `Falha na conexao: ${msg.slice(0, 200)}` };
    }
  }
}

export const anthropicProvider = new AnthropicProvider();
