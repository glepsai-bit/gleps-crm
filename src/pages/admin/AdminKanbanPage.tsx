import { useMemo, useState, useEffect, useCallback, useRef, type DragEvent } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useFinance } from '@/contexts/FinanceContext';
import { CreateSaleDialog } from '@/components/finance/CreateSaleDialog';
import { LeadCard, CreateStageDialog, SyncIndicator, CreateLeadDialog } from '@/components/kanban';
import { Contact } from '@/types/crm';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Search,
  Phone,
  Mail,
  MessageSquare,
  Clock,
  DollarSign,
  Plus,
  MoreVertical,
  ChevronLeft,
  ChevronRight,
  Trash2,
  RefreshCw,
  ExternalLink,
  Upload,
} from 'lucide-react';
import { safeFormatDateBR } from '@/utils/dateUtils';
import { toast } from 'sonner';
import { tagsCloudService, type Tag as CloudTag, type LeadTag } from '@/services/tags.cloud.service';
import { tagsBackendService } from '@/services/tags.backend.service';
import { useBackend } from '@/config/backend.config';
import { hasChatwootConfig as checkChatwootConfig } from '@/utils/chatwootConfig';
import { supabase } from '@/integrations/supabase/client';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { mergeById } from '@/utils/dataSync';
import { cn } from '@/lib/utils';

// Choose service based on backend flag
const tagsService = useBackend ? tagsBackendService : tagsCloudService;

interface KanbanLead extends Contact {
  stage_id: string | null;
}

