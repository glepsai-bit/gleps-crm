import { createContext, useContext, useState, ReactNode, useCallback, useEffect, useRef } from 'react';
import { Contact, LeadFunnelState, Product, ContactOrigin, LeadNote } from '@/types/crm';
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

interface FinanceContextType {
  // State
  contacts: Contact[];
  products: Product[];
  leadFunnelStates: LeadFunnelState[];
  leadNotes: LeadNote[];
  isLoadingContacts: boolean;
  isSyncingContacts: boolean;
  lastContactsSync: string | null;
  newContactIds: Set<string>;
  
  // Actions
  createContact: (data: CreateContactData) => Promise<{ success: boolean; error?: string; contactId?: string }>;
  updateContact: (contactId: string, data: UpdateContactData) => { success: boolean; error?: string };
  deleteContact: (contactId: string) => { success: boolean; error?: string };
  updateLeadStage: (contactId: string, stageId: string) => void;
  addLeadNote: (contactId: string, content: string, authorId: string, authorName: string) => void;
  refetchContacts: () => Promise<void>;
  // Helpers
  getContactById: (id: string) => Contact | undefined;
  getContactNotes: (contactId: string) => LeadNote[];
  getContactFunnelStage: (contactId: string) => string | null;
  getContactFunnelStageOrder: (contactId: string) => number;
  getProductById: (id: string) => Product | undefined;
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
  // L-CROSS-2: aceita null durante hidratação do AuthContext. Quando null,
  // todos os useEffect já têm guard `if (!accountId) return` e nenhuma
  // query/mutação é disparada com accountId inválido.
  accountId: string | null;
}

export function FinanceProvider({ children, accountId }: FinanceProviderProps) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoadingContacts, setIsLoadingContacts] = useState(true);
  const [isSyncingContacts, setIsSyncingContacts] = useState(false);
  const [lastContactsSync, setLastContactsSync] = useState<string | null>(null);
  const [newContactIds, setNewContactIds] = useState<Set<string>>(new Set());
  
  const isFirstContactsLoad = useRef(true);
  
  const [leadFunnelStates, setLeadFunnelStates] = useState<LeadFunnelState[]>([]);

  const [leadNotes, setLeadNotes] = useState<LeadNote[]>([]);
  
  const [products, setProducts] = useState<Product[]>([]);

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

  // Fetch products on mount
  useEffect(() => {
    if (accountId) {
      fetchProductsFromDb();
    }
  }, [accountId, fetchProductsFromDb]);

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

  // Create contact
  const createContact = useCallback(
    async (data: CreateContactData): Promise<{ success: boolean; error?: string; contactId?: string }> => {
      // L-CROSS-2: bloqueia mutação enquanto accountId não está resolvido
      // (hidratação do AuthContext). Sem isso, contato seria persistido com
      // account_id=null e ficaria órfão (ou bateria em FK error no backend).
      if (!accountId) {
        return { success: false, error: 'Conta não disponível' };
      }
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

      setContacts((prev) => prev.filter((c) => c.id !== contactId));
      setLeadFunnelStates((prev) => prev.filter((lfs) => lfs.contact_id !== contactId));
      setLeadNotes((prev) => prev.filter((n) => n.contact_id !== contactId));

      return { success: true };
    },
    [contacts]
  );

  const value: FinanceContextType = {
    contacts,
    products,
    leadFunnelStates,
    leadNotes,
    isLoadingContacts,
    isSyncingContacts,
    lastContactsSync,
    newContactIds,
    createContact,
    updateContact,
    deleteContact,
    updateLeadStage,
    addLeadNote,
    refetchContacts: fetchContactsFromDb,
    getContactById,
    getContactNotes,
    getContactFunnelStage,
    getContactFunnelStageOrder,
    getProductById,
  };

  return (
    <FinanceContext.Provider value={value}>
      {children}
    </FinanceContext.Provider>
  );
}
