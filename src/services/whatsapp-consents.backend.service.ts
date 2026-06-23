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
  /** ID do contato associado ao consent. `null` quando o opt-out foi registrado apenas pelo número. */
  contactId: string | null;
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
  const rawContactId = raw.contactId ?? null;
  return {
    contactId: rawContactId != null ? String(rawContactId) : null,
    nome: String(raw.nome ?? raw.name ?? ''),
    telefone: String(raw.telefone ?? raw.phone ?? raw.phoneNumber ?? ''),
    optedOutAt: String(raw.optedOutAt ?? raw.createdAt ?? ''),
    origem: (raw.origem ?? raw.source ?? 'auto') as ConsentOrigem,
  };
}

/** Remove tudo que não for dígito do telefone para usar no path do opt-in/opt-out. */
function normalizePhone(telefone: string): string {
  return (telefone ?? '').replace(/\D+/g, '');
}

function buildFiltroParams(
  filtro: FiltroConsent,
  busca?: string
): Record<string, string> {
  const params: Record<string, string> = { status: 'opted_out' };
  const now = Date.now();
  if (filtro === 'last7d') {
    params.fromDate = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (filtro === 'last30d') {
    params.fromDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (busca && busca.trim()) {
    params.search = busca.trim();
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

  /**
   * Re-opt-in manual: remove o opt-out do contato.
   *
   * Aceita o `contactId` quando há contato associado; caso contrário (consent
   * registrado só pelo número), passe o telefone para que seja normalizado e
   * usado no path `/api/whatsapp-consents/:contactIdOrPhone/opt-in`.
   */
  async optIn(contactIdOrPhone: string, motivo?: string): Promise<void> {
    const id = encodeURIComponent(
      /\D/.test(contactIdOrPhone) || contactIdOrPhone.length > 30
        ? normalizePhone(contactIdOrPhone)
        : contactIdOrPhone
    );
    await apiClient.post(
      `/api/whatsapp-consents/${id}/opt-in`,
      motivo ? { motivo } : undefined
    );
  }

  /** Opt-out manual: registra opt-out para o contato (ou telefone normalizado). */
  async optOut(contactIdOrPhone: string, motivo?: string): Promise<void> {
    const id = encodeURIComponent(
      /\D/.test(contactIdOrPhone) || contactIdOrPhone.length > 30
        ? normalizePhone(contactIdOrPhone)
        : contactIdOrPhone
    );
    await apiClient.post(
      `/api/whatsapp-consents/${id}/opt-out`,
      motivo ? { motivo } : undefined
    );
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
