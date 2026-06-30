/**
 * T-025 — Self-service de chaves de IA pelo admin da conta.
 *
 * Endpoints backend:
 *   GET   /api/admin/integrations/ai
 *   PATCH /api/admin/integrations/ai
 *   POST  /api/admin/integrations/ai/test/:provider   provider = openai|anthropic
 *
 * Padrao de seguranca (espelha o backend account-integrations.service.ts):
 *   - GET sempre retorna sentinel '***SET***' (string) quando configurada ou null.
 *     NUNCA retorna o valor real.
 *   - PATCH com '***SET***' eh ignorado pelo backend (no-op) — protege contra
 *     reenvio acidental do mascarado.
 *   - PATCH com null ou '' limpa o campo.
 *   - PATCH com string nao-sentinel seta o valor.
 *   - Campo nao enviado = nao tocado.
 */

import { apiClient } from '@/api/client';

export type IntegrationProvider = 'openai' | 'anthropic';

export const INTEGRATIONS_SENTINEL = '***SET***' as const;
export type IntegrationsSentinel = typeof INTEGRATIONS_SENTINEL;

export interface IntegrationsView {
  openaiApiKey: IntegrationsSentinel | null;
  anthropicApiKey: IntegrationsSentinel | null;
}

export interface UpdateIntegrationsInput {
  /** undefined = nao tocar; null/'' = limpar; '***SET***' = backend ignora; string = setar. */
  openaiApiKey?: string | null;
  anthropicApiKey?: string | null;
}

export interface TestProviderResult {
  ok: boolean;
  message: string;
}

function unwrap<T>(resp: unknown): T {
  const r = resp as Record<string, unknown>;
  return (r?.data ?? r) as T;
}

class AccountIntegrationsBackendService {
  async getIntegrations(): Promise<IntegrationsView> {
    const resp = await apiClient.get<unknown>('/api/admin/integrations/ai');
    const raw = unwrap<Partial<IntegrationsView>>(resp);
    return {
      openaiApiKey: raw?.openaiApiKey === INTEGRATIONS_SENTINEL ? INTEGRATIONS_SENTINEL : null,
      anthropicApiKey:
        raw?.anthropicApiKey === INTEGRATIONS_SENTINEL ? INTEGRATIONS_SENTINEL : null,
    };
  }

  async updateIntegrations(input: UpdateIntegrationsInput): Promise<IntegrationsView> {
    const resp = await apiClient.patch<unknown>('/api/admin/integrations/ai', input);
    const raw = unwrap<Partial<IntegrationsView>>(resp);
    return {
      openaiApiKey: raw?.openaiApiKey === INTEGRATIONS_SENTINEL ? INTEGRATIONS_SENTINEL : null,
      anthropicApiKey:
        raw?.anthropicApiKey === INTEGRATIONS_SENTINEL ? INTEGRATIONS_SENTINEL : null,
    };
  }

  async testProvider(provider: IntegrationProvider): Promise<TestProviderResult> {
    // T-025/BUG-03: existe APENAS um endpoint para teste de provider.
    // Os paths legados (POST /api/admin/integrations/ai/test sem provider e
    // POST /api/admin/integrations/ai/:provider/test) NAO devem ser
    // chamados — qualquer 403 visto nesses paths em DevTools eh cache do
    // browser ou interceptor de extensao, nao codigo daqui.
    const resp = await apiClient.post<unknown>(
      `/api/admin/integrations/ai/test/${provider}`,
      {}
    );
    const raw = unwrap<Partial<TestProviderResult>>(resp);
    return {
      ok: Boolean(raw?.ok),
      message: typeof raw?.message === 'string' ? raw.message : '',
    };
  }
}

export const accountIntegrationsBackendService = new AccountIntegrationsBackendService();
