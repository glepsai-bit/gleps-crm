/**
 * SLA Policies Backend Service (T-022 — chat interno)
 *
 * CRUD de políticas de SLA + aplicação em uma conversation +
 * listagem dos breaches mais recentes.
 *
 * - Auth: super_admin OU admin (validado no backend).
 *   - admin: escopo automático na própria conta.
 *   - super_admin: precisa passar ?accountId= (ver `resolveAccountId`).
 * - Tempos (firstResponseMin / resolutionMin) são minutos inteiros positivos.
 * - delete não derruba conversations: slaPolicyId fica null (SetNull).
 *
 * Backend: backend/src/controllers/sla.controller.ts
 *          backend/src/services/sla.service.ts
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

export interface SLAPolicy {
  id: string;
  accountId: string;
  name: string;
  firstResponseMin: number;
  resolutionMin: number;
  businessHoursOnly: boolean;
  active: boolean;
  // SLA v2 — pausa SLA quando aguarda cliente (ultima msg foi do agente/IA)
  pauseWhenWaitingCustomer: boolean;
  // SLA v2 — janela "HH:MM" do horario comercial (null = sem janela = 24/7)
  businessHoursStart: string | null;
  businessHoursEnd: string | null;
  // SLA v2 — dias da semana (0=domingo .. 6=sabado); default seg-sex.
  businessDays: number[];
  // SLA v2 — timezone IANA (default America/Sao_Paulo)
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface SLABreach {
  id: string;
  slaPolicyId: string;
  conversationId: string;
  /** Alias amigavel — espelha `breachType` do schema. */
  type: 'first_response' | 'resolution' | string;
  /** Mesmo valor de `type`, exposto para quem prefere o nome do schema. */
  breachType: 'first_response' | 'resolution' | string;
  /** Quando o SLA era esperado ser cumprido (deadline). */
  expectedAt: string;
  /** Quando o breach foi detectado. */
  breachedAt: string;
  /** Quando a notificacao foi enviada (se ja foi). */
  notifiedAt: string | null;
  /** Minutos previstos pela policy para esse tipo de breach. */
  expectedMin: number;
  /** Minutos reais decorridos ate o breach (expectedMin + atraso). */
  actualMin: number | null;
  /** Compat: igual a `breachedAt` (schema nao guarda createdAt separado). */
  createdAt: string;
}

/**
 * SLA v2 — payload do GET /api/sla/dashboard.
 * Shape espelha `slaService.getDashboard` no backend.
 */
export interface SLADashboardResult {
  totalConversations: number;
  resolvedWithinSla: number;
  breachedFirstResponse: number;
  breachedResolution: number;
  /** Segundos. null quando nao ha amostras. */
  avgFirstResponseSec: number | null;
  /** Segundos. null quando nao ha amostras. */
  avgResolutionSec: number | null;
  /** Mapa outcome -> count. Outcomes podem ser ausentes. */
  outcomes: Record<string, number>;
  /** CSAT medio (1-5) ou null se ninguem respondeu. */
  csatAvg: number | null;
  /** Razao 0..1 (respondidos / pedidos). 0 quando nada foi pedido. */
  csatResponseRate: number;
  byAgent: Array<{
    userId: string;
    name: string;
    resolved: number;
    csatAvg: number | null;
    breaches: number;
  }>;
  aiVsHuman: {
    ai: { resolved: number; csat: number | null; breaches: number };
    human: { resolved: number; csat: number | null; breaches: number };
  };
}

export interface SLADashboardFilters {
  /** ISO 8601 */
  fromDate: string;
  /** ISO 8601 */
  toDate: string;
}

export interface CreateSLAPolicyInput {
  name: string;
  firstResponseMin: number;
  resolutionMin: number;
  businessHoursOnly?: boolean;
  // SLA v2
  pauseWhenWaitingCustomer?: boolean;
  businessHoursStart?: string | null;
  businessHoursEnd?: string | null;
  businessDays?: number[];
  timezone?: string;
}

export interface UpdateSLAPolicyInput {
  name?: string;
  firstResponseMin?: number;
  resolutionMin?: number;
  businessHoursOnly?: boolean;
  active?: boolean;
  // SLA v2
  pauseWhenWaitingCustomer?: boolean;
  businessHoursStart?: string | null;
  businessHoursEnd?: string | null;
  businessDays?: number[];
  timezone?: string;
}

/**
 * super_admin não tem accountId próprio; passe explicitamente nas listagens.
 * admin pode omitir (backend ignora).
 */
export interface AccountScopedOptions {
  accountId?: string;
}

function unwrap<T>(resp: any): T {
  return (resp?.data ?? resp) as T;
}

function buildAccountParams(options?: AccountScopedOptions): Record<string, string> | undefined {
  if (options?.accountId) {
    return { accountId: options.accountId };
  }
  return undefined;
}

