/**
 * Warmup Backend Service (T-022 FitPark)
 *
 * CRUD de pools e números de aquecimento de chip WhatsApp + ações de
 * ciclo de vida (start/pause/resume) e leitura de estatísticas diárias.
 *
 * Backend: backend/src/routes/warmup.routes.ts (controller -> whatsappWarmupService).
 * Auth: JWT + role admin|super_admin + accountId obrigatório.
 *
 * Estratégia de curva (default MVP = 'moderate'):
 *   D1 10 / D2 12 / D3 15 / D4 20 / D5 25 / D6 30 / D7 40 /
 *   D8-14 50-80 / D15-21 100-180 / D22+ 200 estabilizado.
 */

import { apiClient, tokenManager, ApiError } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { apiConfig } from '@/config/api.config';

// ============================================
// Tipos
// ============================================

export type WarmupStrategy = 'conservative' | 'moderate' | 'aggressive';

export type WarmupNumberStatus =
  | 'cold'
  | 'warming'
  | 'warm'
  | 'paused'
  | 'banned'
  | 'error';

/**
 * T-023 Fase 2 — providers de IA disponiveis e tons de conversa
 * suportados pelo backend.
 */
export type WarmupAiProviderName = 'openai' | 'anthropic';
export type WarmupTone = 'casual' | 'formal' | 'gym' | 'clinic';

export interface WarmupAiProviderInfo {
  name: WarmupAiProviderName;
  defaultModel: string;
  enabled: boolean;
}

export interface WarmupAiProvidersResponse {
  providers: WarmupAiProviderInfo[];
  anyEnabled: boolean;
  supportedTones: WarmupTone[];
}

export interface WarmupPool {
  id: string;
  accountId: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  isActive: boolean;
  strategy: WarmupStrategy;
  /**
   * T-023 — configuracao opcional de geracao de conteudo via IA. Quando
   * useAi=false (default) o backend usa templates do banco; quando true,
   * usa o provider/model/tom escolhidos com fallback automatico para
   * template em caso de falha.
   */
  useAi: boolean;
  aiProvider: WarmupAiProviderName | null;
  aiModel: string | null;
  aiTone: WarmupTone | null;
  createdAt: string;
  updatedAt: string;
}

