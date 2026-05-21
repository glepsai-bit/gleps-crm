/**
 * Products Service
 * 
 * Handles all product-related API calls.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { 
  ProductListParams, 
  CreateProductRequest, 
  UpdateProductRequest,
  PaginatedResponse 
} from '@/api/types';
import type { Product } from '@/types/crm';
import { apiFeatures } from '@/config/api.config';

// Mock imports for development
import { mockProducts } from '@/mocks/data/mockData';

export const productsService = {
  /**
   * List products with optional filters
   */
  list: async (params?: ProductListParams): Promise<PaginatedResponse<Product>> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      let filtered = [...mockProducts];
      
      if (params?.ativo !== undefined) {
        filtered = filtered.filter(p => p.ativo === params.ativo);
      }
      
      if (params?.search) {
        const search = params.search.toLowerCase();
        filtered = filtered.filter(p => 
          p.nome.toLowerCase().includes(search)
        );
      }
      
      const page = params?.page || 1;
      const limit = params?.limit || 50;
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
    
    return apiClient.get<PaginatedResponse<Product>>(API_ENDPOINTS.PRODUCTS.LIST, { params });
  },

  /**
   * Get active products only
   */
  listActive: async (): Promise<Product[]> => {
    const response = await productsService.list({ ativo: true });
    return response.data;
  },

  /**
   * Get a single product by ID
   */
  get: async (id: string): Promise<Product> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const product = mockProducts.find(p => p.id === id);
      if (!product) {
        throw { message: 'Produto não encontrado', status: 404 };
      }
      return product;
    }
    
    return apiClient.get<Product>(API_ENDPOINTS.PRODUCTS.GET(id));
  },

  /**
   * Create a new product
   */
  create: async (data: CreateProductRequest): Promise<Product> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const newProduct: Product = {
        id: `prod-${Date.now()}`,
        account_id: 'acc-1',
        nome: data.nome,
        valor_padrao: data.valorPadrao,
        metodos_pagamento: data.metodosPagamento,
        convenios_aceitos: data.conveniosAceitos || [],
        ativo: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      
      mockProducts.push(newProduct);
      return newProduct;
    }
    
    return apiClient.post<Product>(API_ENDPOINTS.PRODUCTS.CREATE, data);
  },

  /**
   * Update an existing product
   */
  update: async (id: string, data: UpdateProductRequest): Promise<Product> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockProducts.findIndex(p => p.id === id);
      if (index === -1) {
        throw { message: 'Produto não encontrado', status: 404 };
      }
      
      mockProducts[index] = {
        ...mockProducts[index],
        ...(data.nome && { nome: data.nome }),
        ...(data.valorPadrao !== undefined && { valor_padrao: data.valorPadrao }),
        ...(data.metodosPagamento && { metodos_pagamento: data.metodosPagamento }),
        ...(data.conveniosAceitos && { convenios_aceitos: data.conveniosAceitos }),
        ...(data.ativo !== undefined && { ativo: data.ativo }),
        updated_at: new Date().toISOString(),
      };
      
      return mockProducts[index];
    }
    
    return apiClient.put<Product>(API_ENDPOINTS.PRODUCTS.UPDATE(id), data);
  },

  /**
   * Delete a product
   */
  delete: async (id: string): Promise<void> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockProducts.findIndex(p => p.id === id);
      if (index === -1) {
        throw { message: 'Produto não encontrado', status: 404 };
      }
      
      mockProducts.splice(index, 1);
      return;
    }
    
    return apiClient.delete(API_ENDPOINTS.PRODUCTS.DELETE(id));
  },

  /**
   * Toggle product active status
   */
  toggleStatus: async (id: string): Promise<Product> => {
    if (apiFeatures.useMocks) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const index = mockProducts.findIndex(p => p.id === id);
      if (index === -1) {
        throw { message: 'Produto não encontrado', status: 404 };
      }
      
      mockProducts[index] = {
        ...mockProducts[index],
        ativo: !mockProducts[index].ativo,
        updated_at: new Date().toISOString(),
      };
      
      return mockProducts[index];
    }
    
    return apiClient.patch<Product>(API_ENDPOINTS.PRODUCTS.TOGGLE_STATUS(id));
  },
};

export default productsService;