function mapPolicy(raw: any): SLAPolicy {
  return {
    id: raw.id,
    accountId: raw.accountId ?? raw.account_id,
    name: raw.name,
    firstResponseMin: Number(raw.firstResponseMin ?? raw.first_response_min ?? 0),
    resolutionMin: Number(raw.resolutionMin ?? raw.resolution_min ?? 0),
    businessHoursOnly: Boolean(raw.businessHoursOnly ?? raw.business_hours_only ?? true),
    active: raw.active ?? true,
    // SLA v2 — defaults sensatos pra retrocompatibilidade com tenants
    // antigos que ainda nao tem esses campos populados.
    pauseWhenWaitingCustomer: Boolean(
      raw.pauseWhenWaitingCustomer ?? raw.pause_when_waiting_customer ?? false
    ),
    businessHoursStart: raw.businessHoursStart ?? raw.business_hours_start ?? null,
    businessHoursEnd: raw.businessHoursEnd ?? raw.business_hours_end ?? null,
    businessDays: Array.isArray(raw.businessDays ?? raw.business_days)
      ? (raw.businessDays ?? raw.business_days)
      : [1, 2, 3, 4, 5],
    timezone: raw.timezone ?? 'America/Sao_Paulo',
    createdAt: raw.createdAt ?? raw.created_at,
    updatedAt: raw.updatedAt ?? raw.updated_at ?? raw.createdAt ?? raw.created_at,
  };
}

/**
 * Mapeia um SLABreach do backend.
 *
 * O schema Prisma guarda `breachType` / `expectedAt` / `breachedAt` /
 * `notifiedAt` (sem `expectedMin` / `actualMin` / `createdAt`). O controller
 * do BE enriquece a resposta com `type` / `expectedMin` / `actualMin` /
 * `createdAt` para preservar o contrato do FE; este mapper ainda assim
 * deriva esses campos caso receba a forma "crua" (snake_case ou Prisma puro)
 * para nunca exibir `undefined` na UI.
 */
function mapBreach(raw: any): SLABreach {
  const breachType: string =
    raw.breachType ?? raw.breach_type ?? raw.type ?? '';

  const expectedAt: string =
    raw.expectedAt ?? raw.expected_at ?? '';
  const breachedAt: string =
    raw.breachedAt ?? raw.breached_at ?? '';
  const notifiedAtRaw = raw.notifiedAt ?? raw.notified_at ?? null;
  const notifiedAt: string | null = notifiedAtRaw ?? null;

  const expectedMin = Number(
    raw.expectedMin ?? raw.expected_min ?? 0
  );

  // actualMin pode vir pronto do BE; se nao vier, deriva a partir
  // dos timestamps (overdueMinutes + expectedMin).
  let actualMin: number | null;
  if (raw.actualMin !== undefined) {
    actualMin = raw.actualMin === null ? null : Number(raw.actualMin);
  } else if (raw.actual_min !== undefined) {
    actualMin = raw.actual_min === null ? null : Number(raw.actual_min);
  } else if (expectedAt && breachedAt) {
    const expectedAtMs = new Date(expectedAt).getTime();
    const breachedAtMs = new Date(breachedAt).getTime();
    if (Number.isFinite(expectedAtMs) && Number.isFinite(breachedAtMs)) {
      const overdueMin = Math.max(0, Math.round((breachedAtMs - expectedAtMs) / 60000));
      actualMin = expectedMin + overdueMin;
    } else {
      actualMin = null;
    }
  } else {
    actualMin = null;
  }

  return {
    id: raw.id,
    slaPolicyId: raw.slaPolicyId ?? raw.sla_policy_id,
    conversationId: raw.conversationId ?? raw.conversation_id,
    type: breachType,
    breachType,
    expectedAt,
    breachedAt,
    notifiedAt,
    expectedMin,
    actualMin,
    createdAt: raw.createdAt ?? raw.created_at ?? breachedAt,
  };
}

