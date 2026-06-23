/**
 * Inbound Integrations Backend Service
 *
 * Gerencia handlers de webhook de entrada da conta.
 * Cada handler recebe uma URL gerada no formato:
 *   /api/integrations/inbound/:accountId/:slug
 *
 * Endpoints (Sprint 3 — backend ainda em implementação):
 *   GET    /api/integrations/inbound
 *   POST   /api/integrations/inbound   body: CreateInboundInput
 *   DELETE /api/integrations/inbound/:slug
 *
 * Handlers disponíveis: contact_upsert | tag_apply | campaign_trigger | pacto_sync
 */

import { apiClient } from '@/api/client';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type InboundHandler =
  | 'contact_upsert'
  | 'tag_apply'
  | 'campaign_trigger'
  | 'pacto_sync';

export const INBOUND_HANDLERS: { value: InboundHandler; label: string; descricao: string }[] = [
  {
    value: 'contact_upsert',
    label: 'Criar/atualizar contato',
    descricao: 'Cria ou atualiza um contato a partir dos dados recebidos no payload.',
  },
  {
    value: 'tag_apply',
    label: 'Aplicar tag',
    descricao: 'Aplica uma ou mais tags ao contato identificado no payload.',
  },
  {
    value: 'campaign_trigger',
    label: 'Disparar campanha',
    descricao: 'Enfileira o contato em uma campanha de WhatsApp ou e-mail.',
  },
  {
    value: 'pacto_sync',
    label: 'Sincronizar com Pacto (FitPark)',
    descricao:
      'Recebe eventos do sistema Pacto (alunos, check-ins, contratos) via n8n e atualiza contatos e tags do CRM automaticamente.',
  },
];

export interface InboundIntegration {
  slug: string;
  handler: InboundHandler;
  /** Configuração JSON livre específica do handler. */
  config: Record<string, unknown>;
  /** URL completa para uso externo. Gerada pelo backend. */
  webhookUrl: string;
  createdAt: string;
}

export interface CreateInboundInput {
  slug: string;
  handler: InboundHandler;
  config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function unwrap<T>(resp: unknown): T {
  const r = resp as Record<string, unknown>;
  return (r?.data ?? r) as T;
}

function mapInbound(
  raw: Record<string, unknown>,
  accountId?: string
): InboundIntegration {
  const slug = String(raw.slug ?? '');
  // Fallback: constrói URL se o backend ainda não retorna
  const webhookUrl =
    raw.webhookUrl
      ? String(raw.webhookUrl)
      : accountId
      ? `${window.location.origin}/api/integrations/inbound-receive/${accountId}/${slug}`
      : `/api/integrations/inbound-receive/:accountId/${slug}`;

  return {
    slug,
    handler: (raw.handler ?? 'contact_upsert') as InboundHandler,
    config:
      raw.config && typeof raw.config === 'object'
        ? (raw.config as Record<string, unknown>)
        : {},
    webhookUrl,
    createdAt: String(raw.createdAt ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class InboundIntegrationsBackendService {
  /**
   * Lista todos os handlers de webhook de entrada da conta.
   * Retorna [] se o backend ainda não tiver implementado (404/500).
   */
  async listInbound(accountId?: string): Promise<InboundIntegration[]> {
    try {
      const resp = await apiClient.get<unknown>('/api/integrations/inbound');
      const items = unwrap<unknown[]>(resp);
      return Array.isArray(items)
        ? items.map((i) => mapInbound(i as Record<string, unknown>, accountId))
        : [];
    } catch {
      return [];
    }
  }

  async createInbound(input: CreateInboundInput, accountId?: string): Promise<InboundIntegration> {
    const resp = await apiClient.post<unknown>('/api/integrations/inbound', input);
    const raw = unwrap<Record<string, unknown>>(resp);
    return mapInbound(raw, accountId);
  }

  async deleteInbound(slug: string): Promise<void> {
    await apiClient.delete(`/api/integrations/inbound/${slug}`);
  }
}

export const inboundIntegrationsBackendService = new InboundIntegrationsBackendService();