export interface WarmupNumber {
  id: string;
  poolId: string;
  accountId: string;
  evolutionInstance: string;
  phoneE164: string;
  displayName: string | null;
  status: WarmupNumberStatus;
  currentDay: number;
  qualityScore: number;
  /**
   * Plano diário de envios — Json com a curva mapeada por dia
   * (ex.: { "1": 10, "2": 12, ... }). Estrutura aberta porque o
   * backend pode evoluir; UI só precisa de leitura best-effort.
   */
  dailyEnvioPlan: Record<string, number> | null;
  dailyEnviadasHoje: number;
  dailyRecebidasHoje: number;
  startedAt: string | null;
  lastActivityAt: string | null;
  pausedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * T-023 V2 (Phase 4) — biblioteca de midias usadas pelas conversas de
 * aquecimento. Cada item e um WarmupTemplate com type ∈ audio|sticker|image
 * e arquivo persistido em backend/uploads/warmup/{type}/. Quando
 * accountId=null o registro e "global" (seed compartilhado) e nao pode ser
 * apagado por admin comum.
 */
export type WarmupMediaType = 'audio' | 'sticker' | 'image';

export interface WarmupMedia {
  id: string;
  accountId: string | null;
  type: WarmupMediaType;
  category: string;
  content: string;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  mediaSizeBytes: number | null;
  mediaDurationMs: number | null;
  fileName: string | null;
  isGlobal: boolean;
  createdAt: string;
}

export interface WarmupDailyStats {
  id: string;
  numberId: string;
  /** Data (YYYY-MM-DD) referente ao dia agregado. */
  date: string;
  protocolDay: number;
  plannedSends: number;
  actualSends: number;
  actualReceives: number;
  failedSends: number;
  qualityEnd: number;
  statusEnd: WarmupNumberStatus;
}

// ============================================
// Inputs
// ============================================

export interface CreatePoolInput {
  name: string;
  description?: string | null;
  isPublic?: boolean;
  strategy: WarmupStrategy;
  /** T-023 — IA opt-in por pool. Default false. */
  useAi?: boolean;
  aiProvider?: WarmupAiProviderName | null;
  aiModel?: string | null;
  aiTone?: WarmupTone | null;
}

export interface UpdatePoolInput {
  name?: string;
  description?: string | null;
  isPublic?: boolean;
  isActive?: boolean;
  strategy?: WarmupStrategy;
  useAi?: boolean;
  aiProvider?: WarmupAiProviderName | null;
  aiModel?: string | null;
  aiTone?: WarmupTone | null;
}

export interface ListPoolsParams {
  /** Inclui pools publicos de outras contas (default false no backend). */
  includePublic?: boolean;
}

export interface CreateNumberInput {
  poolId: string;
  evolutionInstance: string;
  phoneE164: string;
  displayName?: string | null;
}

export interface ListNumbersParams {
  poolId?: string;
  status?: WarmupNumberStatus;
}

export interface PauseNumberInput {
  reason?: string;
}

// ============================================
// Mapeadores (defensivos snake_case / camelCase)
// ============================================

function unwrap<T = unknown>(response: unknown): T {
  const r = response as { data?: T } | T;
  if (r && typeof r === 'object' && 'data' in (r as Record<string, unknown>)) {
    return (r as { data: T }).data;
  }
  return r as T;
}

function mapPool(raw: Record<string, unknown>): WarmupPool {
  const r = raw as Record<string, unknown>;
  const providerRaw = (r.aiProvider ?? r.ai_provider ?? null) as
    | string
    | null;
  const toneRaw = (r.aiTone ?? r.ai_tone ?? null) as string | null;
  return {
    id: String(r.id),
    accountId: String(r.accountId ?? r.account_id ?? ''),
    name: String(r.name ?? ''),
    description: (r.description as string | null) ?? null,
    isPublic: Boolean(r.isPublic ?? r.is_public ?? false),
    isActive: Boolean(r.isActive ?? r.is_active ?? true),
    strategy: ((r.strategy as WarmupStrategy) ?? 'moderate') as WarmupStrategy,
    useAi: Boolean(r.useAi ?? r.use_ai ?? false),
    aiProvider:
      providerRaw === 'openai' || providerRaw === 'anthropic'
        ? (providerRaw as WarmupAiProviderName)
        : null,
    aiModel: (r.aiModel ?? r.ai_model ?? null) as string | null,
    aiTone:
      toneRaw === 'casual' ||
      toneRaw === 'formal' ||
      toneRaw === 'gym' ||
      toneRaw === 'clinic'
        ? (toneRaw as WarmupTone)
        : null,
    createdAt: String(r.createdAt ?? r.created_at ?? ''),
    updatedAt: String(r.updatedAt ?? r.updated_at ?? ''),
  };
}

function mapNumber(raw: Record<string, unknown>): WarmupNumber {
  const r = raw as Record<string, unknown>;
  const planRaw = (r.dailyEnvioPlan ?? r.daily_envio_plan) as
    | Record<string, number>
    | null
    | undefined;
  return {
    id: String(r.id),
    poolId: String(r.poolId ?? r.pool_id ?? ''),
    accountId: String(r.accountId ?? r.account_id ?? ''),
    evolutionInstance: String(r.evolutionInstance ?? r.evolution_instance ?? ''),
    phoneE164: String(r.phoneE164 ?? r.phone_e164 ?? ''),
    displayName: (r.displayName ?? r.display_name ?? null) as string | null,
    status: ((r.status as WarmupNumberStatus) ?? 'cold') as WarmupNumberStatus,
    currentDay: Number(r.currentDay ?? r.current_day ?? 0),
    qualityScore: Number(r.qualityScore ?? r.quality_score ?? 100),
    dailyEnvioPlan: planRaw && typeof planRaw === 'object' ? planRaw : null,
    dailyEnviadasHoje: Number(r.dailyEnviadasHoje ?? r.daily_enviadas_hoje ?? 0),
    dailyRecebidasHoje: Number(r.dailyRecebidasHoje ?? r.daily_recebidas_hoje ?? 0),
    startedAt: (r.startedAt ?? r.started_at ?? null) as string | null,
    lastActivityAt: (r.lastActivityAt ?? r.last_activity_at ?? null) as string | null,
    pausedReason: (r.pausedReason ?? r.paused_reason ?? null) as string | null,
    createdAt: String(r.createdAt ?? r.created_at ?? ''),
    updatedAt: String(r.updatedAt ?? r.updated_at ?? ''),
  };
}

function mapMedia(raw: Record<string, unknown>): WarmupMedia {
  const r = raw as Record<string, unknown>;
  const typeRaw = String(r.type ?? '');
  const type: WarmupMediaType =
    typeRaw === 'audio' || typeRaw === 'sticker' || typeRaw === 'image'
      ? (typeRaw as WarmupMediaType)
      : 'image';
  const accountIdRaw = (r.accountId ?? r.account_id ?? null) as string | null;
  return {
    id: String(r.id),
    accountId: accountIdRaw ? String(accountIdRaw) : null,
    type,
    category: String(r.category ?? ''),
    content: String(r.content ?? ''),
    mediaUrl: (r.mediaUrl ?? r.media_url ?? null) as string | null,
    mediaMimeType: (r.mediaMimeType ?? r.media_mime_type ?? null) as
      | string
      | null,
    mediaSizeBytes:
      r.mediaSizeBytes != null || r.media_size_bytes != null
        ? Number(r.mediaSizeBytes ?? r.media_size_bytes)
        : (r.sizeBytes != null ? Number(r.sizeBytes) : null),
    mediaDurationMs:
      r.mediaDurationMs != null || r.media_duration_ms != null
        ? Number(r.mediaDurationMs ?? r.media_duration_ms)
        : null,
    fileName: (r.fileName ?? r.file_name ?? null) as string | null,
    isGlobal: Boolean(r.isGlobal ?? r.is_global ?? accountIdRaw === null),
    createdAt: String(r.createdAt ?? r.created_at ?? ''),
  };
}

function mapDailyStats(raw: Record<string, unknown>): WarmupDailyStats {
  const r = raw as Record<string, unknown>;
  return {
    id: String(r.id),
    numberId: String(r.numberId ?? r.number_id ?? ''),
    date: String(r.date ?? ''),
    protocolDay: Number(r.protocolDay ?? r.protocol_day ?? 0),
    plannedSends: Number(r.plannedSends ?? r.planned_sends ?? 0),
    actualSends: Number(r.actualSends ?? r.actual_sends ?? 0),
    actualReceives: Number(r.actualReceives ?? r.actual_receives ?? 0),
    failedSends: Number(r.failedSends ?? r.failed_sends ?? 0),
    qualityEnd: Number(r.qualityEnd ?? r.quality_end ?? 100),
    statusEnd: ((r.statusEnd ?? r.status_end ?? 'warming') as WarmupNumberStatus),
  };
}

// ============================================
// Service
// ============================================

export const warmupBackendService = {
  // ----- Pools -----

  async listPools(params?: ListPoolsParams): Promise<WarmupPool[]> {
    const qs =
      params && params.includePublic
        ? `?includePublic=${params.includePublic ? 'true' : 'false'}`
        : '';
    const response = await apiClient.get<unknown>(
      API_ENDPOINTS.WARMUP.POOLS + qs,
    );
    const raw = unwrap<unknown[]>(response);
    return (Array.isArray(raw) ? raw : []).map((p) =>
      mapPool(p as Record<string, unknown>),
    );
  },

  async createPool(body: CreatePoolInput): Promise<WarmupPool> {
    const response = await apiClient.post<unknown>(
      API_ENDPOINTS.WARMUP.POOLS,
      body,
    );
    return mapPool(unwrap<Record<string, unknown>>(response));
  },

  async updatePool(id: string, body: UpdatePoolInput): Promise<WarmupPool> {
    const response = await apiClient.patch<unknown>(
      API_ENDPOINTS.WARMUP.POOL(id),
      body,
    );
    return mapPool(unwrap<Record<string, unknown>>(response));
  },

  async deletePool(id: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.WARMUP.POOL(id));
  },

