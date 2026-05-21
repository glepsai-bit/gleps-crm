import React, { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Tag, LeadTag, TagHistory, ActorType } from '@/types/crm';
import { mockTags, mockLeadTags, mockTagHistory, mockFunnels } from '@/data/mockData';
import { useBackend } from '@/config/backend.config';
import { tagsBackendService } from '@/services/tags.backend.service';
import { apiClient } from '@/api/client';

// ============= TYPES =============

interface AddTagData {
  contactId: string;
  tagId: string;
  source: 'kanban' | 'chatwoot' | 'system';
  actorType: ActorType;
  actorId: string | null;
}

interface RemoveTagData {
  contactId: string;
  tagId: string;
  source: 'kanban' | 'chatwoot' | 'system';
  actorType: ActorType;
  actorId: string | null;
  reason?: string;
}

interface ApplyStageTagData {
  contactId: string;
  tagId: string; // ID da tag de stage
  source: 'kanban' | 'chatwoot' | 'system';
  actorType: ActorType;
  actorId: string | null;
}

interface CreateStageTagData {
  name: string;
  slug: string;
  color: string;
  source: 'kanban' | 'chatwoot' | 'system';
}

// Configuração de etapas para cada parte do funil
interface FunnelStageConfig {
  leadsConvertidos: string[];  // Etapas que contam como "leads convertidos"
  vendasCriadas: string[];     // Etapas que contam como "vendas criadas" (derivado de vendas, não usado aqui)
  vendasPagas: string[];       // Etapas que contam como "vendas pagas" (derivado de vendas, não usado aqui)
}

interface TagContextType {
  // State
  tags: Tag[];
  stageTags: Tag[]; // Apenas tags de etapa (colunas do Kanban)
  operationalTags: Tag[]; // Apenas tags operacionais
  leadTags: LeadTag[];
  tagHistory: TagHistory[];
  finalStageIds: string[]; // IDs das etapas consideradas finais para o funil (leadsConvertidos)
  funnelStageConfig: FunnelStageConfig;

  // Queries
  getTagById: (tagId: string) => Tag | undefined;
  getTagBySlug: (slug: string) => Tag | undefined;
  getLeadTags: (contactId: string) => Tag[];
  getLeadStageTag: (contactId: string) => Tag | undefined; // Retorna A tag de etapa do lead
  getLeadOperationalTags: (contactId: string) => Tag[];
  getContactTagHistory: (contactId: string) => TagHistory[];
  hasTag: (contactId: string, tagId: string) => boolean;
  isFinalStage: (stageId: string) => boolean;

  // Actions
  addTag: (data: AddTagData) => { success: boolean; error?: string };
  removeTag: (data: RemoveTagData) => { success: boolean; error?: string };
  toggleOperationalTag: (data: AddTagData) => { success: boolean; added: boolean; error?: string };
  applyStageTag: (data: ApplyStageTagData) => { success: boolean; error?: string };
  createStageTag: (data: CreateStageTagData) => { success: boolean; tagId?: string; error?: string };
  
  // Stage Management (Kanban columns)
  moveStageTag: (tagId: string, direction: 'left' | 'right') => { success: boolean; error?: string };
  deleteStageTag: (tagId: string) => { success: boolean; error?: string };
  toggleFinalStage: (stageId: string) => void;
  updateFunnelStageConfig: (config: Partial<FunnelStageConfig>) => void;
  
  // Chatwoot sync simulation
  simulateChatwootTagApplied: (contactId: string, tagSlug: string) => void;
}

// ============= CONTEXT =============

const TagContext = createContext<TagContextType | undefined>(undefined);

export const useTagContext = () => {
  const context = useContext(TagContext);
  if (!context) {
    throw new Error('useTagContext must be used within a TagProvider');
  }
  return context;
};

// ============= PROVIDER =============

interface TagProviderProps {
  children: React.ReactNode;
  accountId: string;
}

