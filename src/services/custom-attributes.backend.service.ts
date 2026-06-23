/**
 * Custom Attributes Backend Service (T-022 — chat interno)
 *
 * CRUD de definições de campos customizados por conta.
 *
 * Escopos suportados (`scope`):
 *   - conversation
 *   - contact
 *   - account
 *
 * Tipos suportados (`type`):
 *   - text | number | date | list | boolean
 *
 * Regras:
 *   - `key` é a identidade técnica: regex `/^[a-z][a-z0-9_]{0,79}$/i`,
 *     começa com letra e só tem letras/números/underscore. Não pode ser
 *     alterada via PATCH.
 *   - `scope` também é parte da identidade — PATCH não troca scope.
 *   - `options` só faz sentido para `type === 'list'`.
 *
 * Auth: admin OU super_admin (super_admin precisa estar impersonando uma conta).
 *
 * Backend: backend/src/controllers/custom-attribute.controller.ts
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

export type CustomAttributeScope = 'conversation' | 'contact' | 'account';
export type CustomAttributeType = 'text' | 'number' | 'date' | 'list' | 'boolean';

export interface CustomAttribute {
  id: string;
  accountId: string;
  scope: CustomAttributeScope;
  key: string;
  label: string;
  type: CustomAttributeType;
  options: string[] | null;
  required: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomAttributeInput {
  scope: CustomAttributeScope;
  key: string;
  label: string;
  type: CustomAttributeType;
  options?: string[] | null;
  required?: boolean;
}

export interface UpdateCustomAttributeInput {
  label?: string;
  type?: CustomAttributeType;
  options?: string[] | null;
  required?: boolean;
}

function unwrap<T>(resp: any): T {
  return (resp?.data ?? resp) as T;
}

function mapCustomAttribute(raw: any): CustomAttribute {
  return {
    id: raw.id,
    accountId: raw.accountId ?? raw.account_id,
    scope: raw.scope,
    key: raw.key,
    label: raw.label ?? raw.key,
    type: raw.type,
    options: Array.isArray(raw.options) ? raw.options : raw.options ?? null,
    required: Boolean(raw.required ?? false),
    createdAt: raw.createdAt ?? raw.created_at,
    updatedAt: raw.updatedAt ?? raw.updated_at ?? raw.createdAt ?? raw.created_at,
  };
}

export const customAttributesBackendService = {
  /**
   * Lista definições de campos customizados da conta. Filtro opcional por escopo.
   */
  async listCustomAttributes(
    scope?: CustomAttributeScope
  ): Promise<CustomAttribute[]> {
    const params = scope ? { scope } : undefined;
    const resp = await apiClient.get<any>(API_ENDPOINTS.CUSTOM_ATTRIBUTES.LIST, {
      params,
    });
    const items = unwrap<any[]>(resp);
    return Array.isArray(items) ? items.map(mapCustomAttribute) : [];
  },

  async get(id: string): Promise<CustomAttribute> {
    if (!id) throw new Error('id é obrigatório');
    const resp = await apiClient.get<any>(API_ENDPOINTS.CUSTOM_ATTRIBUTES.GET(id));
    return mapCustomAttribute(unwrap<any>(resp));
  },

  async create(input: CreateCustomAttributeInput): Promise<CustomAttribute> {
    if (!input?.scope) throw new Error('scope é obrigatório');
    if (!input?.key?.trim()) throw new Error('key é obrigatório');
    if (!input?.label?.trim()) throw new Error('label é obrigatório');
    if (!input?.type) throw new Error('type é obrigatório');

    const payload: CreateCustomAttributeInput = {
      scope: input.scope,
      key: input.key,
      label: input.label,
      type: input.type,
      options: input.options ?? null,
      required: input.required ?? false,
    };

    const resp = await apiClient.post<any>(
      API_ENDPOINTS.CUSTOM_ATTRIBUTES.CREATE,
      payload
    );
    return mapCustomAttribute(unwrap<any>(resp));
  },

  /**
   * Atualização parcial. Não permite alterar scope/key.
   */
  async update(
    id: string,
    input: UpdateCustomAttributeInput
  ): Promise<CustomAttribute> {
    if (!id) throw new Error('id é obrigatório');
    const resp = await apiClient.patch<any>(
      API_ENDPOINTS.CUSTOM_ATTRIBUTES.UPDATE(id),
      input
    );
    return mapCustomAttribute(unwrap<any>(resp));
  },

  async delete(id: string): Promise<void> {
    if (!id) throw new Error('id é obrigatório');
    await apiClient.delete(API_ENDPOINTS.CUSTOM_ATTRIBUTES.DELETE(id));
  },
};

export default customAttributesBackendService;
