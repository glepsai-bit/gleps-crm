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

export interface CreateSLAPolicyInput {
  name: string;
  firstResponseMin: number;
  resolutionMin: number;
  businessHoursOnly?: boolean;
}

export interface UpdateSLAPolicyInput {
  name?: string;
  firstResponseMin?: number;
  resolutionMin?: number;
  businessHoursOnly?: boolean;
  active?: boolean;
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
};

export default slaPoliciesBackendService;
