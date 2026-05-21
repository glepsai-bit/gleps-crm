import React, { createContext, useContext, useState, useCallback, useMemo, ReactNode, useEffect } from 'react';
import { Product, PaymentMethod } from '@/types/crm';
import { productsService } from '@/services/products.service';
import { useBackend } from '@/config/backend.config';
import { toast } from 'sonner';

// ============= TYPES =============

export interface CreateProductData {
  nome: string;
  valor_padrao: number;
  metodos_pagamento: PaymentMethod[];
  convenios_aceitos: string[];
  ativo: boolean;
}

export interface UpdateProductData {
  nome?: string;
  valor_padrao?: number;
  metodos_pagamento?: PaymentMethod[];
  convenios_aceitos?: string[];
  ativo?: boolean;
}

interface ProductContextType {
  products: Product[];
  convenios: string[];
  
  // CRUD operations
  createProduct: (data: CreateProductData) => { success: boolean; productId?: string; error?: string };
  updateProduct: (productId: string, data: UpdateProductData) => { success: boolean; error?: string };
  toggleProductStatus: (productId: string) => { success: boolean; error?: string };
  deleteProduct: (productId: string) => { success: boolean; error?: string };
  
  // Convenio management
  addConvenio: (nome: string) => void;
  removeConvenio: (nome: string) => void;
  
  // Helpers
  getProductById: (productId: string) => Product | undefined;
  getActiveProducts: () => Product[];
}

interface ProductProviderProps {
  children: ReactNode;
  accountId: string;
}

// ============= CONTEXT =============

const ProductContext = createContext<ProductContextType | undefined>(undefined);

export function useProduct() {
  const context = useContext(ProductContext);
  if (context === undefined) {
    throw new Error('useProduct must be used within a ProductProvider');
  }
  return context;
}

// ============= PROVIDER =============

