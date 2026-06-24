/**
 * Inboxes WhatsApp Backend Service (T-022 — refactor Evolution)
 *
 * Wrapper das rotas de conexão Evolution por Inbox:
 *   POST /api/inboxes/:id/whatsapp/connect    → cria/garante instance + QR
 *   GET  /api/inboxes/:id/whatsapp/status     → estado atual (open|connecting|close|unknown)
 *   POST /api/inboxes/:id/whatsapp/disconnect → logout da instance Evolution
 *
 * Backend devolve `{ data: ... }`. Os métodos abaixo desempacotam e normalizam
 * para que a UI receba a shape contratada na tarefa
 * (`{ qrcodeBase64, status }` / `{ status, lastUpdate }` / `{ ok }`).
 *
 * Importante:
 *  - O backend usa o campo `state` (não `status`) para refletir o estado da
 *    instance Evolution. Mapeamos para `status` na fronteira do service.
 *  - O backend devolve `qrcodeBase64` (já com prefixo `data:image/png;base64,...`
 *    quando vem do Evolution; pode ser null se a instance já estiver `open`).
 *  - As credenciais são resolvidas no backend (SystemSettings global + fallback
 *    per-account); o frontend não precisa saber disso.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

export type WhatsappConnectionStatus =
  | 'open'
  | 'connecting'
  | 'close'
  | 'unknown';

export interface WhatsappConnectResponse {
  /** Base64 já pronto para usar em <img src=...>, ou null se já conectado. */
  qrcodeBase64: string | null;
  /** Estado da instance após a chamada (geralmente `connecting`). */
  status: WhatsappConnectionStatus;
}

export interface WhatsappStatusResponse {
  status: WhatsappConnectionStatus;
  /** ISO timestamp do momento da leitura (gerado no client). */
  lastUpdate: string;
}

export interface WhatsappDisconnectResponse {
  ok: boolean;
}

function unwrap<T = any>(response: any): T {
  return (response?.data ?? response) as T;
}

function normalizeStatus(raw: unknown): WhatsappConnectionStatus {
  const value = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (value === 'open' || value === 'connecting' || value === 'close') {
    return value;
  }
  return 'unknown';
}

export const inboxesWhatsappBackendService = {
  /**
   * Cria (ou reusa) a instance Evolution do Inbox e devolve o QR Code base64.
   * Idempotente — chamar 2x só re-emite o QR.
   */
  async connectWhatsapp(inboxId: string): Promise<WhatsappConnectResponse> {
    const response = await apiClient.post<any>(
      API_ENDPOINTS.INBOXES.WHATSAPP_CONNECT(inboxId),
    );
    const data = unwrap<any>(response);
    return {
      qrcodeBase64: data?.qrcodeBase64 ?? null,
      status: normalizeStatus(data?.state ?? data?.status),
    };
  },

  /**
   * Lê o estado atual da conexão Evolution do Inbox.
   * Usado em polling pela modal de QR.
   */
  async getWhatsappStatus(inboxId: string): Promise<WhatsappStatusResponse> {
    const response = await apiClient.get<any>(
      API_ENDPOINTS.INBOXES.WHATSAPP_STATUS(inboxId),
    );
    const data = unwrap<any>(response);
    return {
      status: normalizeStatus(data?.state ?? data?.status),
      lastUpdate: new Date().toISOString(),
    };
  },

  /**
   * Faz logout da instance Evolution do Inbox.
   * Não apaga o campo `evolutionInstance` no Inbox — permite reconectar depois.
   */
  async disconnectWhatsapp(
    inboxId: string,
  ): Promise<WhatsappDisconnectResponse> {
    const response = await apiClient.post<any>(
      API_ENDPOINTS.INBOXES.WHATSAPP_DISCONNECT(inboxId),
    );
    const data = unwrap<any>(response);
    return { ok: data?.ok ?? true };
  },
};

export default inboxesWhatsappBackendService;