  // ----- Numbers -----

  async listNumbers(params?: ListNumbersParams): Promise<WarmupNumber[]> {
    const search = new URLSearchParams();
    if (params?.poolId) search.set('poolId', params.poolId);
    if (params?.status) search.set('status', params.status);
    const qs = search.toString();
    const response = await apiClient.get<unknown>(
      API_ENDPOINTS.WARMUP.NUMBERS + (qs ? `?${qs}` : ''),
    );
    const raw = unwrap<unknown[]>(response);
    return (Array.isArray(raw) ? raw : []).map((n) =>
      mapNumber(n as Record<string, unknown>),
    );
  },

  async createNumber(body: CreateNumberInput): Promise<WarmupNumber> {
    const response = await apiClient.post<unknown>(
      API_ENDPOINTS.WARMUP.NUMBERS,
      body,
    );
    return mapNumber(unwrap<Record<string, unknown>>(response));
  },

  async startNumber(id: string): Promise<WarmupNumber> {
    const response = await apiClient.post<unknown>(
      API_ENDPOINTS.WARMUP.NUMBER_START(id),
    );
    return mapNumber(unwrap<Record<string, unknown>>(response));
  },

  async pauseNumber(id: string, body?: PauseNumberInput): Promise<WarmupNumber> {
    const response = await apiClient.post<unknown>(
      API_ENDPOINTS.WARMUP.NUMBER_PAUSE(id),
      body ?? {},
    );
    return mapNumber(unwrap<Record<string, unknown>>(response));
  },

