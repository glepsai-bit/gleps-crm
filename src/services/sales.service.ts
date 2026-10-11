/**
 * Sales Service
 *
 * Só leitura: histórico de vendas de um contato. O registro da venda é
 * feito pelo fechamento no Kanban (PATCH /contacts/:id/fechamento).
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { Sale } from '@/types/crm';
import { apiFeatures } from '@/config/api.config';
import { mockSales } from '@/mocks/data/mockData';

export const salesService = {
  /**
   * Get sales by contact
   *
   * Backend devolve envelope paginado { data: Sale[], meta: {...} }
   * (contact.controller.getSales). O ContactSidePanel faz `.slice` direto, então
   * sem unwrap quebra tudo. Aceita variações: envelope com `data`, array cru,
   * ou paginado com `items`.
   */
  getByContact: async (contactId: string): Promise<Sale[]> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      return mockSales.filter(s => s.contact_id === contactId);
    }

    const response = await apiClient.get<
      Sale[] | { data?: Sale[]; items?: Sale[] }
    >(API_ENDPOINTS.SALES.BY_CONTACT(contactId));

    if (Array.isArray(response)) return response;
    const data = (response as { data?: unknown })?.data;
    if (Array.isArray(data)) return data as Sale[];
    const items = (response as { items?: unknown })?.items;
    if (Array.isArray(items)) return items as Sale[];
    return [];
  },
};

export default salesService;