export const slaPoliciesBackendService = {
  /**
   * Lista políticas de SLA (admin: própria conta; super_admin: precisa accountId).
   */
  async listSLAPolicies(options?: AccountScopedOptions): Promise<SLAPolicy[]> {
    const resp = await apiClient.get<any>(API_ENDPOINTS.SLA_POLICIES.LIST, {
      params: buildAccountParams(options),
    });
    const items = unwrap<any[]>(resp);
    return Array.isArray(items) ? items.map(mapPolicy) : [];
  },

  async get(id: string, options?: AccountScopedOptions): Promise<SLAPolicy> {
    if (!id) throw new Error('id é obrigatório');
    const resp = await apiClient.get<any>(API_ENDPOINTS.SLA_POLICIES.GET(id), {
      params: buildAccountParams(options),
    });
    return mapPolicy(unwrap<any>(resp));
  },

  async create(
    input: CreateSLAPolicyInput,
    options?: AccountScopedOptions
  ): Promise<SLAPolicy> {
    if (!input?.name?.trim()) throw new Error('name é obrigatório');
    if (!Number.isFinite(input.firstResponseMin) || input.firstResponseMin <= 0) {
      throw new Error('firstResponseMin deve ser inteiro positivo');
    }
    if (!Number.isFinite(input.resolutionMin) || input.resolutionMin <= 0) {
      throw new Error('resolutionMin deve ser inteiro positivo');
    }

    const resp = await apiClient.post<any>(API_ENDPOINTS.SLA_POLICIES.CREATE, input, {
      params: buildAccountParams(options),
    });
    return mapPolicy(unwrap<any>(resp));
  },

  async update(
    id: string,
    input: UpdateSLAPolicyInput,
    options?: AccountScopedOptions
  ): Promise<SLAPolicy> {
    if (!id) throw new Error('id é obrigatório');
    const resp = await apiClient.patch<any>(
      API_ENDPOINTS.SLA_POLICIES.UPDATE(id),
      input,
      { params: buildAccountParams(options) }
    );
    return mapPolicy(unwrap<any>(resp));
  },

  async delete(id: string, options?: AccountScopedOptions): Promise<void> {
    if (!id) throw new Error('id é obrigatório');
    await apiClient.delete(API_ENDPOINTS.SLA_POLICIES.DELETE(id), {
      params: buildAccountParams(options),
    });
  },

  /**
   * Aplica uma policy a uma conversation específica.
   * Endpoint: POST /api/conversations/:id/sla { policyId }
   */
  async applyPolicyToConversation(
    conversationId: string,
    policyId: string,
    options?: AccountScopedOptions
  ): Promise<void> {
    if (!conversationId) throw new Error('conversationId é obrigatório');
    if (!policyId) throw new Error('policyId é obrigatório');
    await apiClient.post(
      API_ENDPOINTS.SLA_POLICIES.APPLY_TO_CONVERSATION(conversationId),
      { policyId },
      { params: buildAccountParams(options) }
    );
  },

  /**
   * Lista os 50 breaches mais recentes da policy.
   * Endpoint: GET /api/sla-policies/:id/breaches
   */
  async listBreaches(
    policyId: string,
    options?: AccountScopedOptions
  ): Promise<SLABreach[]> {
    if (!policyId) throw new Error('policyId é obrigatório');
    const resp = await apiClient.get<any>(
      API_ENDPOINTS.SLA_POLICIES.BREACHES(policyId),
      { params: buildAccountParams(options) }
    );
    const items = unwrap<any[]>(resp);
    return Array.isArray(items) ? items.map(mapBreach) : [];
  },

  /**
   * SLA v2 — Dashboard agregado: % dentro do SLA, outcomes, CSAT, ranking
   * agentes e IA vs Humano.
   *
   * Endpoint: GET /api/sla/dashboard?fromDate=...&toDate=...
   */
  async getDashboard(
    filters: SLADashboardFilters,
    options?: AccountScopedOptions
  ): Promise<SLADashboardResult> {
    if (!filters?.fromDate || !filters?.toDate) {
      throw new Error('fromDate e toDate sao obrigatorios');
    }
    const params: Record<string, string> = {
      fromDate: filters.fromDate,
      toDate: filters.toDate,
    };
    const accountParams = buildAccountParams(options);
    if (accountParams) Object.assign(params, accountParams);

    const resp = await apiClient.get<any>(API_ENDPOINTS.SLA_POLICIES.DASHBOARD, {
      params,
    });
    const raw = unwrap<any>(resp);
    // Defensiva: backend devolve tudo certo, mas a UI nunca quebra se
    // algum campo vier ausente em algum deploy antigo.
    return {
      totalConversations: Number(raw?.totalConversations ?? 0),
      resolvedWithinSla: Number(raw?.resolvedWithinSla ?? 0),
      breachedFirstResponse: Number(raw?.breachedFirstResponse ?? 0),
      breachedResolution: Number(raw?.breachedResolution ?? 0),
      avgFirstResponseSec:
        raw?.avgFirstResponseSec == null ? null : Number(raw.avgFirstResponseSec),
      avgResolutionSec:
        raw?.avgResolutionSec == null ? null : Number(raw.avgResolutionSec),
      outcomes: (raw?.outcomes ?? {}) as Record<string, number>,
      csatAvg: raw?.csatAvg == null ? null : Number(raw.csatAvg),
      csatResponseRate: Number(raw?.csatResponseRate ?? 0),
      byAgent: Array.isArray(raw?.byAgent)
        ? raw.byAgent.map((a: any) => ({
            userId: String(a.userId),
            name: String(a.name ?? 'Desconhecido'),
            resolved: Number(a.resolved ?? 0),
            csatAvg: a.csatAvg == null ? null : Number(a.csatAvg),
            breaches: Number(a.breaches ?? 0),
          }))
        : [],
      aiVsHuman: {
        ai: {
          resolved: Number(raw?.aiVsHuman?.ai?.resolved ?? 0),
          csat:
            raw?.aiVsHuman?.ai?.csat == null
              ? null
              : Number(raw.aiVsHuman.ai.csat),
          breaches: Number(raw?.aiVsHuman?.ai?.breaches ?? 0),
        },
        human: {
          resolved: Number(raw?.aiVsHuman?.human?.resolved ?? 0),
          csat:
            raw?.aiVsHuman?.human?.csat == null
              ? null
              : Number(raw.aiVsHuman.human.csat),
          breaches: Number(raw?.aiVsHuman?.human?.breaches ?? 0),
        },
      },
    };
  },
};

export default slaPoliciesBackendService;