  async resumeNumber(id: string): Promise<WarmupNumber> {
    const response = await apiClient.post<unknown>(
      API_ENDPOINTS.WARMUP.NUMBER_RESUME(id),
    );
    return mapNumber(unwrap<Record<string, unknown>>(response));
  },

  async deleteNumber(id: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.WARMUP.NUMBER(id));
  },

  async getStats(id: string): Promise<WarmupDailyStats[]> {
    const response = await apiClient.get<unknown>(
      API_ENDPOINTS.WARMUP.NUMBER_STATS(id),
    );
    const raw = unwrap<unknown[]>(response);
    return (Array.isArray(raw) ? raw : []).map((s) =>
      mapDailyStats(s as Record<string, unknown>),
    );
  },

  // ----- Media library (T-023 V2 / Phase 4) -----

  /**
   * Lista midias (audio/sticker/image) disponiveis para a conta + globais.
   * Filtra por tipo opcionalmente.
   */
  async listMedia(type?: WarmupMediaType): Promise<WarmupMedia[]> {
    const qs = type ? `?type=${encodeURIComponent(type)}` : '';
    const response = await apiClient.get<unknown>(
      API_ENDPOINTS.WARMUP.MEDIA + qs,
    );
    const raw = unwrap<unknown[]>(response);
    return (Array.isArray(raw) ? raw : []).map((m) =>
      mapMedia(m as Record<string, unknown>),
    );
  },

  /**
   * Upload de um arquivo de midia. Usa multipart/form-data via fetch direto
   * porque o apiClient padrao serializa o body como JSON e cravaria
   * Content-Type=application/json, o que quebra o multer no backend.
   *
   * Mantemos paridade com apiClient quanto a:
   *  - prefixo /api da apiConfig.baseUrl
   *  - Bearer token injetado a partir do tokenManager
   *  - leitura best-effort do envelope { data } e shape de erro do backend
   */
  async uploadMedia(
    file: File,
    type: WarmupMediaType,
    category?: string,
  ): Promise<WarmupMedia> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', type);
    if (category) formData.append('category', category);

    // Resolve URL respeitando apiConfig.baseUrl + endpoint (mesma logica do
    // apiClient: nao podemos importar buildUrl pois e privado).
    const baseUrl = apiConfig.baseUrl;
    const endpoint = API_ENDPOINTS.WARMUP.MEDIA_UPLOAD;
    let fullUrl: string;
    if (baseUrl.startsWith('http')) {
      const prefix = new URL(baseUrl).pathname.replace(/\/+$/, '');
      const normalized =
        prefix && endpoint.startsWith(prefix + '/')
          ? endpoint.slice(prefix.length)
          : endpoint;
      fullUrl = `${baseUrl.replace(/\/+$/, '')}${normalized}`;
    } else {
      const prefix = baseUrl.replace(/\/+$/, '');
      const normalized =
        prefix && endpoint.startsWith(prefix + '/')
          ? endpoint.slice(prefix.length)
          : endpoint;
      fullUrl = `${window.location.origin}${prefix}${normalized}`;
    }

    const token = tokenManager.getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // NAO setamos Content-Type — o browser preenche com o boundary correto.

    const res = await fetch(fullUrl, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!res.ok) {
      let message = res.statusText || 'Erro no upload da midia';
      let details: Record<string, unknown> | undefined;
      try {
        const body = await res.json();
        message =
          body?.error?.message ||
          body?.message ||
          body?.error ||
          message;
        const rawDetails = body?.error?.details ?? body?.details;
        if (
          rawDetails &&
          typeof rawDetails === 'object' &&
          !Array.isArray(rawDetails)
        ) {
          details = rawDetails as Record<string, unknown>;
        }
      } catch {
        /* ignore json parse errors */
      }
      const err: ApiError = { message, status: res.status, details };
      throw err;
    }

    const body = await res.json().catch(() => ({}));
    const data = unwrap<Record<string, unknown>>(body);
    return mapMedia(data);
  },

  async deleteMedia(id: string): Promise<void> {
    await apiClient.delete(API_ENDPOINTS.WARMUP.MEDIA_DELETE(id));
  },

  // ----- AI Providers (T-023) -----

  /**
   * Lista providers de IA registrados no backend e indica quais estao
   * habilitados em runtime (env vars presentes). Tambem retorna a lista
   * canonica de tons suportados, evitando que a UI fique fora de sincronia
   * com o backend.
   */
  async getAiProviders(): Promise<WarmupAiProvidersResponse> {
    const response = await apiClient.get<unknown>(
      API_ENDPOINTS.WARMUP.AI_PROVIDERS,
    );
    const raw = unwrap<Record<string, unknown>>(response);
    const providersRaw = Array.isArray(raw?.providers)
      ? (raw.providers as Record<string, unknown>[])
      : [];
    const providers: WarmupAiProviderInfo[] = providersRaw
      .map((p) => {
        const name = String(p.name ?? '');
        if (name !== 'openai' && name !== 'anthropic') return null;
        return {
          name: name as WarmupAiProviderName,
          defaultModel: String(p.defaultModel ?? p.default_model ?? ''),
          enabled: Boolean(p.enabled),
        } satisfies WarmupAiProviderInfo;
      })
      .filter((p): p is WarmupAiProviderInfo => p !== null);

    const tonesRaw = Array.isArray(raw?.supportedTones)
      ? (raw.supportedTones as unknown[])
      : Array.isArray(raw?.supported_tones)
        ? (raw.supported_tones as unknown[])
        : [];
    const supportedTones: WarmupTone[] = tonesRaw
      .map((t) => String(t))
      .filter(
        (t): t is WarmupTone =>
          t === 'casual' || t === 'formal' || t === 'gym' || t === 'clinic',
      );

    return {
      providers,
      anyEnabled: Boolean(raw?.anyEnabled ?? raw?.any_enabled ?? false),
      supportedTones,
    };
  },
};

export default warmupBackendService;
