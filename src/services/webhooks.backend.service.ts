/**
 * Webhooks Backend Service (outbound subscriptions)
 *
 * Gerencia assinaturas de webhook de saída da conta:
 * - listagem, criação, edição, exclusão
 * - histórico de entregas (delivery log)
 * - disparo de evento de teste
 *
 * Endpoints (Sprint 3 — backend ainda em implementação):
 *   GET    /api/webhooks
 *   POST   /api/webhooks                       body: CreateWebhookInput
 *   PATCH  /api/webhooks/:id                   body parcial
 *   DELETE /api/webhooks/:id
 *   GET    /api/webhooks/:id/deliveries?limit=50
 *   POST   /api/webhooks/:id/test
 *
 * O secret HMAC é retornado APENAS na criação — igual à API Key.
 */

import { apiClient } from '@/api/client';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type WebhookEvent =
  | 'contact.created'
  | 'contact.updated'
  | 'sale.paid'
  | 'conversation.created'
  | 'conversation.resolved'
  | 'campaign.completed'
  | 'optout.created';

export const WEBHOOK_EVENTS: { value: WebhookEvent; label: string }[] = [
  { value: 'contact.created', label: 'Contato criado' },
  { value: 'contact.updated', label: 'Contato atualizado' },
  { value: 'sale.paid', label: 'Venda paga' },
  { value: 'conversation.created', label: 'Conversa criada' },
  { value: 'conversation.resolved', label: 'Conversa resolvida' },
  { value: 'campaign.completed', label: 'Campanha concluída' },
  { value: 'optout.created', label: 'Opt-out registrado' },
];

export interface WebhookSubscription {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  createdAt: string;
  lastDeliveryAt: string | null;
}

/** Retornado apenas na criação — secret não é re-exibido. */
export interface CreatedWebhook extends WebhookSubscription {
  secret: string;
}

export interface CreateWebhookInput {
  name: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
}

export type UpdateWebhookInput = Partial<CreateWebhookInput>;

export type DeliveryStatus = 'success' | 'failed' | 'pending';

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventName: WebhookEvent;
  url: string;
  status: DeliveryStatus;
  statusCode: number | null;
  latencyMs: number | null;
  retryCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function unwrap<T>(resp: unknown): T {
  const r = resp as Record<string, unknown>;
  return (r?.data ?? r) as T;
}

function mapWebhook(raw: Record<string, unknown>): WebhookSubscription {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    url: String(raw.url ?? ''),
    events: Array.isArray(raw.events) ? (raw.events as WebhookEvent[]) : [],
    active: Boolean(raw.active ?? true),
    createdAt: String(raw.createdAt ?? ''),
    lastDeliveryAt: (raw.lastDeliveryAt as string | null) ?? null,
  };
}

function mapDelivery(raw: Record<string, unknown>): WebhookDelivery {
  return {
    id: String(raw.id ?? ''),
    webhookId: String(raw.webhookId ?? ''),
    eventName: (raw.eventName ?? raw.event ?? '') as WebhookEvent,
    url: String(raw.url ?? ''),
    status: (raw.status ?? 'pending') as DeliveryStatus,
    statusCode: raw.statusCode != null ? Number(raw.statusCode) : null,
    latencyMs: raw.latencyMs != null ? Number(raw.latencyMs) : null,
    retryCount: Number(raw.retryCount ?? 0),
    createdAt: String(raw.createdAt ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class WebhooksBackendService {
  async listWebhooks(): Promise<WebhookSubscription[]> {
    try {
      const resp = await apiClient.get<unknown>('/api/webhooks');
      const items = unwrap<unknown[]>(resp);
      return Array.isArray(items)
        ? items.map((i) => mapWebhook(i as Record<string, unknown>))
        : [];
    } catch {
      // Backend Sprint 3 ainda não implementado — retorna lista vazia
      return [];
    }
  }

  async createWebhook(input: CreateWebhookInput): Promise<CreatedWebhook> {
    const resp = await apiClient.post<unknown>('/api/webhooks', input);
    const raw = unwrap<Record<string, unknown>>(resp);
    return {
      ...mapWebhook(raw),
      secret: String(raw.secret ?? ''),
    };
  }

  async updateWebhook(id: string, input: UpdateWebhookInput): Promise<WebhookSubscription> {
    const resp = await apiClient.patch<unknown>(`/api/webhooks/${id}`, input);
    const raw = unwrap<Record<string, unknown>>(resp);
    return mapWebhook(raw);
  }

  async deleteWebhook(id: string): Promise<void> {
    await apiClient.delete(`/api/webhooks/${id}`);
  }

  async getDeliveries(id: string, limit = 50): Promise<WebhookDelivery[]> {
    try {
      const resp = await apiClient.get<unknown>(`/api/webhooks/${id}/deliveries`, {
        params: { limit },
      });
      const items = unwrap<unknown[]>(resp);
      return Array.isArray(items)
        ? items.map((i) => mapDelivery(i as Record<string, unknown>))
        : [];
    } catch {
      return [];
    }
  }

  async testWebhook(id: string): Promise<{ success: boolean; message?: string }> {
    try {
      const resp = await apiClient.post<unknown>(`/api/webhooks/${id}/test`);
      const raw = unwrap<Record<string, unknown>>(resp);
      return {
        success: raw.success !== false,
        message: raw.message ? String(raw.message) : undefined,
      };
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;
      return {
        success: false,
        message: e?.message ? String(e.message) : 'Erro ao enviar evento de teste',
      };
    }
  }
}

export const webhooksBackendService = new WebhooksBackendService();
