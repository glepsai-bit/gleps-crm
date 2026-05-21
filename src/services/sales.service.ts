/**
 * Sales Service
 * 
 * Handles all sales-related API calls.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { 
  SaleListParams, 
  CreateSaleRequest, 
  RefundSaleRequest,
  RefundItemRequest,
  SaleStatsResponse,
  PaginatedResponse 
} from '@/api/types';
import type { Sale, SaleTransaction } from '@/types/crm';
import { apiFeatures } from '@/config/api.config';

// Mock imports for development
import { mockSales } from '@/mocks/data/mockData';

export const salesService = {
  /**
   * List sales with optional filters
   */
  list: async (params?: SaleListParams): Promise<PaginatedResponse<Sale>> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      let filtered = [...mockSales];
      
      if (params?.status) {
        filtered = filtered.filter(s => s.status === params.status);
      }
      
      if (params?.contactId) {
        filtered = filtered.filter(s => s.contact_id === params.contactId);
      }
      
      if (params?.responsavelId) {
        filtered = filtered.filter(s => s.responsavel_id === params.responsavelId);
      }
      
      if (params?.startDate) {
        filtered = filtered.filter(s => new Date(s.created_at) >= new Date(params.startDate!));
      }
      
      if (params?.endDate) {
        filtered = filtered.filter(s => new Date(s.created_at) <= new Date(params.endDate!));
      }
      
      const page = params?.page || 1;
      const limit = params?.limit || 20;
      const start = (page - 1) * limit;
      const end = start + limit;
      
      return {
        data: filtered.slice(start, end),
        meta: {
          page,
          limit,
          total: filtered.length,
          totalPages: Math.ceil(filtered.length / limit),
        },
      };
    }
    
    return apiClient.get<PaginatedResponse<Sale>>(API_ENDPOINTS.SALES.LIST, { params });
  },

  /**
   * Get a single sale by ID
   */
  get: async (id: string): Promise<Sale> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const sale = mockSales.find(s => s.id === id);
      if (!sale) {
        throw { message: 'Venda não encontrada', status: 404 };
      }
      return sale;
    }
    
    return apiClient.get<Sale>(API_ENDPOINTS.SALES.GET(id));
  },

  /**
   * Create a new sale
   */
  create: async (data: CreateSaleRequest): Promise<Sale> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const total = data.items.reduce((sum, item) => 
        sum + (item.quantidade * item.valorUnitario), 0
      );
      
      const newSale: Sale = {
        id: `sale-${Date.now()}`,
        account_id: 'acc-1',
        contact_id: data.contactId,
        items: data.items.map((item, index) => ({
          id: `item-${Date.now()}-${index}`,
          product_id: item.productId,
          quantidade: item.quantidade,
          valor_unitario: item.valorUnitario,
          valor_total: item.quantidade * item.valorUnitario,
        })),
        valor: total,
        status: 'pending',
        metodo_pagamento: data.metodoPagamento,
        convenio_nome: data.convenioNome || null,
        responsavel_id: data.responsavelId,
        is_recurring: data.isRecurring || false,
        created_at: new Date().toISOString(),
        paid_at: null,
        refunded_at: null,
      };
      
      mockSales.push(newSale);
      return newSale;
    }
    
    return apiClient.post<Sale>(API_ENDPOINTS.SALES.CREATE, data);
  },

  /**
   * Mark a sale as paid
   */
  markAsPaid: async (id: string): Promise<Sale> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockSales.findIndex(s => s.id === id);
      if (index === -1) {
        throw { message: 'Venda não encontrada', status: 404 };
      }
      
      mockSales[index] = {
        ...mockSales[index],
        status: 'paid',
        paid_at: new Date().toISOString(),
      };
      
      return mockSales[index];
    }
    
    return apiClient.patch<Sale>(API_ENDPOINTS.SALES.MARK_PAID(id));
  },

  /**
   * Refund a complete sale
   */
  refund: async (id: string, data: RefundSaleRequest): Promise<Sale> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockSales.findIndex(s => s.id === id);
      if (index === -1) {
        throw { message: 'Venda não encontrada', status: 404 };
      }
      
      mockSales[index] = {
        ...mockSales[index],
        status: 'refunded',
        refunded_at: new Date().toISOString(),
      };
      
      return mockSales[index];
    }
    
    return apiClient.post<Sale>(API_ENDPOINTS.SALES.REFUND(id), data);
  },

  /**
   * Refund a specific item from a sale
   */
  refundItem: async (saleId: string, itemId: string, data: RefundItemRequest): Promise<Sale> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const sale = mockSales.find(s => s.id === saleId);
      if (!sale) {
        throw { message: 'Venda não encontrada', status: 404 };
      }
      
      // In real implementation, would update item status
      return sale;
    }
    
    return apiClient.post<Sale>(API_ENDPOINTS.SALES.REFUND_ITEM(saleId, itemId), data);
  },

  /**
   * Get sales by contact
   */
  getByContact: async (contactId: string): Promise<Sale[]> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      return mockSales.filter(s => s.contact_id === contactId);
    }
    
    return apiClient.get<Sale[]>(API_ENDPOINTS.SALES.BY_CONTACT(contactId));
  },

  /**
   * Get sale transactions (audit log)
   */
  getTransactions: async (saleId: string): Promise<SaleTransaction[]> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      // Mock transactions - would be stored separately
      return [];
    }
    
    return apiClient.get<SaleTransaction[]>(API_ENDPOINTS.SALES.TRANSACTIONS(saleId));
  },

  /**
   * Get sales statistics
   */
  getStats: async (params?: { startDate?: string; endDate?: string }): Promise<SaleStatsResponse> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      let filtered = [...mockSales];
      
      if (params?.startDate) {
        filtered = filtered.filter(s => new Date(s.created_at) >= new Date(params.startDate!));
      }
      
      if (params?.endDate) {
        filtered = filtered.filter(s => new Date(s.created_at) <= new Date(params.endDate!));
      }
      
      const paid = filtered.filter(s => s.status === 'paid');
      const pending = filtered.filter(s => s.status === 'pending');
      const refunded = filtered.filter(s => s.status === 'refunded');
      
      const totalRevenue = paid.reduce((sum, s) => sum + s.valor, 0);
      const pendingAmount = pending.reduce((sum, s) => sum + s.valor, 0);
      const refundedAmount = refunded.reduce((sum, s) => sum + s.valor, 0);
      
      return {
        totalRevenue,
        totalSales: filtered.length,
        pendingAmount,
        refundedAmount,
        avgTicket: paid.length > 0 ? totalRevenue / paid.length : 0,
        byPaymentMethod: {},
      };
    }
    
    return apiClient.get<SaleStatsResponse>(API_ENDPOINTS.SALES.STATS, { params });
  },
};

export default salesService;