export const TagProvider: React.FC<TagProviderProps> = ({ children, accountId }) => {
  // State filtered by account
  const [tags, setTags] = useState<Tag[]>(
    useBackend ? [] : mockTags.filter((t) => t.account_id === accountId && t.ativo)
  );
  const [leadTags, setLeadTags] = useState<LeadTag[]>(useBackend ? [] : mockLeadTags);
  const [tagHistory, setTagHistory] = useState<TagHistory[]>(useBackend ? [] : mockTagHistory);
  const configInitialized = useRef(false);
  
  // Fetch tags and lead_tags from backend
  useEffect(() => {
    if (!useBackend || !accountId) return;
    tagsBackendService.listAllTags(accountId).then((backendTags) => {
      setTags(backendTags);
    }).catch(console.error);

    // Fetch lead_tags for KPI calculations (funnel conversion)
    apiClient.get<any>('/api/lead-tags', { params: { accountId } })
      .then((response: any) => {
        const data = Array.isArray(response) ? response : (response?.data || []);
        setLeadTags(data);
      })
      .catch(console.error);
  }, [accountId]);
  
  // Final stages for funnel conversion - recalculate when tags load
  const [funnelStageConfig, setFunnelStageConfig] = useState<FunnelStageConfig>({
    leadsConvertidos: [],
    vendasCriadas: [],
    vendasPagas: [],
  });

  // Set default final stages when tags are loaded
  useEffect(() => {
    if (configInitialized.current) return;
    const stageTagsList = tags.filter(t => t.type === 'stage');
    if (stageTagsList.length === 0) return;
    const sortedByOrder = [...stageTagsList].sort((a, b) => b.ordem - a.ordem);
    const defaultFinalStages = sortedByOrder.slice(0, 2).map((t) => t.id);
    setFunnelStageConfig(prev => ({
      ...prev,
      leadsConvertidos: defaultFinalStages,
    }));
    configInitialized.current = true;
  }, [tags]);
  
  // Backwards compatibility alias
  const finalStageIds = funnelStageConfig.leadsConvertidos;

  // ============= DERIVED STATE =============
  
  // Tags de etapa = colunas do Kanban
  const stageTags = useMemo(() => 
    tags.filter((t) => t.type === 'stage').sort((a, b) => a.ordem - b.ordem),
    [tags]
  );

  // Tags operacionais = complementares
  const operationalTags = useMemo(() => 
    tags.filter((t) => t.type === 'operational'),
    [tags]
  );

  // ============= QUERIES =============

  const getTagById = useCallback((tagId: string): Tag | undefined => {
    return tags.find((t) => t.id === tagId);
  }, [tags]);

  const getTagBySlug = useCallback((slug: string): Tag | undefined => {
    return tags.find((t) => t.slug === slug.toLowerCase());
  }, [tags]);

  const getLeadTags = useCallback((contactId: string): Tag[] => {
    const contactTagIds = leadTags
      .filter((lt) => lt.contact_id === contactId)
      .map((lt) => lt.tag_id);
    return tags.filter((t) => contactTagIds.includes(t.id));
  }, [leadTags, tags]);

  const getLeadStageTag = useCallback((contactId: string): Tag | undefined => {
    const contactTagIds = leadTags
      .filter((lt) => lt.contact_id === contactId)
      .map((lt) => lt.tag_id);
    return tags.find((t) => contactTagIds.includes(t.id) && t.type === 'stage');
  }, [leadTags, tags]);

  const getLeadOperationalTags = useCallback((contactId: string): Tag[] => {
    return getLeadTags(contactId).filter((t) => t.type === 'operational');
  }, [getLeadTags]);

  const getContactTagHistory = useCallback((contactId: string): TagHistory[] => {
    return tagHistory
      .filter((th) => th.contact_id === contactId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [tagHistory]);

  const hasTag = useCallback((contactId: string, tagId: string): boolean => {
    return leadTags.some((lt) => lt.contact_id === contactId && lt.tag_id === tagId);
  }, [leadTags]);

  const isFinalStage = useCallback((stageId: string): boolean => {
    return finalStageIds.includes(stageId);
  }, [finalStageIds]);

  const toggleFinalStage = useCallback((stageId: string) => {
    setFunnelStageConfig((prev) => {
      const currentIds = prev.leadsConvertidos;
      if (currentIds.includes(stageId)) {
        return { ...prev, leadsConvertidos: currentIds.filter((id) => id !== stageId) };
      }
      return { ...prev, leadsConvertidos: [...currentIds, stageId] };
    });
  }, []);

  const updateFunnelStageConfig = useCallback((config: Partial<FunnelStageConfig>) => {
    setFunnelStageConfig((prev) => ({ ...prev, ...config }));
  }, []);

  // ============= ACTIONS =============

  const addHistoryEntry = useCallback((
    contactId: string,
    tagId: string,
    action: 'added' | 'removed' | 'tag_created',
    actorType: ActorType,
    actorId: string | null,
    source: 'kanban' | 'chatwoot' | 'system',
    reason: string | null
  ) => {
    const newEntry: TagHistory = {
      id: `th-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      contact_id: contactId,
      tag_id: tagId,
      action,
      actor_type: actorType,
      actor_id: actorId,
      source,
      reason,
      created_at: new Date().toISOString(),
    };
    setTagHistory((prev) => [newEntry, ...prev]);
  }, []);

  const addTag = useCallback((data: AddTagData): { success: boolean; error?: string } => {
    const { contactId, tagId, source, actorType, actorId } = data;

    // Validate tag exists
    const tag = getTagById(tagId);
    if (!tag) {
      return { success: false, error: 'Tag não encontrada' };
    }

    // Check if already has this tag
    if (hasTag(contactId, tagId)) {
      return { success: false, error: 'Lead já possui esta tag' };
    }

    // If stage tag, need to remove other stage tags first (exclusiva)
    if (tag.type === 'stage') {
      const currentStageTag = getLeadStageTag(contactId);
      if (currentStageTag) {
        // Remove the current stage tag
        setLeadTags((prev) => prev.filter((lt) => !(lt.contact_id === contactId && lt.tag_id === currentStageTag.id)));
        addHistoryEntry(contactId, currentStageTag.id, 'removed', actorType, actorId, source, `Substituída por ${tag.name}`);
      }
    }

    // Add the new tag
    const newLeadTag: LeadTag = {
      id: `lt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      contact_id: contactId,
      tag_id: tagId,
      applied_by_type: actorType,
      applied_by_id: actorId,
      source,
      created_at: new Date().toISOString(),
    };

    setLeadTags((prev) => [...prev, newLeadTag]);
    addHistoryEntry(contactId, tagId, 'added', actorType, actorId, source, null);

    return { success: true };
  }, [getTagById, hasTag, getLeadStageTag, addHistoryEntry]);

  const removeTag = useCallback((data: RemoveTagData): { success: boolean; error?: string } => {
    const { contactId, tagId, source, actorType, actorId, reason } = data;

    if (!hasTag(contactId, tagId)) {
      return { success: false, error: 'Lead não possui esta tag' };
    }

    setLeadTags((prev) => prev.filter((lt) => !(lt.contact_id === contactId && lt.tag_id === tagId)));
    addHistoryEntry(contactId, tagId, 'removed', actorType, actorId, source, reason || null);

    return { success: true };
  }, [hasTag, addHistoryEntry]);

  const toggleOperationalTag = useCallback((data: AddTagData): { success: boolean; added: boolean; error?: string } => {
    const tag = getTagById(data.tagId);
    if (!tag || tag.type !== 'operational') {
      return { success: false, added: false, error: 'Tag operacional não encontrada' };
    }

    if (hasTag(data.contactId, data.tagId)) {
      const result = removeTag({
        ...data,
        reason: 'Toggle desativado',
      });
      return { ...result, added: false };
    } else {
      const result = addTag(data);
      return { ...result, added: true };
    }
  }, [getTagById, hasTag, addTag, removeTag]);

  const applyStageTag = useCallback((data: ApplyStageTagData): { success: boolean; error?: string } => {
    const { contactId, tagId, source, actorType, actorId } = data;

    // Find the stage tag
    const stageTag = getTagById(tagId);
    if (!stageTag || stageTag.type !== 'stage') {
      return { success: false, error: 'Tag de etapa não encontrada' };
    }

    // Remove current stage tag if exists
    const currentStageTag = getLeadStageTag(contactId);
    if (currentStageTag && currentStageTag.id !== tagId) {
      setLeadTags((prev) => prev.filter((lt) => !(lt.contact_id === contactId && lt.tag_id === currentStageTag.id)));
      addHistoryEntry(contactId, currentStageTag.id, 'removed', actorType, actorId, source, `Lead movido para ${stageTag.name}`);
    }

    // If already has this tag, no-op
    if (hasTag(contactId, tagId)) {
      return { success: true };
    }

    // Add new stage tag
    const newLeadTag: LeadTag = {
      id: `lt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      contact_id: contactId,
      tag_id: tagId,
      applied_by_type: actorType,
      applied_by_id: actorId,
      source,
      created_at: new Date().toISOString(),
    };

    setLeadTags((prev) => [...prev, newLeadTag]);
    addHistoryEntry(contactId, tagId, 'added', actorType, actorId, source, null);

    return { success: true };
  }, [getTagById, getLeadStageTag, hasTag, addHistoryEntry]);

  // Criar nova tag de etapa (também cria coluna no Kanban)
  const createStageTag = useCallback((data: CreateStageTagData): { success: boolean; tagId?: string; error?: string } => {
    const { name, slug, color, source } = data;

    // Check if slug already exists
    if (getTagBySlug(slug)) {
      return { success: false, error: `Tag "${slug}" já existe` };
    }

    // Get funnel for this account
    const funnel = mockFunnels.find((f) => f.account_id === accountId && f.ativo);
    if (!funnel) {
      return { success: false, error: 'Funil não encontrado' };
    }

    // Calculate next ordem
    const maxOrdem = Math.max(...stageTags.map((t) => t.ordem), 0);

    const newTag: Tag = {
      id: `tag-${Date.now()}`,
      account_id: accountId,
      funnel_id: funnel.id,
      name,
      slug: slug.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''),
      type: 'stage',
      color,
      ordem: maxOrdem + 1,
      ativo: true,
      created_at: new Date().toISOString(),
    };

    setTags((prev) => [...prev, newTag]);
    
    // Add history entry for tag creation
    const historyEntry: TagHistory = {
      id: `th-${Date.now()}`,
      contact_id: '', // No contact, this is a tag creation
      tag_id: newTag.id,
      action: 'tag_created',
      actor_type: 'system',
      actor_id: null,
      source,
      reason: `Etapa "${name}" criada`,
      created_at: new Date().toISOString(),
    };
    setTagHistory((prev) => [historyEntry, ...prev]);

    return { success: true, tagId: newTag.id };
  }, [accountId, getTagBySlug, stageTags]);

  // ============= STAGE MANAGEMENT =============

  // Move stage tag left or right (reorder columns)
  const moveStageTag = useCallback((tagId: string, direction: 'left' | 'right'): { success: boolean; error?: string } => {
    const tag = getTagById(tagId);
    if (!tag || tag.type !== 'stage') {
      return { success: false, error: 'Etapa não encontrada' };
    }

    const currentIndex = stageTags.findIndex((t) => t.id === tagId);
    if (currentIndex === -1) {
      return { success: false, error: 'Etapa não encontrada no funil' };
    }

    const newIndex = direction === 'left' ? currentIndex - 1 : currentIndex + 1;
    
    if (newIndex < 0 || newIndex >= stageTags.length) {
      return { success: false, error: 'Não é possível mover nessa direção' };
    }

    // Swap ordem values
    const adjacentTag = stageTags[newIndex];
    const tempOrdem = tag.ordem;

    setTags((prev) => prev.map((t) => {
      if (t.id === tag.id) return { ...t, ordem: adjacentTag.ordem };
      if (t.id === adjacentTag.id) return { ...t, ordem: tempOrdem };
      return t;
    }));

    // Add history entry
    const historyEntry: TagHistory = {
      id: `th-${Date.now()}`,
      contact_id: '',
      tag_id: tag.id,
      action: 'tag_created', // Using existing action type for reorder
      actor_type: 'user',
      actor_id: null,
      source: 'kanban',
      reason: `Etapa "${tag.name}" reordenada para ${direction === 'left' ? 'esquerda' : 'direita'}`,
      created_at: new Date().toISOString(),
    };
    setTagHistory((prev) => [historyEntry, ...prev]);

    return { success: true };
  }, [getTagById, stageTags]);

  // Delete stage tag (remove Kanban column)
  const deleteStageTag = useCallback((tagId: string): { success: boolean; error?: string } => {
    const tag = getTagById(tagId);
    if (!tag || tag.type !== 'stage') {
      return { success: false, error: 'Etapa não encontrada' };
    }

    // Check if there are leads in this stage
    const leadsInStage = leadTags.filter((lt) => lt.tag_id === tagId);
    if (leadsInStage.length > 0) {
      return { success: false, error: `Não é possível excluir: ${leadsInStage.length} lead(s) nesta etapa` };
    }

    // Remove the tag
    setTags((prev) => prev.filter((t) => t.id !== tagId));

    // Add history entry
    const historyEntry: TagHistory = {
      id: `th-${Date.now()}`,
      contact_id: '',
      tag_id: tagId,
      action: 'removed',
      actor_type: 'user',
      actor_id: null,
      source: 'kanban',
      reason: `Etapa "${tag.name}" excluída`,
      created_at: new Date().toISOString(),
    };
    setTagHistory((prev) => [historyEntry, ...prev]);

    return { success: true };
  }, [getTagById, leadTags]);

  // ============= CHATWOOT SIMULATION =============

  const simulateChatwootTagApplied = useCallback((contactId: string, tagSlug: string) => {
    // Simulates a tag being applied from Chatwoot
    let tag = getTagBySlug(tagSlug);
    
    if (tag) {
      if (tag.type === 'stage') {
        // Stage tag: move lead in Kanban
        applyStageTag({
          contactId,
          tagId: tag.id,
          source: 'chatwoot',
          actorType: 'external',
          actorId: null,
        });
      } else {
        // Operational tag: just add/toggle
        toggleOperationalTag({
          contactId,
          tagId: tag.id,
          source: 'chatwoot',
          actorType: 'external',
          actorId: null,
        });
      }
    } else {
      // Tag doesn't exist - auto-create as stage tag (new Kanban column)
      const result = createStageTag({
        name: tagSlug.charAt(0).toUpperCase() + tagSlug.slice(1).replace(/-/g, ' '),
        slug: tagSlug,
        color: '#6366F1', // Default color for auto-created tags
        source: 'chatwoot',
      });

      if (result.success && result.tagId) {
        // Apply the newly created tag to the contact
        applyStageTag({
          contactId,
          tagId: result.tagId,
          source: 'chatwoot',
          actorType: 'external',
          actorId: null,
        });
      }
    }
  }, [getTagBySlug, applyStageTag, toggleOperationalTag, createStageTag]);

  // ============= CONTEXT VALUE =============

  const value = useMemo<TagContextType>(() => ({
    tags,
    stageTags,
    operationalTags,
    leadTags,
    tagHistory,
    finalStageIds,
    funnelStageConfig,
    getTagById,
    getTagBySlug,
    getLeadTags,
    getLeadStageTag,
    getLeadOperationalTags,
    getContactTagHistory,
    hasTag,
    isFinalStage,
    addTag,
    removeTag,
    toggleOperationalTag,
    applyStageTag,
    createStageTag,
    moveStageTag,
    deleteStageTag,
    toggleFinalStage,
    updateFunnelStageConfig,
    simulateChatwootTagApplied,
  }), [
    tags,
    stageTags,
    operationalTags,
    leadTags,
    tagHistory,
    finalStageIds,
    funnelStageConfig,
    getTagById,
    getTagBySlug,
    getLeadTags,
    getLeadStageTag,
    getLeadOperationalTags,
    getContactTagHistory,
    hasTag,
    isFinalStage,
    addTag,
    removeTag,
    toggleOperationalTag,
    applyStageTag,
    createStageTag,
    moveStageTag,
    deleteStageTag,
    toggleFinalStage,
    updateFunnelStageConfig,
    simulateChatwootTagApplied,
  ]);

  return <TagContext.Provider value={value}>{children}</TagContext.Provider>;
};
