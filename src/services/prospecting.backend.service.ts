/**
 * Prospecting Backend Service (T-022 — Histórico de Disparos enriquecido).
 *
 * Wrapper tipado em volta dos endpoints `/api/prospecting/batches`,
 * `/api/prospecting/batches/aggregate` e `/api/prospecting/batches/campaign-types`.
 *
 * O backend devolve sempre `{ data: ... }` (vide prospecting.controller.ts).
 * Aqui normalizamos pra retornar o conteúdo "puro" pro consumidor (hooks
 * useQuery) — assim os componentes não precisam fazer `.data ?? res` toda hora.
 *
 * Filtros multi-valor (source, status, campaignType) viram repetições de
 * query string (`?source=manual&source=n8n`) porque o `apiClient.buildUrl`
 * faz `String(value)` em valores não-primitivos — passar `string[]` direto
 * seria serializado como "manual,n8n" e o Zod do backend não aceita CSV.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

/* ============================================================
 * Types
 * ============================================================ */

export type BatchSource =
  | 'manual'
  | 'manual_scheduled'
  | 'n8n'
  | 'api'
  | 'integration';

export type BatchStatus =
  | 'running'
  | 'scheduled'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BatchListFilters {
  q?: string;
  source?: BatchSource[] | string[];
  status?: BatchStatus[] | string[];
  campaignType?: string[];
  fromDate?: string; // ISO 8601 (YYYY-MM-DD aceito pelo backend)
  toDate?: string;
  limit?: number;
  offset?: number;
}

/**
 * Shape de DispatchBatch como devolvido pelo Prisma (camelCase) +
 * campos extras que aparecem em metadata.
 *
 * O backend devolve direto o Prisma model — `metadata` é `Json | null`.
 */
export interface DispatchBatchRow {
  id: string;
  accountId: string;
  keyword: string | null;
  location: string | null;
  totalContacts: number;
  sentCount: number;
  failedCount: number;
  status: BatchStatus | string;
  delaySeconds: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  scheduledAt: string | null;
  source: BatchSource | string | null;
  triggerName: string | null;
  templateId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AggregateOptions {
  fromDate?: string;
  toDate?: string;
  groupBy?: 'campaign_type' | 'source' | 'trigger_name';
}

export interface AggregateRow {
  key: string | null;
  campaignType?: string | null;
  source?: string | null;
  triggerName?: string | null;
  batchesCount: number;
  totalSent: number;
  totalFailed: number;
  avgSentPerBatch: number;
}

/* ============================================================
 * Internal helpers
 * ============================================================ */

/**
 * apiClient.get aceita `params: object` e serializa valor a valor via
 * `String(value)`. Pra arrays precisamos construir a query manualmente.
 */
function buildBatchesQueryString(filters: BatchListFilters): string {
  const sp = new URLSearchParams();

  if (filters.q && filters.q.trim()) sp.append('q', filters.q.trim());
  if (filters.fromDate) sp.append('fromDate', filters.fromDate);
  if (filters.toDate) sp.append('toDate', filters.toDate);
  if (typeof filters.limit === 'number') sp.append('limit', String(filters.limit));
  if (typeof filters.offset === 'number') sp.append('offset', String(filters.offset));

  const appendMulti = (key: string, values?: readonly string[]) => {
    if (!values || values.length === 0) return;
    values.forEach((v) => {
      if (v) sp.append(key, v);
    });
  };

  appendMulti('source', filters.source);
  appendMulti('status', filters.status);
  appendMulti('campaignType', filters.campaignType);

  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

/** Resposta padrão do backend: `{ data: T }`. */
function unwrap<T>(res: unknown): T {
  if (res && typeof res === 'object' && 'data' in res) {
    return (res as { data: T }).data;
  }
  return res as T;
}

/* ============================================================
 * Public API
 * ============================================================ */

/**
 * GET /api/prospecting/batches — lista batches com filtros opcionais.
 * Devolve direto o array (sem o wrapper `{ data }`).
 */
export async function listBatches(
  filters: BatchListFilters = {}
): Promise<DispatchBatchRow[]> {
  const url = API_ENDPOINTS.PROSPECTING.BATCHES + buildBatchesQueryString(filters);
  const res = await apiClient.get<unknown>(url);
  const data = unwrap<DispatchBatchRow[] | undefined>(res);
  return Array.isArray(data) ? data : [];
}

/**
 * GET /api/prospecting/batches/aggregate — agregação por campaign_type/source/trigger_name.
 */
export async function getAggregate(
  options: AggregateOptions = {}
): Promise<AggregateRow[]> {
  const sp = new URLSearchParams();
  if (options.fromDate) sp.append('fromDate', options.fromDate);
  if (options.toDate) sp.append('toDate', options.toDate);
  if (options.groupBy) sp.append('groupBy', options.groupBy);
  const qs = sp.toString();
  const url = API_ENDPOINTS.PROSPECTING.BATCHES_AGGREGATE + (qs ? `?${qs}` : '');
  const res = await apiClient.get<unknown>(url);
  const data = unwrap<AggregateRow[] | undefined>(res);
  return Array.isArray(data) ? data : [];
}

/**
 * GET /api/prospecting/batches/campaign-types — lista distinta de campaign_types
 * (popula dropdown de filtro UI).
 */
export async function getCampaignTypes(): Promise<string[]> {
  const res = await apiClient.get<unknown>(API_ENDPOINTS.PROSPECTING.BATCH_CAMPAIGN_TYPES);
  const data = unwrap<string[] | undefined>(res);
  return Array.isArray(data) ? data.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
}

export const prospectingBackendService = {
  listBatches,
  getAggregate,
  getCampaignTypes,
};

export default prospectingBackendService;
