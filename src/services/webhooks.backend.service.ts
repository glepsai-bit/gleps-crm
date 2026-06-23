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
 *
 * Multi-tenant (BUG-043): super_admin opera fora do contexto de uma conta,
 * então o componente que chama estes métodos pode passar um `accountId`
 * opcional. Quando presente, é anexado como query param `?accountId=` em
 * todas as chamadas para que o backend escope corretamente o tenant.
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

/** Resultado do disparo de teste (POST /api/webhooks/:id/test). */
export interface TestWebhookResult {
  success: boolean;
  status?: number;
  latencyMs?: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function unwrap<T>(resp: unknown): T {
  const r = resp as Record<string, unknown>;
  return (r?.data ?? r) as T;
}

/** Monta o objeto de query params anexando accountId quando informado. */
function withAccountId(
  accountId?: string,
  extra?: Record<string, string | number | boolean | undefined | null>,
): Record<string, string | number | boolean | undefined | null> | undefined {
  if (!accountId && !extra) return undefined;
  return { ...(extra ?? {}), ...(accountId ? { accountId } : {}) };
}

function mapWebhook(raw: Record<string, unknown>): WebhookSubscription {
  // BUG-044: backend devolve `events` como string[] (nomes do enum no Postgres);
  // o FE define WebhookEvent como union literal. Fazemos cast explícito.
  // TODO: considerar GET /api/webhooks/event-types pra alinhar runtime
  const rawEvents = Array.isArray(raw.events) ? (raw.events as unknown[]) : [];
  const events: WebhookEvent[] = rawEvents.map((e) => String(e) as WebhookEvent);
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    url: String(raw.url ?? ''),
    events,
    active: Boolean(raw.active ?? true),
    createdAt: String(raw.createdAt ?? ''),
    lastDeliveryAt: (raw.lastDeliveryAt as string | null) ?? null,
  };
}

/**
 * BUG-035: backend devolve cada delivery com os campos
 *   { eventType, httpStatus, attemptCount, subscriptionId, subscription: { url } }
 * (não `eventName`/`statusCode`/`retryCount`/`webhookId`/`url`).
 *
 * Mapeamos para o formato consumido pelo FE. A URL vem via JOIN com a
 * subscription (eager-load no backend) — caímos no campo flat `url` se
 * o backend já tiver feito o flatten.
 */
function mapDelivery(raw: Record<string, unknown>): WebhookDelivery {
  const subscription = raw.subscription as Record<string, unknown> | undefined;
  const urlFromSubscription = subscription?.url;
  const httpStatus = raw.httpStatus ?? raw.statusCode;

  // Inferir status (success/failed/pending) a partir de httpStatus quando o
  // backend não envia o campo explicitamente.
  let status: DeliveryStatus;
  if (raw.status) {
    status = raw.status as DeliveryStatus;
  } else if (httpStatus == null) {
    status = 'pending';
  } else {
    const code = Number(httpStatus);
    status = code >= 200 && code < 300 ? 'success' : 'failed';
  }

  return {
    id: String(raw.id ?? ''),
    webhookId: String(raw.subscriptionId ?? raw.webhookId ?? ''),
    eventName: (raw.eventType ?? raw.eventName ?? raw.event ?? '') as WebhookEvent,
    url: String(urlFromSubscription ?? raw.url ?? ''),
    status,
    statusCode: httpStatus != null ? Number(httpStatus) : null,
    latencyMs: raw.latencyMs != null ? Number(raw.latencyMs) : null,
    retryCount: Number(raw.attemptCount ?? raw.retryCount ?? 0),
    createdAt: String(raw.createdAt ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class WebhooksBackendService {
  async listWebhooks(accountId?: string): Promise<WebhookSubscription[]> {
    try {
      const resp = await apiClient.get<unknown>('/api/webhooks', {
        params: withAccountId(accountId),
      });
      const items = unwrap<unknown[]>(resp);
      return Array.isArray(items)
        ? items.map((i) => mapWebhook(i as Record<string, unknown>))
        : [];
    } catch {
      // Backend Sprint 3 ainda não implementado — retorna lista vazia
      return [];
    }
  }

  async createWebhook(input: CreateWebhookInput, accountId?: string): Promise<CreatedWebhook> {
    const resp = await apiClient.post<unknown>('/api/webhooks', input, {
      params: withAccountId(accountId),
    });
    const raw = unwrap<Record<string, unknown>>(resp);
    return {
      ...mapWebhook(raw),
      secret: String(raw.secret ?? ''),
    };
  }

  async updateWebhook(
    id: string,
    input: UpdateWebhookInput,
    accountId?: string,
  ): Promise<WebhookSubscription> {
    const resp = await apiClient.patch<unknown>(`/api/webhooks/${id}`, input, {
      params: withAccountId(accountId),
    });
    const raw = unwrap<Record<string, unknown>>(resp);
    return mapWebhook(raw);
  }

  async deleteWebhook(id: string, accountId?: string): Promise<void> {
    await apiClient.delete(`/api/webhooks/${id}`, {
      params: withAccountId(accountId),
    });
  }

  async getDeliveries(id: string, limit = 50, accountId?: string): Promise<WebhookDelivery[]> {
    try {
      const resp = await apiClient.get<unknown>(`/api/webhooks/${id}/deliveries`, {
        params: withAccountId(accountId, { limit }),
      });
      const items = unwrap<unknown[]>(resp);
      return Array.isArray(items)
        ? items.map((i) => mapDelivery(i as Record<string, unknown>))
        : [];
    } catch {
      return [];
    }
  }

  /**
   * BUG-036: backend retorna { ok: boolean, status: number, latencyMs: number }.
   * Convertemos para o shape `TestWebhookResult` esperado pelo componente —
   * `success` deriva estritamente de `ok === true` (não `!== false`, que
   * trataria respostas inesperadas como sucesso silencioso).
   */
  async testWebhook(id: string, accountId?: string): Promise<TestWebhookResult> {
    try {
      const resp = await apiClient.post<unknown>(`/api/webhooks/${id}/test`, undefined, {
        params: withAccountId(accountId),
      });
      const raw = unwrap<Record<string, unknown>>(resp);
      const success = raw.ok === true;
      const status = raw.status != null ? Number(raw.status) : undefined;
      const latencyMs = raw.latencyMs != null ? Number(raw.latencyMs) : undefined;
      const baseMessage = raw.message ? String(raw.message) : undefined;
      // Mensagem amigável: HTTP <status> em <latency>ms
      const detail =
        status != null || latencyMs != null
          ? [status != null ? `HTTP ${status}` : null, latencyMs != null ? `${latencyMs}ms` : null]
              .filter(Boolean)
              .join(' · ')
          : undefined;
      return {
        success,
        status,
        latencyMs,
        message: baseMessage ?? detail,
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