export default function AdminKanbanPage() {
  const { user, account } = useAuth();
  const { contacts, refetchContacts, isLoadingContacts, isSyncingContacts, lastContactsSync, newContactIds } = useFinance();

  const [stageTags, setStageTags] = useState<CloudTag[]>([]);
  const [leadTags, setLeadTags] = useState<LeadTag[]>([]);
  const [isLoadingTags, setIsLoadingTags] = useState(true);
  const [isSyncingTags, setIsSyncingTags] = useState(false);
  const [lastTagsSync, setLastTagsSync] = useState<string | null>(null);
  const [newLeadTagIds, setNewLeadTagIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedLead, setSelectedLead] = useState<KanbanLead | null>(null);
  const [draggedLead, setDraggedLead] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const [saleContactId, setSaleContactId] = useState<string | null>(null);
  const [deleteConfirmStage, setDeleteConfirmStage] = useState<CloudTag | null>(null);
  const [deleteHasLeads, setDeleteHasLeads] = useState(false);
  const [deleteMigrateToId, setDeleteMigrateToId] = useState<string>('');
  const [deleteForceMode, setDeleteForceMode] = useState<'migrate' | 'detach' | null>(null);
  const [isSyncingChatwoot, setIsSyncingChatwoot] = useState(false);
  const [isPushingLabels, setIsPushingLabels] = useState(false);
  const [isCreatingTemplate, setIsCreatingTemplate] = useState(false);

  const isFirstTagsLoad = useRef(true);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const chatwootSyncRef = useRef<NodeJS.Timeout | null>(null);
  const isChatwootSyncingRef = useRef(false);

  const accountId = user?.account_id || account?.id;
  
  // Check if Chatwoot is configured - backend-aware
  const hasChatwootConfig = checkChatwootConfig(account);

  // Clear new lead tag animation after delay
  const clearNewLeadTagIds = useCallback((ids: string[]) => {
    setTimeout(() => {
      setNewLeadTagIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    }, 2000);
  }, []);

  // Fetch stage tags and lead_tags with merge strategy
  const fetchTagsData = useCallback(async (isBackground = false) => {
    if (!accountId) {
      setIsLoadingTags(false);
      return;
    }

    if (isFirstTagsLoad.current) {
      setIsLoadingTags(true);
    } else if (isBackground) {
      setIsSyncingTags(true);
    }

    try {
      // Fetch stage tags
      const tags = await tagsService.listStageTags(accountId);
      setStageTags(tags);

      // Fetch all lead_tags for this account's contacts
      let incoming: LeadTag[] = [];
      if (useBackend) {
        // Backend: fetch all lead_tags via API (contacts endpoint aggregates them)
        try {
          const response = await apiClient.get<any>('/api/lead-tags', { params: { accountId } });
          incoming = Array.isArray(response) ? response : (response?.data || []);
        } catch {
          incoming = [];
        }
      } else {
        const { data: leadTagsData } = await supabase
          .from('lead_tags')
          .select('*');
        incoming = leadTagsData || [];
      }
      
      // Defensive guard
      if (!Array.isArray(incoming)) incoming = [];

      setLeadTags(current => {
        if (current.length === 0 || isFirstTagsLoad.current) {
          return incoming;
        }
        
        // Merge with existing data
        const result = mergeById(current, incoming, true);
        
        // Track new items for animation
        if (result.added.length > 0) {
          setNewLeadTagIds(prev => new Set([...prev, ...result.added]));
          clearNewLeadTagIds(result.added);
        }
        
        return result.data;
      });

      setLastTagsSync(new Date().toISOString());
      isFirstTagsLoad.current = false;
    } catch (error) {
      console.error('Error fetching kanban data:', error);
      // Only show toast on first load failures — background refreshes fail silently
      // to avoid spamming the user with "Erro ao carregar etapas" when the network
      // hiccups or the backend rate-limits a polling call.
      if (isFirstTagsLoad.current && !isBackground) {
        toast.error('Erro ao carregar etapas');
      }
    } finally {
      setIsLoadingTags(false);
      setIsSyncingTags(false);
    }
  }, [accountId, clearNewLeadTagIds]);

  // Initial fetch
  useEffect(() => {
    fetchTagsData(false);
  }, [fetchTagsData]);

  // Lightweight background refresh: only re-reads lead_tags + stage_tags from our
  // own backend (NOT the heavy Chatwoot sync). Runs every 20s to pick up changes
  // made by the AI / external workflows (e.g. n8n moving labels) without ever
  // blocking the UI or hitting Chatwoot's rate limit.
  useEffect(() => {
    if (!accountId) return;

    pollingRef.current = setInterval(() => {
      if (isFirstTagsLoad.current) return;
      // Background refresh — never shows error toasts (handled inside fetchTagsData)
      fetchTagsData(true);
    }, 20000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [accountId, fetchTagsData]);

  // Heavy Chatwoot sync: pulls new contacts/conversations from Chatwoot every 5
  // minutes. This is the slow call that previously froze the UI when running
  // every 30s. By spacing it to 5min and running it silently in the background
  // we still pick up new leads automatically without blocking interactions.
  useEffect(() => {
    if (!accountId || !hasChatwootConfig) return;

    const runSilentChatwootSync = async () => {
      if (isChatwootSyncingRef.current) return;
      isChatwootSyncingRef.current = true;
      try {
        const result = await tagsService.syncChatwootContacts(accountId);
        if (result?.success) {
          const created = result.contacts_created || 0;
          const updated = result.contacts_updated || 0;
          const applied = result.lead_tags_applied || 0;
          if (created > 0 || updated > 0 || applied > 0) {
            // Silent refresh — no toasts, just update the board
            await refetchContacts();
            fetchTagsData(true);
          }
        }
      } catch {
        // Silent: background sync errors must never spam the UI
      } finally {
        isChatwootSyncingRef.current = false;
      }
    };

    chatwootSyncRef.current = setInterval(runSilentChatwootSync, 5 * 60 * 1000);

    return () => {
      if (chatwootSyncRef.current) {
        clearInterval(chatwootSyncRef.current);
      }
    };
  }, [accountId, hasChatwootConfig, fetchTagsData, refetchContacts]);

  // Get stage tag for a lead
  const getLeadStageTag = useCallback((contactId: string): CloudTag | undefined => {
    const leadTag = leadTags.find(lt => lt.contact_id === contactId);
    if (!leadTag) return undefined;
    return stageTags.find(t => t.id === leadTag.tag_id);
  }, [leadTags, stageTags]);

  const leads: KanbanLead[] = useMemo(() => {
    return contacts
      .map((contact) => {
        const stageTag = getLeadStageTag(contact.id);
        return { ...contact, stage_id: stageTag?.id || null };
      })
      .filter(
        (lead) =>
          !searchTerm ||
          lead.nome?.toLowerCase().includes(searchTerm.toLowerCase()) ||
          lead.telefone?.includes(searchTerm)
      );
  }, [contacts, getLeadStageTag, searchTerm]);

  const getLeadsByStage = (stageTagId: string) => leads.filter((lead) => lead.stage_id === stageTagId);

  const handleDragStart = useCallback((leadId: string) => {
    setDraggedLead(leadId);
  }, []);
  
  const handleDragEnd = useCallback(() => {
    setDraggedLead(null);
    setDragOverStage(null);
  }, []);
  
  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>, stageId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverStage !== stageId) {
      setDragOverStage(stageId);
    }
  }, [dragOverStage]);
  
  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    // Only clear if leaving the column entirely (not just moving between children)
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setDragOverStage(null);
    }
  }, []);

  const handleDrop = useCallback(async (stageTagId: string) => {
    if (!draggedLead) return;

    const lead = leads.find((l) => l.id === draggedLead);
    const stage = stageTags.find((s) => s.id === stageTagId);
    const previousLeadTags = [...leadTags];
    
    // Skip if dropping on same stage
    const currentStageTag = leadTags.find(lt => lt.contact_id === draggedLead);
    if (currentStageTag?.tag_id === stageTagId) {
      setDraggedLead(null);
      return;
    }

    // OPTIMISTIC UPDATE: Update UI immediately
    setLeadTags(current => {
      const existing = current.find(lt => lt.contact_id === draggedLead);
      if (existing) {
        // Update existing tag
        return current.map(lt => 
          lt.contact_id === draggedLead 
            ? { ...lt, tag_id: stageTagId }
            : lt
        );
      } else {
        // Add new tag
        return [...current, {
          id: `temp-${Date.now()}`,
          contact_id: draggedLead,
          tag_id: stageTagId,
          created_at: new Date().toISOString(),
          applied_by_id: null,
          source: 'kanban'
        }];
      }
    });
    
    setDraggedLead(null);

    // BACKGROUND SYNC: Update database without blocking UI
    try {
      await tagsService.applyStageTag(draggedLead, stageTagId, 'kanban');
      toast.success(`${lead?.nome} movido para ${stage?.name}`);
      // Light refresh to reconcile temp IDs with real ones from backend (silent)
      fetchTagsData(true);
    } catch (error: any) {
      // Rollback on error
      setLeadTags(previousLeadTags);
      toast.error(error.message || 'Erro ao mover lead');
    }
  }, [draggedLead, leads, stageTags, leadTags, fetchTagsData]);

  const handleMoveStage = async (tagId: string, direction: 'left' | 'right') => {
    const currentIndex = stageTags.findIndex(t => t.id === tagId);
    if (currentIndex === -1) return;

    const newIndex = direction === 'left' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= stageTags.length) {
      toast.error('Não é possível mover nessa direção');
      return;
    }

    const adjacentTag = stageTags[newIndex];

    try {
      await tagsService.swapTagOrder(tagId, adjacentTag.id);
      toast.success('Etapa reordenada!');
      fetchTagsData(false);
    } catch (error: any) {
      toast.error(error.message || 'Erro ao reordenar');
    }
  };

  const handleDeleteStage = async () => {
    if (!deleteConfirmStage) return;

    try {
      const options: { force?: boolean; migrateToId?: string } = {};
      if (deleteHasLeads) {
        options.force = true;
        if (deleteForceMode === 'migrate' && deleteMigrateToId) {
          options.migrateToId = deleteMigrateToId;
        }
      }
      await tagsService.deleteTag(deleteConfirmStage.id, options);
      toast.success(`Etapa "${deleteConfirmStage.name}" excluída!`);
      fetchTagsData(false);
      if (deleteHasLeads && deleteForceMode === 'migrate') {
        refetchContacts();
      }
    } catch (error: any) {
      toast.error(error.message || 'Erro ao excluir etapa');
    }
    setDeleteConfirmStage(null);
    setDeleteHasLeads(false);
    setDeleteForceMode(null);
    setDeleteMigrateToId('');
  };

  const getInitials = (name: string | null) => {
    if (!name) return '??';
    return name
      .split(' ')
      .map((n) => n[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  };

  const getOriginBadge = (origem: string | null) => {
    switch (origem) {
      case 'whatsapp':
        return <Badge variant="secondary" className="text-xs">WhatsApp</Badge>;
      case 'instagram':
        return <Badge variant="secondary" className="text-xs">Instagram</Badge>;
      case 'site':
        return <Badge variant="secondary" className="text-xs">Site</Badge>;
      default:
        return <Badge variant="secondary" className="text-xs">Manual</Badge>;
    }
  };

  const handleOpenSaleDialog = (leadId: string) => {
    setSaleContactId(leadId);
    setSelectedLead(null);
  };

  const handleOpenChatwoot = (lead: KanbanLead) => {
    const baseUrl = account?.chatwoot_base_url?.replace(/\/$/, '');
    const accountIdChatwoot = account?.chatwoot_account_id;
    const conversationId = lead.chatwoot_conversation_id;

    if (!baseUrl || !accountIdChatwoot) {
      toast.error('Chatwoot não configurado para esta conta');
      return;
    }

    if (!conversationId) {
      toast.warning('Este lead não possui conversa vinculada no Chatwoot');
      return;
    }

    const url = `${baseUrl}/app/accounts/${accountIdChatwoot}/conversations/${conversationId}`;
    window.open(url, '_blank');
  };

  const handlePushLabelsToChatwoot = async () => {
    if (!accountId || isPushingLabels) return;
    
    setIsPushingLabels(true);
    try {
      const result = await tagsService.pushAllLabelsToChatwoot(accountId);
      
      if (result.success) {
        const total = result.pushed + result.linked;
        if (result.pushed > 0) {
          toast.success(`Etapas enviadas ao Chatwoot: ${result.pushed} criada(s), ${result.linked} vinculada(s).`);
        } else {
          toast.info(`Todas as ${result.linked} etapa(s) já existem no Chatwoot.`);
        }
        fetchTagsData(false);
      } else {
        toast.error(result.errors[0] || 'Erro ao enviar etapas');
      }
    } catch (error: any) {
      toast.error(error.message || 'Erro ao enviar etapas ao Chatwoot');
    } finally {
      setIsPushingLabels(false);
    }
  };

  const handleSyncChatwoot = async () => {
    if (!accountId || isSyncingChatwoot) return;
    
    setIsSyncingChatwoot(true);
    try {
      const result = await tagsService.syncChatwootContacts(accountId);
      
      if (result.success) {
        const total = result.contacts_created + result.contacts_updated;
        const removedCount = result.lead_tags_removed || 0;
        const deletedCount = result.contacts_deleted || 0;
        if (total > 0 || result.lead_tags_applied > 0 || removedCount > 0 || deletedCount > 0) {
          const parts = [];
          if (result.contacts_created > 0) parts.push(`${result.contacts_created} criado(s)`);
          if (result.contacts_updated > 0) parts.push(`${result.contacts_updated} atualizado(s)`);
          if (deletedCount > 0) parts.push(`${deletedCount} excluído(s)`);
          if (result.lead_tags_applied > 0) parts.push(`${result.lead_tags_applied} etapa(s) aplicada(s)`);
          toast.success(`Sincronização concluída: ${parts.join(', ')}.`);
          // Refresh contacts and lead tags
          await refetchContacts();
          fetchTagsData(false);
        } else {
          toast.info('Nenhuma alteração necessária - tudo sincronizado.');
        }
      } else {
        toast.error(result.errors[0] || 'Erro ao sincronizar contatos');
      }
    } catch (error: any) {
      toast.error(error.message || 'Erro ao sincronizar contatos');
    } finally {
      setIsSyncingChatwoot(false);
    }
  };


  // Check if initial loading (skeleton only on first load)
  const isInitialLoading = isLoadingTags && isLoadingContacts;

  if (isInitialLoading) {
    return (
      <div className="page-container h-[calc(100vh-8rem)]">
        {/* Skeleton Header */}
        <div className="page-header">
          <div className="min-w-0">
            <Skeleton className="h-8 w-32 mb-2" />
            <Skeleton className="h-4 w-48" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 w-48" />
          </div>
        </div>
        {/* Skeleton Columns */}
        <div className="flex gap-4 overflow-hidden mt-6">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="w-72 flex-shrink-0">
              <Skeleton className="h-[500px] rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="page-container h-[calc(100vh-8rem)] overflow-hidden">
      {/* Header */}
      <div className="page-header">
        <div className="min-w-0 flex items-center gap-3">
          <div>
            <h1 className="title-responsive text-foreground">Kanban</h1>
            <p className="text-responsive-sm text-muted-foreground">Gerencie seus leads no funil</p>
          </div>
          {/* Sync Indicator - shows when syncing in background */}
          <SyncIndicator 
            isSyncing={isSyncingTags || isSyncingContacts} 
            lastSyncAt={lastTagsSync || lastContactsSync}
          />
        </div>
        <div className="flex flex-col xs:flex-row items-stretch xs:items-center gap-2 sm:gap-3 w-full xs:w-auto">
          {hasChatwootConfig && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 min-h-[40px] sm:min-h-0"
                onClick={handleSyncChatwoot}
                disabled={isSyncingChatwoot}
              >
                {isSyncingChatwoot ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                <span className="hidden xs:inline">Sincronizar</span>
                <span className="xs:hidden">Sync</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 min-h-[40px] sm:min-h-0"
                onClick={handlePushLabelsToChatwoot}
                disabled={isPushingLabels}
              >
                {isPushingLabels ? (
                  <Upload className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                <span className="hidden xs:inline">Enviar Etapas</span>
                <span className="xs:hidden">Push</span>
              </Button>
            </>
          )}
          <CreateLeadDialog
            accountId={accountId || ''}
            stages={stageTags}
            hasChatwootConfig={hasChatwootConfig}
            trigger={
              <Button variant="default" size="sm" className="gap-2 min-h-[40px] sm:min-h-0">
                <Plus className="w-4 h-4" />
                <span className="hidden xs:inline">Novo Lead</span>
                <span className="xs:hidden">Lead</span>
              </Button>
            }
            onLeadCreated={() => {
              refetchContacts();
              fetchTagsData(false);
            }}
          />
          <CreateStageDialog
            trigger={
              <Button variant="outline" size="sm" className="gap-2 min-h-[40px] sm:min-h-0">
                <Plus className="w-4 h-4" />
                <span className="hidden xs:inline">Nova Etapa</span>
                <span className="xs:hidden">Etapa</span>
              </Button>
            }
            onStageCreated={() => fetchTagsData(false)}
          />
          <div className="relative w-full xs:w-48 sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Buscar leads..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 min-h-[40px] sm:min-h-0"
            />
          </div>
        </div>
      </div>

      {/* Empty State */}
      {stageTags.length === 0 && (
        <div className="flex flex-col items-center justify-center h-[calc(100%-6rem)] gap-6">
          <div className="text-center space-y-2">
            <h2 className="text-xl font-semibold">Nenhuma etapa criada</h2>
            <p className="text-muted-foreground max-w-md">
              Use o template recomendado para começar rapidamente ou crie suas próprias etapas.
            </p>
          </div>

          {/* Template preview */}
          <div className="flex flex-wrap justify-center gap-3 max-w-lg">
            {[
              { name: 'Novo Lead', color: '#0EA5E9' },
              { name: 'Em Atendimento', color: '#8B5CF6' },
              { name: 'Aguardando Resposta', color: '#F59E0B' },
              { name: 'Agendado', color: '#22C55E' },
              { name: 'Convertido', color: '#10B981' },
              { name: 'Perdido', color: '#EF4444' },
            ].map((s) => (
              <div key={s.name} className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                {s.name}
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <Button
              disabled={isCreatingTemplate}
              onClick={async () => {
                if (!accountId) return;
                setIsCreatingTemplate(true);
                try {
                  if (useBackend) {
                    // Backend: create stages via API calls
                    const defaultStages = [
                      { name: 'Novo Lead', color: '#0EA5E9', ordem: 1 },
                      { name: 'Em Atendimento', color: '#8B5CF6', ordem: 2 },
                      { name: 'Aguardando Resposta', color: '#F59E0B', ordem: 3 },
                      { name: 'Agendado', color: '#22C55E', ordem: 4 },
                      { name: 'Convertido', color: '#10B981', ordem: 5 },
                      { name: 'Perdido', color: '#EF4444', ordem: 6 },
                    ];
                    // Get or create default funnel
                    const funnelsResponse = await apiClient.get<any>(API_ENDPOINTS.FUNNELS.LIST, { params: { accountId } });
                    const funnelsList = Array.isArray(funnelsResponse) ? funnelsResponse : (funnelsResponse?.data || []);
                    let funnelId = funnelsList.find((f: any) => f.is_default || f.isDefault)?.id;
                    if (!funnelId) {
                      const newFunnel = await apiClient.post<any>(API_ENDPOINTS.FUNNELS.CREATE, { name: 'Funil Principal', accountId, isDefault: true });
                      const created = newFunnel?.data ?? newFunnel;
                      funnelId = created.id;
                    }
                    for (const s of defaultStages) {
                      await tagsBackendService.createStageTag({ accountId, funnelId, name: s.name, color: s.color, ordem: s.ordem });
                    }
                  } else {
                    await tagsCloudService.createDefaultStages(accountId);
                  }
                  await fetchTagsData(false);
                  toast.success('6 etapas criadas com sucesso!');
                } catch (err: any) {
                  toast.error(err.message || 'Erro ao criar etapas');
                } finally {
                  setIsCreatingTemplate(false);
                }
              }}
            >
              {isCreatingTemplate ? (
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-2" />
              )}
              {isCreatingTemplate ? 'Criando...' : 'Usar Template Padrão'}
            </Button>
            <CreateStageDialog
              trigger={
                <Button variant="outline">
                  Criar Manualmente
                </Button>
              }
              onStageCreated={() => fetchTagsData(false)}
            />
          </div>
        </div>
      )}

      {/* Kanban Board - Horizontal scroll with snap */}
      {stageTags.length > 0 && (
        <div className="kanban-container h-[calc(100%-6rem)]">
          {stageTags.map((stage, index) => {
            const stageLeads = getLeadsByStage(stage.id);
            const isFirst = index === 0;
            const isLast = index === stageTags.length - 1;

            return (
              <div
                key={stage.id}
                className={cn(
                  'kanban-column kanban-column-snap transition-colors duration-150',
                  dragOverStage === stage.id && draggedLead && 'ring-2 ring-primary/30 ring-inset rounded-lg'
                )}
                onDragOver={(e) => handleDragOver(e, stage.id)}
                onDragLeave={handleDragLeave}
                onDrop={() => {
                  setDragOverStage(null);
                  handleDrop(stage.id);
                }}
              >
                <Card className="h-full flex flex-col shadow-sm">
                  <CardHeader className="py-3 px-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: stage.color }} />
                        <CardTitle className="text-sm font-semibold truncate">{stage.name}</CardTitle>
                        {stage.chatwoot_label_id && (
                          <Badge variant="outline" className="text-xs">Chatwoot</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <Badge variant="secondary" className="text-xs">{stageLeads.length}</Badge>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7">
                              <MoreVertical className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => handleMoveStage(stage.id, 'left')}
                              disabled={isFirst}
                            >
                              <ChevronLeft className="w-4 h-4 mr-2" />
                              Mover para Esquerda
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleMoveStage(stage.id, 'right')}
                              disabled={isLast}
                            >
                              <ChevronRight className="w-4 h-4 mr-2" />
                              Mover para Direita
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => {
                                // Check if stage has leads to show options immediately
                                const leadsInStage = getLeadsByStage(stage.id);
                                if (leadsInStage.length > 0) {
                                  setDeleteHasLeads(true);
                                }
                                setDeleteConfirmStage(stage);
                              }}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Excluir Etapa
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="px-2 pb-2 pt-0 flex-1 overflow-hidden">
                    <ScrollArea className="h-full">
                      <div className="space-y-2 pr-1">
                        {stageLeads.map((lead) => (
                          <LeadCard
                            key={lead.id}
                            lead={lead}
                            stage={stage as any}
                            isDragging={draggedLead === lead.id}
                            isNew={newContactIds.has(lead.id) || newLeadTagIds.has(lead.id)}
                            onClick={() => setSelectedLead(lead)}
                            onDragStart={() => handleDragStart(lead.id)}
                            onDragEnd={handleDragEnd}
                          />
                        ))}
                        {stageLeads.length === 0 && (
                          <div className="py-8 text-center text-sm text-muted-foreground">Nenhum lead nesta etapa</div>
                        )}
                      </div>
                    </ScrollArea>
                  </CardContent>
                </Card>
              </div>
            );
          })}
        </div>
      )}

      {/* Lead Detail Dialog */}
      <Dialog open={!!selectedLead} onOpenChange={() => setSelectedLead(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Detalhes do Lead</DialogTitle>
            <DialogDescription>Informações do lead</DialogDescription>
          </DialogHeader>

          {selectedLead && (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <Avatar className="h-16 w-16">
                  <AvatarFallback className="text-xl bg-primary/10 text-primary">
                    {getInitials(selectedLead.nome)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <h3 className="text-xl font-bold">{selectedLead.nome || 'Sem nome'}</h3>
                  {getOriginBadge(selectedLead.origem)}
                </div>
              </div>

              <div className="space-y-3">
                {selectedLead.telefone && (
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <Phone className="w-5 h-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm text-muted-foreground">Telefone</p>
                      <p className="font-medium">{selectedLead.telefone}</p>
                    </div>
                  </div>
                )}
                {selectedLead.email && (
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <Mail className="w-5 h-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm text-muted-foreground">Email</p>
                      <p className="font-medium">{selectedLead.email}</p>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                  <Clock className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Criado em</p>
                    <p className="font-medium">
                      {safeFormatDateBR(selectedLead.created_at, "dd 'de' MMMM 'de' yyyy")}
                    </p>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t space-y-2">
                <Button className="w-full gap-2" variant="outline" onClick={() => handleOpenChatwoot(selectedLead)}>
                  <ExternalLink className="w-4 h-4" />
                  Abrir Conversa no Chatwoot
                </Button>
                <Button className="w-full gap-2" onClick={() => handleOpenSaleDialog(selectedLead.id)}>
                  <DollarSign className="w-4 h-4" />
                  Registrar Venda
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirmStage} onOpenChange={(open) => {
        if (!open) {
          setDeleteConfirmStage(null);
          setDeleteHasLeads(false);
          setDeleteForceMode(null);
          setDeleteMigrateToId('');
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir Etapa</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {!deleteHasLeads ? (
                  <>
                    <p>Tem certeza que deseja excluir a etapa "{deleteConfirmStage?.name}"?</p>
                    {deleteConfirmStage?.chatwoot_label_id && (
                      <p><strong>Nota:</strong> Esta etapa está sincronizada com o Chatwoot. A label será removida.</p>
                    )}
                  </>
                ) : (
                  <>
                    <p>A etapa "{deleteConfirmStage?.name}" possui leads vinculados. Escolha o que fazer:</p>
                    <div className="space-y-2 pt-2">
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="deleteMode"
                          checked={deleteForceMode === 'migrate'}
                          onChange={() => setDeleteForceMode('migrate')}
                          className="mt-1"
                        />
                        <div>
                          <span className="font-medium text-foreground">Mover leads para outra etapa</span>
                          <p className="text-xs text-muted-foreground">Os leads serão transferidos antes da exclusão</p>
                        </div>
                      </label>
                      {deleteForceMode === 'migrate' && (
                        <Select value={deleteMigrateToId} onValueChange={setDeleteMigrateToId}>
                          <SelectTrigger className="ml-6">
                            <SelectValue placeholder="Selecione a etapa destino" />
                          </SelectTrigger>
                          <SelectContent>
                            {stageTags
                              .filter(t => t.id !== deleteConfirmStage?.id)
                              .map(t => (
                                <SelectItem key={t.id} value={t.id}>
                                  <div className="flex items-center gap-2">
                                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.color }} />
                                    {t.name}
                                  </div>
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      )}
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="deleteMode"
                          checked={deleteForceMode === 'detach'}
                          onChange={() => setDeleteForceMode('detach')}
                          className="mt-1"
                        />
                        <div>
                          <span className="font-medium text-foreground">Desvincular leads e excluir</span>
                          <p className="text-xs text-muted-foreground">Os leads ficarão sem etapa definida</p>
                        </div>
                      </label>
                    </div>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteStage}
              disabled={deleteHasLeads && (!deleteForceMode || (deleteForceMode === 'migrate' && !deleteMigrateToId))}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteHasLeads ? 'Confirmar Exclusão' : 'Excluir'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>




      {saleContactId && (
        <CreateSaleDialog preSelectedContactId={saleContactId} onClose={() => setSaleContactId(null)} />
      )}
    </div>
  );
}
