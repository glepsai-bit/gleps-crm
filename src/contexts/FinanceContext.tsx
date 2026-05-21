import { createContext, useContext, useState, useMemo, ReactNode, useCallback, useEffect, useRef } from 'react';
import { Sale, SaleItem, Contact, LeadFunnelState, SaleStatus, PaymentMethod, Product, ContactOrigin, LeadNote } from '@/types/crm';
import { useAuth } from '@/contexts/AuthContext';
import { useTagContext } from '@/contexts/TagContext';
import { useBackend } from '@/config/backend.config';
import { supabase } from '@/integrations/supabase/client';
import { financeBackendService } from '@/services/finance.backend.service';
import { contactsBackendService } from '@/services/contacts.backend.service';
import { contactsCloudService } from '@/services/contacts.cloud.service';
import { mergeContacts } from '@/utils/dataSync';
import { 
  mockLeadFunnelStates, 
  mockFunnelStages,
} from '@/data/mockData';

// Event types for finance
interface FinanceEvent {
  id: string;
  type: 'sale.created' | 'sale.paid' | 'sale.cancelled' | 'sale.refunded';
  saleId: string;
  actorId: string;
  actorName: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface CreateContactData {
  nome: string;
  telefone: string;
  email: string | null;
  origem: string;
}

interface UpdateContactData {
  nome?: string;
  telefone?: string;
  email?: string | null;
  origem?: ContactOrigin;
}

/** Item individual para criação de venda */
export interface CreateSaleItem {
  productId: string;
  quantidade: number;
  valorUnitario: number;
}

interface CreateSaleData {
  contactId: string;
  /** @deprecated Use items[] para múltiplos produtos */
  productId?: string;
  items: CreateSaleItem[];
  metodoPagamento: PaymentMethod;
  responsavelId: string;
  convenioNome?: string;
  /**
   * Usado apenas quando a venda é criada no mesmo fluxo do cadastro do contato.
   * Evita falha de validação por causa do setState assíncrono (contato/etapa ainda não refletem no contexto).
   */
  skipValidation?: boolean;
}

interface FinanceContextType {
  // State
  sales: Sale[];
  contacts: Contact[];
  products: Product[];
  leadFunnelStates: LeadFunnelState[];
  leadNotes: LeadNote[];
  events: FinanceEvent[];
  isLoadingContacts: boolean;
  isSyncingContacts: boolean;
  lastContactsSync: string | null;
  newContactIds: Set<string>;
  
  // Derived KPIs
  kpis: FinanceKPIs;
  
