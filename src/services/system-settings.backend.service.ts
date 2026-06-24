/**
 * System Settings Backend Service (T-022 — refactor Evolution global)
 *
 * Singleton de configurações globais do sistema, gerenciado exclusivamente
 * por super_admin. Hoje armazena as credenciais GLOBAIS da Evolution API
 * (URL base, API key e webhook), usadas por todas as contas — com fallback
 * per-account override aplicado no backend (evolution.service).
 *
 * Endpoints (ver backend/src/routes/system-settings.routes.ts):
 *   GET   /api/system-settings              → settings + máscara da API key
 *   PATCH /api/system-settings              → atualização parcial
 *   POST  /api/system-settings/test-evolution → valida conectividade real
 *
 * IMPORTANTE — máscara da API key:
 *   O backend NUNCA devolve o segredo real. Quando há chave salva,
 *   `evolutionApiKey` vem como '***SET***'. Quando vazio, vem como `null`.
 *   O frontend deve detectar o sentinel e EVITAR reenviá-lo no PATCH
 *   (caso contrário a chave real é sobrescrita pela string literal).
 *
 *   `updateSettings()` aqui faz o filtro defensivo: se o caller passar
 *   `evolutionApiKey === '***SET***'`, o campo é removido do payload.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

export const MASKED_API_KEY = '***SET***' as const;

export interface SystemSettings {
  id: string;
  evolutionBaseUrl: string | null;
  /**
   * `null`  → não configurado
   * `'***SET***'` → configurado, valor real omitido
   * outro string → só aparece em respostas de update logo após o save
   */
  evolutionApiKey: string | null;
  evolutionWebhookUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SystemSettingsView extends SystemSettings {
  /** Conveniência derivada: true quando a chave da Evolution está preenchida. */
  hasEvolutionConfig: boolean;
}

export interface UpdateSystemSettingsInput {
  evolutionBaseUrl?: string;
  /** Não envie '***SET***' — o service filtra, mas evite por clareza. */
  evolutionApiKey?: string;
  evolutionWebhookUrl?: string;
}

export interface EvolutionTestResult {
  ok: boolean;
  instanceCount?: number;
  error?: string;
}

function unwrap<T>(resp: any): T {
  return (resp?.data ?? resp) as T;
}

function toView(raw: SystemSettings): SystemSettingsView {
  return {
    ...raw,
    hasEvolutionConfig:
      !!raw.evolutionBaseUrl &&
      raw.evolutionApiKey != null &&
      raw.evolutionApiKey.length > 0,
  };
}

class SystemSettingsBackendService {
  async getSettings(): Promise<SystemSettingsView> {
    const resp = await apiClient.get<any>(API_ENDPOINTS.SYSTEM_SETTINGS.GET);
    const raw = unwrap<SystemSettings>(resp);
    return toView(raw);
  }

  async updateSettings(
    input: UpdateSystemSettingsInput
  ): Promise<SystemSettingsView> {
    // Filtro defensivo: NUNCA reenviar o sentinel de máscara.
    const payload: UpdateSystemSettingsInput = {};
    if (input.evolutionBaseUrl !== undefined) {
      payload.evolutionBaseUrl = input.evolutionBaseUrl;
    }
    if (input.evolutionWebhookUrl !== undefined) {
      payload.evolutionWebhookUrl = input.evolutionWebhookUrl;
    }
    if (
      input.evolutionApiKey !== undefined &&
      input.evolutionApiKey !== MASKED_API_KEY
    ) {
      payload.evolutionApiKey = input.evolutionApiKey;
    }

    const resp = await apiClient.patch<any>(
      API_ENDPOINTS.SYSTEM_SETTINGS.UPDATE,
      payload
    );
    const raw = unwrap<SystemSettings>(resp);
    return toView(raw);
  }

  async testEvolution(): Promise<EvolutionTestResult> {
    const resp = await apiClient.post<any>(
      API_ENDPOINTS.SYSTEM_SETTINGS.TEST_EVOLUTION
    );
    return unwrap<EvolutionTestResult>(resp);
  }
}

export const systemSettingsBackendService = new SystemSettingsBackendService();
