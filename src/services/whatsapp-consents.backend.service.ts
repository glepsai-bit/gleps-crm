/**
 * WhatsApp Consents Backend Service
 *
 * Gerencia consentimentos e opt-outs de WhatsApp da conta.
 *
 * Endpoints (Sprint 3 — backend ainda em implementação):
 *   GET  /api/whatsapp-consents?status=opted_out   lista opt-outs
 *   POST /api/whatsapp-consents/:contactId/opt-in  re-opt-in manual
 *   POST /api/whatsapp-consents/:contactId/opt-out opt-out manual
 *   GET  /api/whatsapp-consents/export?format=csv  download CSV
 *
 * Graceful degradation: se o backend ainda não estiver disponível,
 * listOptedOut retorna [] e exportCsv lança erro com mensagem amigável.
 */

import { apiClient } from '@/api/client';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type ConsentOrigem = 'auto' | 'manual';

export interface WhatsappConsent {
  contactId: string;
  nome: string;
  telefone: string;
  /** ISO 8601 — data em que o opt-out foi registrado. */
  optedOutAt: string;
  origem: ConsentOrigem;
}

export type FiltroConsent = 'last7d' | 'last30d' | 'all';

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function unwrap<T>(resp: unknown): T {
  const r = resp as Record<string, unknown>;
  return (r?.data ?? r) as T;
}

function mapConsent(raw: Record<string, unknown>): WhatsappConsent {
  return {
    contactId: String(raw.contactId ?? raw.id ?? ''),
    nome: String(raw.nome ?? raw.name ?? ''),
    telefone: String(raw.telefone ?? raw.phone ?? raw.phoneNumber ?? ''),
    optedOutAt: String(raw.optedOutAt ?? raw.createdAt ?? ''),
    origem: (raw.origem ?? raw.source ?? 'auto') as ConsentOrigem,
  };
}

function buildFiltroParams(
  filtro: FiltroConsent,
  busca?: string
): Record<string, string> {
  const params: Record<string, string> = { status: 'opted_out' };
  const now = Date.now();
  if (filtro === 'last7d') {
    params.from = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (filtro === 'last30d') {
    params.from = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (busca && busca.trim()) {
    params.q = busca.trim();
  }
  return params;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class WhatsappConsentsBackendService {
  /**
   * Lista contatos com opt-out. Retorna [] se backend ainda não implementado.
   */
  async listOptedOut(
    filtro: FiltroConsent = 'all',
    busca?: string
  ): Promise<WhatsappConsent[]> {
    try {
      const resp = await apiClient.get<unknown>('/api/whatsapp-consents', {
        params: buildFiltroParams(filtro, busca),
      });
      const items = unwrap<unknown[]>(resp);
      return Array.isArray(items)
        ? items.map((i) => mapConsent(i as Record<string, unknown>))
        : [];
    } catch {
      return [];
    }
  }

  /** Re-opt-in manual: remove o opt-out do contato. */
  async optIn(contactId: string): Promise<void> {
    await apiClient.post(`/api/whatsapp-consents/${contactId}/opt-in`);
  }

  /** Opt-out manual: registra opt-out para o contato. */
  async optOut(contactId: string): Promise<void> {
    await apiClient.post(`/api/whatsapp-consents/${contactId}/opt-out`);
  }

  /**
   * Exporta a lista de opt-outs como CSV.
   * Dispara o download via `createObjectURL`.
   */
  async exportCsv(): Promise<void> {
    // O apiClient usa fetch padrão; para download de blob precisamos
    // do fetch nativo com o token de autenticação.
    const token = localStorage.getItem('auth_token');
    const baseUrl = window.location.origin;
    const url = `${baseUrl}/api/whatsapp-consents/export?format=csv`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      throw new Error(`Erro ao exportar: ${response.statusText}`);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `opt-outs-whatsapp-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);
  }
}

export const whatsappConsentsBackendService = new WhatsappConsentsBackendService();