  // Actions
  createSale: (data: CreateSaleData) => { success: boolean; error?: string } | Promise<{ success: boolean; error?: string }>;
  createContact: (data: CreateContactData) => Promise<{ success: boolean; error?: string; contactId?: string }>;
  updateContact: (contactId: string, data: UpdateContactData) => { success: boolean; error?: string };
  deleteContact: (contactId: string) => { success: boolean; error?: string };
  updateLeadStage: (contactId: string, stageId: string) => void;
  addLeadNote: (contactId: string, content: string, authorId: string, authorName: string) => void;
  markAsPaid: (saleId: string) => void | Promise<void>;
  cancelSale: (saleId: string) => void;
  refundSale: (saleId: string, reason: string, password?: string) => void | Promise<void>;
  refundSaleItem: (saleId: string, itemId: string, reason: string, password?: string) => void | Promise<void>;
  updateSale: (saleId: string, data: Partial<Sale>) => { success: boolean; error?: string };
  refetchContacts: () => Promise<void>;
  // Helpers
  getContactById: (id: string) => Contact | undefined;
  getContactSales: (contactId: string) => Sale[];
  getContactNotes: (contactId: string) => LeadNote[];
  getContactFunnelStage: (contactId: string) => string | null;
  getContactFunnelStageOrder: (contactId: string) => number;
  getProductById: (id: string) => Product | undefined;
  canCreateSale: (contactId: string) => { allowed: boolean; reason?: string };
  checkIsRecurringSale: (contactId: string, productId: string) => boolean;
}

interface FinanceKPIs {
  faturamentoBruto: number;
  ticketMedio: number;
  totalVendas: number;
  vendasPagas: { count: number; valor: number };
  vendasPendentes: { count: number; valor: number };
  vendasCanceladas: { count: number; valor: number };
  vendasEstornadas: { count: number; valor: number };
  porMetodoPagamento: { method: PaymentMethod | 'none'; count: number; valor: number }[];
  leadsConvertidos: number;
  vendasCriadas: number;
  vendasPagasCount: number;
  faturamentoPorDia: { date: string; valor: number }[];
}

const FinanceContext = createContext<FinanceContextType | null>(null);

export function useFinance() {
  const context = useContext(FinanceContext);
  if (!context) {
    throw new Error('useFinance must be used within a FinanceProvider');
  }
  return context;
}

interface FinanceProviderProps {
  children: ReactNode;
  accountId: string;
}

export function FinanceProvider({ children, accountId }: FinanceProviderProps) {
  const { user } = useAuth();
  let tagContext: ReturnType<typeof useTagContext> | null = null;
  try {
    tagContext = useTagContext();
  } catch {
    // TagContext may not be available in all contexts
  }
  
  const [sales, setSales] = useState<Sale[]>([]);
  
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoadingContacts, setIsLoadingContacts] = useState(true);
  const [isSyncingContacts, setIsSyncingContacts] = useState(false);
  const [lastContactsSync, setLastContactsSync] = useState<string | null>(null);
  const [newContactIds, setNewContactIds] = useState<Set<string>>(new Set());
  
  const isFirstContactsLoad = useRef(true);
  
  const [leadFunnelStates, setLeadFunnelStates] = useState<LeadFunnelState[]>([]);

  const [leadNotes, setLeadNotes] = useState<LeadNote[]>([]);
  
  const [events, setEvents] = useState<FinanceEvent[]>([]);
  
  const [products, setProducts] = useState<Product[]>([]);

