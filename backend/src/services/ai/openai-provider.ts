/**
 * OpenAI — "testar conexão" de uma chave (T-025, Administração › Integrações).
 *
 * A geração de conteúdo que vivia aqui era do aquecimento antigo e saiu na
 * etapa C1; o que o sistema usa pra conversar com a IA é ai/chat.ts +
 * ai/client-factory.ts. Este arquivo só valida uma chave sem persistir.
 */

import OpenAI from 'openai';

/** Tempo máximo do ping de validação — não é uma chamada de atendimento. */
export const TIMEOUT_TESTE_DE_CHAVE_MS = 5000;

export class OpenAIProvider {
  readonly name = 'openai' as const;

  /**
   * Testa uma API key arbitraria sem persistir.
   * Faz uma chamada minima (models.list) para validar autenticacao.
   * NUNCA loga a chave; mensagens de erro vem do provider e sao seguras
   * (OpenAI nao ecoa a chave no payload de erro).
   */
  async testConnection(apiKey: string): Promise<{ ok: boolean; message: string; status?: number }> {
    if (!apiKey || apiKey.trim() === '') {
      return { ok: false, message: 'Chave vazia' };
    }
    try {
      const tempClient = new OpenAI({
        apiKey: apiKey.trim(),
        timeout: TIMEOUT_TESTE_DE_CHAVE_MS,
      });
      // Endpoint barato e suportado em todas as contas: models.list
      await tempClient.models.list();
      return { ok: true, message: 'Conexao OpenAI OK' };
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

export const openaiProvider = new OpenAIProvider();
