/**
 * Finance Backend Service
 * 
 * Handles sales, products, contacts, and finance operations
 * via the Express backend API when VITE_USE_BACKEND=true.
 */

import { apiClient, ApiResponse } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { Sale, SaleItem, Product, Contact, LeadNote, PaymentMethod, ContactOrigin } from '@/types/crm';

// ============= MAPPERS =============

function mapSaleItemFromApi(raw: any): SaleItem {
  return {
    id: raw.id,
    product_id: raw.productId || raw.product_id,
    quantidade: raw.quantidade ?? 1,
    valor_unitario: Number(raw.valorUnitario ?? raw.valor_unitario ?? 0),
    valor_total: Number(raw.valorTotal ?? raw.valor_total ?? 0),
    refunded: raw.refunded ?? false,
    refunded_at: raw.refundedAt || raw.refunded_at || null,
    refund_reason: raw.refundReason || raw.refund_reason || null,
  };
}

function mapSaleFromApi(raw: any): Sale {
  const items = (raw.items || raw.saleItems || raw.sale_items || []).map(mapSaleItemFromApi);
  return {
    id: raw.id,
    account_id: raw.accountId || raw.account_id,
    contact_id: raw.contactId || raw.contact_id,
    product_id: items[0]?.product_id || raw.productId || raw.product_id || null,
    items,
    valor: Number(raw.valor ?? 0),
    status: raw.status || 'pending',
    metodo_pagamento: raw.metodoPagamento || raw.metodo_pagamento,
    convenio_nome: raw.convenioNome || raw.convenio_nome || null,
    responsavel_id: raw.responsavelId || raw.responsavel_id,
    is_recurring: raw.isRecurring ?? raw.is_recurring ?? false,
    created_at: raw.createdAt || raw.created_at,
    paid_at: raw.paidAt || raw.paid_at || null,
    refunded_at: raw.refundedAt || raw.refunded_at || null,
    refund_reason: raw.refundReason || raw.refund_reason || null,
  };
}

// ============= SALES =============

export interface CreateSaleBackendData {
  contactId: string;
  items: { productId: string; quantidade: number; valorUnitario: number }[];
  metodoPagamento: PaymentMethod;
  responsavelId: string;
  convenioNome?: string;
}