export function ProductProvider({ children, accountId }: ProductProviderProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  // Global convenios list for the account
  const [convenios, setConvenios] = useState<string[]>([
    'Unimed',
    'Bradesco Saúde',
    'Amil',
    'SulAmérica',
    'NotreDame Intermédica',
    'Hapvida',
    'Porto Seguro',
    'GEAP',
  ]);

  // Fetch products from API on mount
  useEffect(() => {
    if (!accountId || isLoaded) return;

    (async () => {
      try {
        const response = await productsService.list({ ativo: undefined });
        const items = Array.isArray(response) ? response : (response?.data || []);
        setProducts(items.map((p: any) => ({
          id: p.id,
          account_id: p.account_id || p.accountId || accountId,
          nome: p.nome,
          valor_padrao: Number(p.valor_padrao ?? p.valorPadrao ?? 0),
          ativo: p.ativo ?? true,
          metodos_pagamento: p.metodos_pagamento || p.metodosPagamento || ['pix'],
          convenios_aceitos: p.convenios_aceitos || p.conveniosAceitos || [],
          created_at: p.created_at || p.createdAt || new Date().toISOString(),
          updated_at: p.updated_at || p.updatedAt || new Date().toISOString(),
        })));
      } catch (err) {
        console.error('Error fetching products:', err);
      } finally {
        setIsLoaded(true);
      }
    })();
  }, [accountId, isLoaded]);

  // ============= CRUD OPERATIONS =============

  const createProduct = useCallback((data: CreateProductData) => {
    if (!data.nome.trim()) {
      return { success: false, error: 'Nome é obrigatório' };
    }
    if (data.valor_padrao <= 0) {
      return { success: false, error: 'Valor deve ser maior que zero' };
    }
    if (data.metodos_pagamento.length === 0) {
      return { success: false, error: 'Selecione ao menos um método de pagamento' };
    }

    const tempId = `prod-${Date.now()}`;
    const newProduct: Product = {
      id: tempId,
      account_id: accountId,
      nome: data.nome.trim(),
      valor_padrao: data.valor_padrao,
      metodos_pagamento: data.metodos_pagamento,
      convenios_aceitos: data.convenios_aceitos,
      ativo: data.ativo,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    setProducts((prev) => [...prev, newProduct]);

    // Persist to backend
    (async () => {
      try {
        const created = await productsService.create({
          nome: data.nome.trim(),
          valorPadrao: data.valor_padrao,
          metodosPagamento: data.metodos_pagamento,
          conveniosAceitos: data.convenios_aceitos,
        });
        // Update with real ID from backend
        setProducts((prev) => prev.map((p) => (p.id === tempId ? { ...newProduct, id: created.id || tempId } : p)));
      } catch (err: any) {
        console.error('Error creating product:', err);
        toast.error('Erro ao salvar produto no servidor');
      }
    })();

    return { success: true, productId: tempId };
  }, [accountId]);

  const updateProduct = useCallback((productId: string, data: UpdateProductData) => {
    const productIndex = products.findIndex((p) => p.id === productId);
    if (productIndex === -1) {
      return { success: false, error: 'Produto não encontrado' };
    }
    if (data.nome !== undefined && !data.nome.trim()) {
      return { success: false, error: 'Nome é obrigatório' };
    }
    if (data.valor_padrao !== undefined && data.valor_padrao <= 0) {
      return { success: false, error: 'Valor deve ser maior que zero' };
    }
    if (data.metodos_pagamento !== undefined && data.metodos_pagamento.length === 0) {
      return { success: false, error: 'Selecione ao menos um método de pagamento' };
    }

    setProducts((prev) =>
      prev.map((p) =>
        p.id === productId ? { ...p, ...data, nome: data.nome?.trim() ?? p.nome, updated_at: new Date().toISOString() } : p
      )
    );

    // Persist
    (async () => {
      try {
        await productsService.update(productId, {
          nome: data.nome,
          valorPadrao: data.valor_padrao,
          metodosPagamento: data.metodos_pagamento,
          conveniosAceitos: data.convenios_aceitos,
          ativo: data.ativo,
        });
      } catch (err: any) {
        console.error('Error updating product:', err);
        toast.error('Erro ao atualizar produto no servidor');
      }
    })();

    return { success: true };
  }, [products]);

  const toggleProductStatus = useCallback((productId: string) => {
    const product = products.find((p) => p.id === productId);
    if (!product) {
      return { success: false, error: 'Produto não encontrado' };
    }

    setProducts((prev) =>
      prev.map((p) => (p.id === productId ? { ...p, ativo: !p.ativo, updated_at: new Date().toISOString() } : p))
    );

    // Persist
    (async () => {
      try {
        await productsService.toggleStatus(productId);
      } catch (err: any) {
        console.error('Error toggling product:', err);
        toast.error('Erro ao alterar status do produto');
      }
    })();

    return { success: true };
  }, [products]);

  const deleteProduct = useCallback((productId: string) => {
    const product = products.find((p) => p.id === productId);
    if (!product) {
      return { success: false, error: 'Produto não encontrado' };
    }

    setProducts((prev) => prev.filter((p) => p.id !== productId));

    // Persist
    (async () => {
      try {
        await productsService.delete(productId);
      } catch (err: any) {
        console.error('Error deleting product:', err);
        toast.error('Erro ao excluir produto no servidor');
      }
    })();

    return { success: true };
  }, [products]);

  // ============= CONVENIO MANAGEMENT =============

  const addConvenio = useCallback((nome: string) => {
    const trimmedName = nome.trim();
    if (trimmedName && !convenios.includes(trimmedName)) {
      setConvenios((prev) => [...prev, trimmedName]);
    }
  }, [convenios]);

  const removeConvenio = useCallback((nome: string) => {
    setConvenios((prev) => prev.filter((c) => c !== nome));
  }, []);

  // ============= HELPERS =============

  const getProductById = useCallback(
    (productId: string) => products.find((p) => p.id === productId),
    [products]
  );

  const getActiveProducts = useCallback(
    () => products.filter((p) => p.ativo),
    [products]
  );

  // ============= CONTEXT VALUE =============

  const value = useMemo<ProductContextType>(
    () => ({
      products,
      convenios,
      createProduct,
      updateProduct,
      toggleProductStatus,
      deleteProduct,
      addConvenio,
      removeConvenio,
      getProductById,
      getActiveProducts,
    }),
    [products, convenios, createProduct, updateProduct, toggleProductStatus, deleteProduct, addConvenio, removeConvenio, getProductById, getActiveProducts]
  );

  return (
    <ProductContext.Provider value={value}>
      {children}
    </ProductContext.Provider>
  );
}