  // Fetch sales from database
  const fetchSalesFromDb = useCallback(async () => {
    if (!accountId) return;
    try {
      if (useBackend) {
        const mapped = await financeBackendService.fetchSales(accountId);
        setSales(mapped);
        return;
      }

      const { data, error } = await supabase
        .from('sales')
        .select('*, sale_items:sale_items(id, product_id, quantidade, valor_unitario, valor_total, refunded, refunded_at, refund_reason)')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching sales:', error);
        return;
      }

      const mapped: Sale[] = (data || []).map((s: any) => ({
        id: s.id,
        account_id: s.account_id,
        contact_id: s.contact_id,
        items: (s.sale_items || []).map((i: any) => ({
          id: i.id,
          product_id: i.product_id,
          quantidade: i.quantidade || 1,
          valor_unitario: Number(i.valor_unitario),
          valor_total: Number(i.valor_total),
          refunded: i.refunded,
          refunded_at: i.refunded_at,
          refund_reason: i.refund_reason,
        })),
        valor: Number(s.valor),
        status: s.status,
        metodo_pagamento: s.metodo_pagamento,
        convenio_nome: s.convenio_nome,
        responsavel_id: s.responsavel_id,
        is_recurring: s.is_recurring,
        created_at: s.created_at,
        paid_at: s.paid_at,
        refunded_at: s.refunded_at,
      }));

      setSales(mapped);
    } catch (err) {
      console.error('Error fetching sales:', err);
    }
  }, [accountId]);

  // Fetch products from database
  const fetchProductsFromDb = useCallback(async () => {
    if (!accountId) return;
    try {
      if (useBackend) {
        const mapped = await financeBackendService.fetchProducts(accountId);
        setProducts(mapped);
        return;
      }

      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('account_id', accountId)
        .eq('ativo', true)
        .order('nome');

      if (error) {
        console.error('Error fetching products:', error);
        return;
      }

      const mapped: Product[] = (data || []).map((p: any) => ({
        id: p.id,
        account_id: p.account_id,
        nome: p.nome,
        valor_padrao: Number(p.valor_padrao),
        ativo: p.ativo,
        metodos_pagamento: p.metodos_pagamento || ['pix'],
        convenios_aceitos: p.convenios_aceitos || [],
        created_at: p.created_at,
        updated_at: p.updated_at,
      }));

      setProducts(mapped);
    } catch (err) {
      console.error('Error fetching products:', err);
    }
  }, [accountId]);

  // Fetch sales and products on mount
  useEffect(() => {
    if (accountId) {
      fetchSalesFromDb();
      fetchProductsFromDb();
    }
  }, [accountId, fetchSalesFromDb, fetchProductsFromDb]);

  // Clear new contact animation after delay
  const clearNewContactIds = useCallback((ids: string[]) => {
    setTimeout(() => {
      setNewContactIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    }, 2000); // Animation duration
  }, []);

  // Fetch contacts from Supabase with merge strategy
  const fetchContactsFromDb = useCallback(async () => {
    if (isFirstContactsLoad.current) {
      setIsLoadingContacts(true);
    } else {
      setIsSyncingContacts(true);
    }
    
    try {
      let incoming: Contact[];

      if (useBackend) {
        incoming = await financeBackendService.fetchContacts(accountId);
      } else {
        const { data, error } = await supabase
          .from('contacts')
          .select('*')
          .eq('account_id', accountId)
          .order('created_at', { ascending: false });

        if (error) {
          console.error('Error fetching contacts:', error);
          return;
        }

        incoming = (data || []) as Contact[];
      }
      
      setContacts(current => {
        if (current.length === 0 || isFirstContactsLoad.current) {
          return incoming;
        }

        const result = mergeContacts(current, incoming);
        
        if (result.added.length > 0) {
          setNewContactIds(prev => new Set([...prev, ...result.added]));
          clearNewContactIds(result.added);
        }

        return result.data;
      });
      
      setLastContactsSync(new Date().toISOString());
      isFirstContactsLoad.current = false;
    } catch (err) {
      console.error('Error fetching contacts:', err);
    } finally {
      setIsLoadingContacts(false);
      setIsSyncingContacts(false);
    }
  }, [accountId, clearNewContactIds]);

  // Fetch contacts on mount and when accountId changes
  useEffect(() => {
    if (accountId) {
      fetchContactsFromDb();
    }
  }, [accountId, fetchContactsFromDb]);

  // Helper functions
  const getContactById = useCallback(
    (id: string) => contacts.find((c) => c.id === id),
    [contacts]
  );

  const getProductById = useCallback(
    (id: string) => products.find((p) => p.id === id),
    [products]
  );

  const getContactSales = useCallback(
    (contactId: string) => sales.filter((s) => s.contact_id === contactId),
    [sales]
  );

  const getContactNotes = useCallback(
    (contactId: string) => leadNotes.filter((n) => n.contact_id === contactId).sort((a, b) => 
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    ),
    [leadNotes]
  );

  const getContactFunnelStage = useCallback(
    (contactId: string) => {
      const state = leadFunnelStates.find((lfs) => lfs.contact_id === contactId);
      if (!state?.funnel_stage_id) return null;
      const stage = mockFunnelStages.find((s) => s.id === state.funnel_stage_id);
      return stage?.nome || null;
    },
    [leadFunnelStates]
  );

  const getContactFunnelStageOrder = useCallback(
    (contactId: string): number => {
      const state = leadFunnelStates.find((lfs) => lfs.contact_id === contactId);
      if (!state?.funnel_stage_id) return 0;
      const stage = mockFunnelStages.find((s) => s.id === state.funnel_stage_id);
      return stage?.ordem || 0;
    },
    [leadFunnelStates]
  );

  // Check if sale is recurring (same product purchased before)
  const checkIsRecurringSale = useCallback(
    (contactId: string, productId: string): boolean => {
      const previousSales = sales.filter(
        (s) => s.contact_id === contactId && s.product_id === productId
      );
      return previousSales.length > 0;
    },
    [sales]
  );

  // Update lead stage (for Kanban sync)
  const updateLeadStage = useCallback(
    (contactId: string, stageId: string) => {
      setLeadFunnelStates((prev) => {
        const existing = prev.find((lfs) => lfs.contact_id === contactId);
        if (existing) {
          return prev.map((lfs) =>
            lfs.contact_id === contactId
              ? { ...lfs, funnel_stage_id: stageId, updated_at: new Date().toISOString() }
              : lfs
          );
        }
        return [
          ...prev,
          {
            contact_id: contactId,
            funnel_stage_id: stageId,
            updated_at: new Date().toISOString(),
          },
        ];
      });
    },
    []
  );

  // Add lead note
  const addLeadNote = useCallback(
    (contactId: string, content: string, authorId: string, authorName: string) => {
      const newNote: LeadNote = {
        id: `note-${Date.now()}`,
        contact_id: contactId,
        author_id: authorId,
        author_name: authorName,
        content,
        created_at: new Date().toISOString(),
      };
      setLeadNotes((prev) => [newNote, ...prev]);
    },
    []
  );

  // Vendas podem ser criadas em QUALQUER etapa do Kanban
  // A validação de etapa avançada foi removida conforme regra de negócio
  const canCreateSale = useCallback(
    (contactId: string): { allowed: boolean; reason?: string } => {
      const contact = getContactById(contactId);
      if (!contact) {
        return { allowed: false, reason: 'Contato não encontrado' };
      }

      // Vendas permitidas em qualquer etapa do funil
      return { allowed: true };
    },
    [getContactById]
  );

  // Create contact
  const createContact = useCallback(
    async (data: CreateContactData): Promise<{ success: boolean; error?: string; contactId?: string }> => {
      try {
        const origemNormalizada: ContactOrigin =
          data.origem === 'whatsapp' ||
          data.origem === 'instagram' ||
          data.origem === 'site' ||
          data.origem === 'indicacao' ||
          data.origem === 'outro'
            ? data.origem
            : 'outro';

        const payload = {
          account_id: accountId,
          nome: data.nome,
          telefone: data.telefone,
          email: data.email || undefined,
          origem: origemNormalizada,
        };

        const result = useBackend
          ? await contactsBackendService.createContact(payload)
          : await contactsCloudService.createContact(payload);

        if (!result.success || !result.contact_id) {
          return { success: false, error: result.error || 'Erro ao criar contato' };
        }

        const now = new Date().toISOString();
        const createdContact: Contact = {
          id: result.contact_id,
          account_id: accountId,
          nome: data.nome,
          telefone: data.telefone,
          email: data.email,
          origem: origemNormalizada,
          chatwoot_contact_id: result.chatwoot_contact_id ?? null,
          chatwoot_conversation_id: result.chatwoot_conversation_id ?? null,
          created_at: now,
          updated_at: now,
        };

        setContacts((prev) => [createdContact, ...prev.filter((c) => c.id !== createdContact.id)]);

        return { success: true, contactId: result.contact_id };
      } catch (err: any) {
        console.error('Error creating contact:', err);
        return { success: false, error: err?.message || 'Erro ao criar contato' };
      }
    },
    [accountId]
  );

  // Update contact
  const updateContact = useCallback(
    (contactId: string, data: UpdateContactData): { success: boolean; error?: string } => {
      const contact = contacts.find((c) => c.id === contactId);
      if (!contact) {
        return { success: false, error: 'Contato não encontrado' };
      }

      setContacts((prev) =>
        prev.map((c) =>
          c.id === contactId
            ? {
                ...c,
                ...data,
                updated_at: new Date().toISOString(),
              }
            : c
        )
      );

      return { success: true };
    },
    [contacts]
  );

  // Delete contact
  const deleteContact = useCallback(
    (contactId: string): { success: boolean; error?: string } => {
      const contact = contacts.find((c) => c.id === contactId);
      if (!contact) {
        return { success: false, error: 'Contato não encontrado' };
      }

      // Check if contact has sales
      const contactSales = sales.filter((s) => s.contact_id === contactId);
      if (contactSales.length > 0) {
        return { success: false, error: 'Não é possível remover lead com vendas registradas' };
      }

      setContacts((prev) => prev.filter((c) => c.id !== contactId));
      setLeadFunnelStates((prev) => prev.filter((lfs) => lfs.contact_id !== contactId));
      setLeadNotes((prev) => prev.filter((n) => n.contact_id !== contactId));

      return { success: true };
    },
    [contacts, sales]
  );

  // Create event helper with actor tracking
  const createEvent = useCallback((type: FinanceEvent['type'], saleId: string, payload: Record<string, unknown>) => {
    const event: FinanceEvent = {
      id: `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      saleId,
      actorId: user?.id || 'unknown',
      actorName: user?.nome || 'Usuário',
      payload,
      createdAt: new Date().toISOString(),
    };
    setEvents((prev) => [event, ...prev]);
    return event;
  }, [user]);

  // Actions
  const createSale = useCallback(
    async (data: CreateSaleData): Promise<{ success: boolean; error?: string }> => {
      if (!data.skipValidation) {
        const validation = canCreateSale(data.contactId);
        if (!validation.allowed) {
          return { success: false, error: validation.reason };
        }
      }

      if (useBackend) {
        try {
          await financeBackendService.createSale({
            contactId: data.contactId,
            items: data.items.map(item => ({
              productId: item.productId,
              quantidade: item.quantidade,
              valorUnitario: item.valorUnitario,
            })),
            metodoPagamento: data.metodoPagamento,
            responsavelId: data.responsavelId,
            convenioNome: data.convenioNome,
          });
          await fetchSalesFromDb();
          return { success: true };
        } catch (err: any) {
          console.error('Error creating sale via backend:', err);
          return { success: false, error: err?.response?.data?.message || 'Erro ao criar venda' };
        }
      }

      // Supabase Cloud mode: persist sale + sale items
      const saleItems: SaleItem[] = data.items.map((item, index) => ({
        id: `item-${Date.now()}-${index}`,
        product_id: item.productId,
        quantidade: item.quantidade,
        valor_unitario: item.valorUnitario,
        valor_total: item.quantidade * item.valorUnitario,
      }));

      const valorTotal = saleItems.reduce((sum, item) => sum + item.valor_total, 0);
      const isRecurring = data.items.some((item) => checkIsRecurringSale(data.contactId, item.productId));

      const { data: createdSale, error: saleError } = await supabase
        .from('sales')
        .insert({
          account_id: accountId,
          contact_id: data.contactId,
          valor: valorTotal,
          metodo_pagamento: data.metodoPagamento,
          convenio_nome: data.convenioNome ?? null,
          responsavel_id: data.responsavelId,
          is_recurring: isRecurring,
        })
        .select('id')
        .single();

      if (saleError || !createdSale) {
        console.error('Error creating sale in cloud mode:', saleError);
        return { success: false, error: saleError?.message || 'Erro ao criar venda' };
      }

      const { error: itemsError } = await supabase.from('sale_items').insert(
        saleItems.map((item) => ({
          sale_id: createdSale.id,
          product_id: item.product_id,
          quantidade: item.quantidade,
          valor_unitario: item.valor_unitario,
          valor_total: item.valor_total,
        }))
      );

      if (itemsError) {
        console.error('Error creating sale items in cloud mode:', itemsError);
        await supabase.from('sales').delete().eq('id', createdSale.id);
        return { success: false, error: itemsError.message || 'Erro ao criar itens da venda' };
      }

      await fetchSalesFromDb();
      createEvent('sale.created', createdSale.id, {
        contactId: data.contactId,
        valor: valorTotal,
        itemsCount: saleItems.length,
        isRecurring,
      });

      return { success: true };
    },
    [accountId, canCreateSale, checkIsRecurringSale, createEvent, fetchSalesFromDb]
  );

  const markAsPaid = useCallback(
    async (saleId: string) => {
      if (useBackend) {
        try {
          await financeBackendService.markAsPaid(saleId);
          await fetchSalesFromDb();
          return;
        } catch (err) {
          console.error('Error marking sale as paid via backend:', err);
          throw err;
        }
      }
      setSales((prev) =>
        prev.map((s) =>
          s.id === saleId
            ? { ...s, status: 'paid' as SaleStatus, paid_at: new Date().toISOString() }
            : s
        )
      );
      createEvent('sale.paid', saleId, { paid_at: new Date().toISOString() });
    },
    [createEvent, fetchSalesFromDb]
  );

  const cancelSale = useCallback(
    (saleId: string) => {
      setSales((prev) =>
        prev.map((s) =>
          s.id === saleId
            ? { ...s, status: 'cancelled' as SaleStatus, cancelled_at: new Date().toISOString() }
            : s
        )
      );
      createEvent('sale.cancelled', saleId, { cancelled_at: new Date().toISOString() });
    },
    [createEvent]
  );

  const refundSale = useCallback(
    async (saleId: string, reason: string, password?: string) => {
      if (useBackend) {
        try {
          await financeBackendService.refundSale(saleId, reason, password);
          await fetchSalesFromDb();
          return;
        } catch (err) {
          console.error('Error refunding sale via backend:', err);
          throw err;
        }
      }
      setSales((prev) =>
        prev.map((s) =>
          s.id === saleId
            ? { ...s, status: 'refunded' as SaleStatus, refunded_at: new Date().toISOString() }
            : s
        )
      );
      createEvent('sale.refunded', saleId, { reason, refunded_at: new Date().toISOString() });
    },
    [createEvent, fetchSalesFromDb]
  );

  const refundSaleItem = useCallback(
    async (saleId: string, itemId: string, reason: string, password?: string) => {
      if (useBackend) {
        try {
          await financeBackendService.refundSaleItem(saleId, itemId, reason, password);
          await fetchSalesFromDb();
          return;
        } catch (err) {
          console.error('Error refunding sale item via backend:', err);
          throw err;
        }
      }
      setSales((prev) =>
        prev.map((s) => {
          if (s.id !== saleId) return s;

          const updatedItems = s.items.map((item) =>
            item.id === itemId
              ? { ...item, refunded: true, refunded_at: new Date().toISOString(), refund_reason: reason }
              : item
          );

          const activeItems = updatedItems.filter((item) => !item.refunded);
          const newTotal = activeItems.reduce((sum, item) => sum + item.valor_total, 0);
          const allRefunded = updatedItems.every((item) => item.refunded);

          return {
            ...s,
            items: updatedItems,
            valor: newTotal,
            status: allRefunded ? ('refunded' as SaleStatus) : s.status,
            refunded_at: allRefunded ? new Date().toISOString() : s.refunded_at,
          };
        })
      );
      createEvent('sale.refunded', saleId, { itemId, reason, refunded_at: new Date().toISOString() });
    },
    [createEvent, fetchSalesFromDb]
  );

  const updateSale = useCallback(
    (saleId: string, data: Partial<Sale>): { success: boolean; error?: string } => {
      const sale = sales.find((s) => s.id === saleId);
      if (!sale) {
        return { success: false, error: 'Venda não encontrada' };
      }

      setSales((prev) =>
        prev.map((s) =>
          s.id === saleId
            ? { ...s, ...data }
            : s
        )
      );

      return { success: true };
    },
    [sales]
  );

  // Derived KPIs - computed from state
  const kpis = useMemo((): FinanceKPIs => {
    const paidSales = sales.filter((s) => s.status === 'paid');
    const pendingSales = sales.filter((s) => s.status === 'pending');
    const refundedSales = sales.filter((s) => s.status === 'refunded');

    const faturamentoBruto = paidSales.reduce((sum, s) => sum + s.valor, 0);
    const ticketMedio = paidSales.length > 0 ? faturamentoBruto / paidSales.length : 0;

    // By payment method
    const methodsMap = new Map<PaymentMethod | 'none', { count: number; valor: number }>();
    paidSales.forEach((s) => {
      const method = s.metodo_pagamento || 'none';
      const current = methodsMap.get(method) || { count: 0, valor: 0 };
      methodsMap.set(method, { count: current.count + 1, valor: current.valor + s.valor });
    });
    const porMetodoPagamento = Array.from(methodsMap.entries()).map(([method, data]) => ({
      method,
      ...data,
    }));

    // Funnel conversion - use finalStageIds from TagContext if available
    let convertedStageIds: string[];
    if (tagContext?.finalStageIds && tagContext.finalStageIds.length > 0) {
      convertedStageIds = tagContext.finalStageIds;
    } else {
      // Fallback to default behavior
      convertedStageIds = mockFunnelStages
        .filter((s) => s.ordem >= 4)
        .map((s) => s.id);
    }
    
    // Match leads that have a stage tag that is in finalStageIds
    const leadsConvertidos = tagContext?.leadTags 
      ? tagContext.leadTags.filter((lt) => convertedStageIds.includes(lt.tag_id)).length
      : leadFunnelStates.filter((lfs) =>
          lfs.funnel_stage_id && convertedStageIds.includes(lfs.funnel_stage_id)
        ).length;

    // Revenue by day (last 7 days)
    const today = new Date();
    const faturamentoPorDia: { date: string; valor: number }[] = [];
    
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      const dayRevenue = paidSales
        .filter((s) => s.paid_at && s.paid_at.startsWith(dateStr))
        .reduce((sum, s) => sum + s.valor, 0);
      
      faturamentoPorDia.push({
        date: date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        valor: dayRevenue,
      });
    }

    return {
      faturamentoBruto,
      ticketMedio,
      totalVendas: sales.length,
      vendasPagas: {
        count: paidSales.length,
        valor: faturamentoBruto,
      },
      vendasPendentes: {
        count: pendingSales.length,
        valor: pendingSales.reduce((sum, s) => sum + s.valor, 0),
      },
      vendasCanceladas: {
        count: 0,
        valor: 0,
      },
      vendasEstornadas: {
        count: refundedSales.length,
        valor: refundedSales.reduce((sum, s) => sum + s.valor, 0),
      },
      porMetodoPagamento,
      leadsConvertidos,
      vendasCriadas: sales.length,
      vendasPagasCount: paidSales.length,
      faturamentoPorDia,
    };
  }, [sales, leadFunnelStates, tagContext?.finalStageIds, tagContext?.leadTags]);

  const value: FinanceContextType = {
    sales,
    contacts,
    products,
    leadFunnelStates,
    leadNotes,
    events,
    isLoadingContacts,
    isSyncingContacts,
    lastContactsSync,
    newContactIds,
    kpis,
    createSale,
    createContact,
    updateContact,
    deleteContact,
    updateLeadStage,
    addLeadNote,
    markAsPaid,
    cancelSale,
    refundSale,
    refundSaleItem,
    updateSale,
    refetchContacts: fetchContactsFromDb,
    getContactById,
    getContactSales,
    getContactNotes,
    getContactFunnelStage,
    getContactFunnelStageOrder,
    getProductById,
    canCreateSale,
    checkIsRecurringSale,
  };

  return (
    <FinanceContext.Provider value={value}>
      {children}
    </FinanceContext.Provider>
  );
}