export const financeBackendService = {
  // --- Sales ---

  fetchSales: async (accountId: string): Promise<Sale[]> => {
    const res = await apiClient.get<any>(API_ENDPOINTS.SALES.LIST);
    const payload = res?.data ?? res;
    const rawSales = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : [];

    return rawSales.map(mapSaleFromApi);
  },

  createSale: async (data: CreateSaleBackendData): Promise<Sale> => {
    const res = await apiClient.post<ApiResponse<any>>(API_ENDPOINTS.SALES.CREATE, data);
    return mapSaleFromApi(res.data);
  },

  markAsPaid: async (saleId: string): Promise<Sale> => {
    const res = await apiClient.patch<ApiResponse<any>>(API_ENDPOINTS.SALES.MARK_PAID(saleId));
    return mapSaleFromApi(res.data);
  },

  refundSale: async (saleId: string, reason: string, password?: string): Promise<Sale> => {
    const headers: Record<string, string> = {};
    if (password) {
      headers['x-confirm-password'] = password;
    }
    const res = await apiClient.post<ApiResponse<any>>(
      API_ENDPOINTS.SALES.REFUND(saleId),
      { reason },
      { headers }
    );
    return mapSaleFromApi(res.data);
  },

  refundSaleItem: async (saleId: string, itemId: string, reason: string, password?: string): Promise<Sale> => {
    const headers: Record<string, string> = {};
    if (password) {
      headers['x-confirm-password'] = password;
    }
    const res = await apiClient.post<ApiResponse<any>>(
      API_ENDPOINTS.SALES.REFUND_ITEM(saleId, itemId),
      { reason },
      { headers }
    );
    return mapSaleFromApi(res.data);
  },

  getSaleKPIs: async (params?: { startDate?: string; endDate?: string }) => {
    const res = await apiClient.get<ApiResponse<any>>(API_ENDPOINTS.SALES.STATS, { params });
    return res.data;
  },

  getAuditLog: async (saleId: string) => {
    const res = await apiClient.get<ApiResponse<any[]>>(API_ENDPOINTS.SALES.TRANSACTIONS(saleId));
    return res.data || [];
  },

  // --- Products ---

  fetchProducts: async (accountId: string): Promise<Product[]> => {
    const res = await apiClient.get<ApiResponse<any[]>>(API_ENDPOINTS.PRODUCTS.LIST, {
      params: { ativo: true },
    });
    return (res.data || []).map(p => ({
      id: p.id,
      account_id: p.accountId || p.account_id,
      nome: p.nome,
      valor_padrao: Number(p.valorPadrao ?? p.valor_padrao ?? 0),
      ativo: p.ativo ?? true,
      metodos_pagamento: p.metodosPagamento || p.metodos_pagamento || ['pix'],
      convenios_aceitos: p.conveniosAceitos || p.convenios_aceitos || [],
      created_at: p.createdAt || p.created_at,
      updated_at: p.updatedAt || p.updated_at,
    }));
  },

  // --- Contacts ---

  fetchContacts: async (accountId: string): Promise<Contact[]> => {
    const res = await apiClient.get<ApiResponse<any[]>>(API_ENDPOINTS.CONTACTS.LIST);
    return (res.data || []).map(c => ({
      id: c.id,
      account_id: c.accountId || c.account_id,
      nome: c.nome,
      telefone: c.telefone,
      email: c.email,
      origem: c.origem,
      chatwoot_contact_id: c.chatwootContactId ?? c.chatwoot_contact_id ?? null,
      chatwoot_conversation_id: c.chatwootConversationId ?? c.chatwoot_conversation_id ?? null,
      first_resolved_at: c.firstResolvedAt || c.first_resolved_at || null,
      created_at: c.createdAt || c.created_at,
      updated_at: c.updatedAt || c.updated_at,
    }));
  },

  createContact: async (accountId: string, data: {
    nome: string;
    telefone: string;
    email: string | null;
    origem: string;
  }): Promise<Contact> => {
    const res = await apiClient.post<ApiResponse<Contact>>(API_ENDPOINTS.CONTACTS.CREATE, data);
    return res.data;
  },

  updateContact: async (contactId: string, data: {
    nome?: string;
    telefone?: string;
    email?: string | null;
    origem?: ContactOrigin;
  }): Promise<Contact> => {
    const res = await apiClient.put<ApiResponse<Contact>>(API_ENDPOINTS.CONTACTS.UPDATE(contactId), data);
    return res.data;
  },

  deleteContact: async (contactId: string): Promise<void> => {
    await apiClient.delete(API_ENDPOINTS.CONTACTS.DELETE(contactId));
  },

  // --- Notes ---

  fetchNotes: async (contactId: string): Promise<LeadNote[]> => {
    const res = await apiClient.get<ApiResponse<LeadNote[]>>(API_ENDPOINTS.CONTACTS.NOTES(contactId));
    return res.data || [];
  },

  addNote: async (contactId: string, content: string, authorId: string, authorName: string): Promise<LeadNote> => {
    const res = await apiClient.post<ApiResponse<LeadNote>>(API_ENDPOINTS.CONTACTS.ADD_NOTE(contactId), {
      content,
      authorId,
      authorName,
    });
    return res.data;
  },

  // --- Finance KPIs ---

  getFinanceKPIs: async (params?: { startDate?: string; endDate?: string }) => {
    const res = await apiClient.get<ApiResponse<any>>('/api/finance/kpis', { params });
    return res.data;
  },

  getRevenueChart: async (params?: { startDate?: string; endDate?: string; granularity?: string }) => {
    const res = await apiClient.get<ApiResponse<any>>('/api/finance/revenue-chart', { params });
    return res.data;
  },

  getPaymentMethods: async (params?: { startDate?: string; endDate?: string }) => {
    const res = await apiClient.get<ApiResponse<any>>('/api/finance/payment-methods', { params });
    return res.data;
  },

  getFunnelConversion: async (params?: { startDate?: string; endDate?: string }) => {
    const res = await apiClient.get<ApiResponse<any>>('/api/finance/funnel-conversion', { params });
    return res.data;
  },
};

export default financeBackendService;
