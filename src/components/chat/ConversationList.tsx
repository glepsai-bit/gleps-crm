/**
 * ConversationList — T-022 Sprint 4
 *
 * Coluna esquerda do chat: filtros + lista paginada de conversas.
 * - TanStack Query em conversationsBackendService.listConversations
 * - Filtros: status, assignee (me/all/unassigned), team, inbox, priority, label
 * - Search com debounce 300ms
 * - Cards: avatar placeholder, nome, snippet da última msg, badge unreadCount,
 *   ícone status/priority, timestamp relativo pt-BR
 * - Saved views: persiste combinação atual em localStorage por accountId
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search,
  Bookmark,
  BookmarkPlus,
  AlertCircle,
  Inbox as InboxIcon,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import {
  conversationsBackendService,
  type Conversation,
  type ConversationPriority,
  type ConversationStatus,
} from '@/services/conversations.backend.service';
import { inboxesBackendService } from '@/services/inboxes.backend.service';
import { teamsBackendService } from '@/services/teams.backend.service';
import { tagsBackendService } from '@/services/tags.backend.service';
import { chatSocket } from '@/services/socket.client';
import { tokenManager } from '@/api/client';

type AssigneeFilter = 'all' | 'me' | 'unassigned';
type StatusFilter = ConversationStatus | 'all';
type PriorityFilter = ConversationPriority | 'all';

interface ListFiltersState {
  status: StatusFilter;
  assignee: AssigneeFilter;
  teamId: string | 'all';
  inboxId: string | 'all';
  priority: PriorityFilter;
  labelId: string | 'all';
  search: string;
}

const DEFAULT_FILTERS: ListFiltersState = {
  status: 'open',
  assignee: 'all',
  teamId: 'all',
  inboxId: 'all',
  priority: 'all',
  labelId: 'all',
  search: '',
};

interface SavedView {
  id: string;
  name: string;
  filters: ListFiltersState;
}

function savedViewsKey(accountId: string | null | undefined): string {
  return `chat:savedViews:${accountId ?? 'anon'}`;
}

function loadSavedViews(accountId: string | null | undefined): SavedView[] {
  try {
    const raw = localStorage.getItem(savedViewsKey(accountId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSavedViews(
  accountId: string | null | undefined,
  views: SavedView[]
): void {
  try {
    localStorage.setItem(savedViewsKey(accountId), JSON.stringify(views));
  } catch {
    /* ignore quota */
  }
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} d`;
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function getInitials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function lastMessageSnippet(conv: Conversation): string {
  // Backend `FULL_CONVERSATION_INCLUDE` agora retorna messages ordenadas desc
  // com take=1, então o item mais recente é messages[0]. Mantém fallback
  // pro último item caso outro caller envie array com ordem ascendente.
  const list = conv.messages ?? [];
  const msg = list[0] ?? list[list.length - 1];
  if (!msg) return 'Sem mensagens ainda';
  if (msg.contentType === 'media') return '📎 Mídia';
  if (msg.contentType === 'audio') return '🎤 Áudio';
  if (msg.contentType === 'document') return '📄 Documento';
  return msg.content || '—';
}

const PRIORITY_DOT: Record<ConversationPriority, string> = {
  urgent: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-500',
};

const STATUS_LABEL: Record<ConversationStatus, string> = {
  open: 'Aberta',
  pending: 'Pendente',
  resolved: 'Resolvida',
  snoozed: 'Adiada',
};

interface ConversationListProps {
  selectedConversationId: string | null;
  onSelectConversation: (id: string) => void;
}

export function ConversationList({
  selectedConversationId,
  onSelectConversation,
}: ConversationListProps) {
  const { user, account } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<ListFiltersState>(DEFAULT_FILTERS);
  const [searchInput, setSearchInput] = useState('');
  const [savedViews, setSavedViews] = useState<SavedView[]>(() =>
    loadSavedViews(account?.id)
  );
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [newViewName, setNewViewName] = useState('');

  // Recarrega saved views se trocar de conta
  useEffect(() => {
    setSavedViews(loadSavedViews(account?.id));
  }, [account?.id]);

  // Socket.IO: invalida a lista de conversas em eventos relevantes (T-022)
  useEffect(() => {
    if (!account?.id) return;
    const token = tokenManager.getToken();
    if (!token) return;

    // connect() é idempotente — não derruba conexões existentes do mesmo token.
    chatSocket.connect(token);

    const invalidate = () =>
      queryClient.invalidateQueries({ queryKey: ['conversations'] });

    // Nova mensagem em qualquer conversa → reordena/atualiza unread/snippet
    const offMessage = chatSocket.onMessageCreated(invalidate);
    // Mudanças nas conversas (status, assignee, priority, snooze, etc.)
    const offUpdated = chatSocket.onConversationUpdated(invalidate);
    const offAssigned = chatSocket.onAssigned(invalidate);

    return () => {
      offMessage();
      offUpdated();
      offAssigned();
    };
  }, [account?.id, queryClient]);

  // Debounce busca (300ms)
  useEffect(() => {
    const handle = setTimeout(() => {
      setFilters((prev) =>
        prev.search === searchInput ? prev : { ...prev, search: searchInput }
      );
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // Inboxes / Teams / Labels (Tags) para os Selects
  const { data: inboxes = [] } = useQuery({
    queryKey: ['chat-inboxes', account?.id],
    queryFn: () => inboxesBackendService.listInboxes(),
    enabled: Boolean(account?.id),
    staleTime: 60_000,
  });

  const { data: teams = [] } = useQuery({
    queryKey: ['chat-teams', account?.id],
    queryFn: () => teamsBackendService.listTeams(),
    enabled: Boolean(account?.id),
    staleTime: 60_000,
  });

  const { data: tags = [] } = useQuery({
    queryKey: ['chat-tags', account?.id],
    queryFn: () => tagsBackendService.listAllTags(account!.id),
    enabled: Boolean(account?.id),
    staleTime: 60_000,
  });

  // Listagem principal
  const listQuery = useQuery({
    queryKey: ['conversations', account?.id, filters, user?.id],
    queryFn: async () => {
      const params: Parameters<
        typeof conversationsBackendService.listConversations
      >[0] = {
        limit: 50,
      };
      if (filters.status !== 'all') params.status = filters.status;
      if (filters.priority !== 'all') params.priority = filters.priority;
      if (filters.inboxId !== 'all') params.inboxId = filters.inboxId;
      if (filters.labelId !== 'all') params.labelId = filters.labelId;
      if (filters.search.trim()) params.search = filters.search.trim();

      if (filters.assignee === 'me' && user?.id) {
        params.assigneeId = user.id;
      } else if (filters.assignee === 'unassigned') {
        params.assigneeId = null;
      }

      if (filters.teamId !== 'all') {
        params.teamId = filters.teamId;
      }

      return conversationsBackendService.listConversations(params);
    },
    enabled: Boolean(account?.id),
    refetchInterval: 30_000,
  });

  const conversations = listQuery.data?.data ?? [];
  const total = listQuery.data?.total ?? 0;

  const activeFiltersCount = useMemo(() => {
    let c = 0;
    if (filters.status !== 'open') c += 1;
    if (filters.assignee !== 'all') c += 1;
    if (filters.teamId !== 'all') c += 1;
    if (filters.inboxId !== 'all') c += 1;
    if (filters.priority !== 'all') c += 1;
    if (filters.labelId !== 'all') c += 1;
    if (filters.search.trim()) c += 1;
    return c;
  }, [filters]);

  function handleSaveView() {
    const name = newViewName.trim();
    if (!name) {
      toast({ title: 'Informe um nome', variant: 'destructive' });
      return;
    }
    const view: SavedView = {
      id: crypto.randomUUID(),
      name,
      filters,
    };
    const next = [...savedViews, view];
    setSavedViews(next);
    persistSavedViews(account?.id, next);
    setSaveViewOpen(false);
    setNewViewName('');
    toast({ title: 'Visão salva', description: name });
  }

  function applyView(view: SavedView) {
    setFilters(view.filters);
    setSearchInput(view.filters.search);
  }

  function deleteView(id: string) {
    const next = savedViews.filter((v) => v.id !== id);
    setSavedViews(next);
    persistSavedViews(account?.id, next);
  }

  function resetFilters() {
    setFilters(DEFAULT_FILTERS);
    setSearchInput('');
  }

  return (
    <div className="flex h-full flex-col border-r border-border bg-card">
      {/* Cabeçalho + busca */}
      <div className="border-b border-border p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            Conversas {total > 0 && <span className="text-muted-foreground">({total})</span>}
          </h2>
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" title="Visões salvas">
                  <Bookmark className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Visões salvas</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {savedViews.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    Nenhuma visão salva
                  </div>
                ) : (
                  savedViews.map((v) => (
                    <DropdownMenuItem
                      key={v.id}
                      onClick={() => applyView(v)}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="truncate">{v.name}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteView(v.id);
                        }}
                        className="text-xs text-destructive hover:underline"
                      >
                        excluir
                      </button>
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setSaveViewOpen(true)}>
                  <BookmarkPlus className="w-4 h-4 mr-2" />
                  Salvar visão atual
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar conversas..."
            className="pl-7 h-8 text-xs"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Select
            value={filters.status}
            onValueChange={(v) =>
              setFilters((f) => ({ ...f, status: v as StatusFilter }))
            }
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos status</SelectItem>
              <SelectItem value="open">Aberta</SelectItem>
              <SelectItem value="pending">Pendente</SelectItem>
              <SelectItem value="resolved">Resolvida</SelectItem>
              <SelectItem value="snoozed">Adiada</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={filters.assignee}
            onValueChange={(v) =>
              setFilters((f) => ({ ...f, assignee: v as AssigneeFilter }))
            }
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Atribuição" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos agentes</SelectItem>
              <SelectItem value="me">Atribuídas a mim</SelectItem>
              <SelectItem value="unassigned">Não atribuídas</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={filters.teamId}
            onValueChange={(v) => setFilters((f) => ({ ...f, teamId: v }))}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Time" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos times</SelectItem>
              {teams.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={filters.inboxId}
            onValueChange={(v) => setFilters((f) => ({ ...f, inboxId: v }))}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Canal" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos canais</SelectItem>
              {inboxes.map((inbox) => (
                <SelectItem key={inbox.id} value={inbox.id}>
                  {inbox.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={filters.priority}
            onValueChange={(v) =>
              setFilters((f) => ({ ...f, priority: v as PriorityFilter }))
            }
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Prioridade" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas prioridades</SelectItem>
              <SelectItem value="urgent">Urgente</SelectItem>
              <SelectItem value="high">Alta</SelectItem>
              <SelectItem value="medium">Média</SelectItem>
              <SelectItem value="low">Baixa</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={filters.labelId}
            onValueChange={(v) => setFilters((f) => ({ ...f, labelId: v }))}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Tag" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas tags</SelectItem>
              {tags.map((tag) => (
                <SelectItem key={tag.id} value={tag.id}>
                  {tag.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {activeFiltersCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={resetFilters}
            className="w-full h-7 text-xs text-muted-foreground"
          >
            Limpar filtros ({activeFiltersCount})
          </Button>
        )}
      </div>

      {/* Lista */}
      <ScrollArea className="flex-1">
        {listQuery.isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : listQuery.isError ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center text-muted-foreground">
            <AlertCircle className="w-8 h-8 mb-2 text-destructive" />
            <p className="text-sm">Erro ao carregar conversas</p>
            <Button
              variant="link"
              size="sm"
              className="mt-1 h-6"
              onClick={() => listQuery.refetch()}
            >
              Tentar novamente
            </Button>
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center text-muted-foreground">
            <InboxIcon className="w-10 h-10 mb-2 opacity-30" />
            <p className="text-sm font-medium">Nenhuma conversa encontrada</p>
            <p className="text-xs mt-1">Ajuste os filtros para ver mais resultados</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {conversations.map((conv) => {
              const isSelected = conv.id === selectedConversationId;
              const contactName = conv.contact?.nome || conv.contact?.telefone || 'Sem nome';
              const snippet = lastMessageSnippet(conv);
              const lastUpdate = relativeTime(conv.updatedAt);

              return (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => onSelectConversation(conv.id)}
                  className={cn(
                    'flex w-full items-start gap-2 p-3 text-left hover:bg-accent transition-colors',
                    isSelected && 'bg-accent'
                  )}
                >
                  <Avatar className="h-9 w-9 shrink-0">
                    <AvatarFallback className="text-xs bg-primary/10 text-primary">
                      {getInitials(contactName)}
                    </AvatarFallback>
                  </Avatar>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <p className="text-sm font-medium truncate text-foreground">
                        {contactName}
                      </p>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {lastUpdate}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{snippet}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span
                        className={cn(
                          'w-1.5 h-1.5 rounded-full',
                          PRIORITY_DOT[conv.priority]
                        )}
                        title={`Prioridade: ${conv.priority}`}
                      />
                      <Badge variant="outline" className="text-[9px] py-0 px-1 h-4">
                        {STATUS_LABEL[conv.status]}
                      </Badge>
                      {conv.inbox?.channelType && (
                        <Badge
                          variant="secondary"
                          className="text-[9px] py-0 px-1 h-4 capitalize"
                        >
                          {conv.inbox.channelType}
                        </Badge>
                      )}
                      {conv.unreadCount > 0 && (
                        <Badge className="ml-auto text-[9px] py-0 px-1 h-4 bg-primary">
                          {conv.unreadCount}
                        </Badge>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>

      {/* Dialog salvar visão */}
      <Dialog open={saveViewOpen} onOpenChange={setSaveViewOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Salvar visão atual</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="view-name">Nome da visão</Label>
            <Input
              id="view-name"
              value={newViewName}
              onChange={(e) => setNewViewName(e.target.value)}
              placeholder="Ex.: Minhas urgentes"
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">
              Salvaremos os filtros aplicados no momento. Visões ficam no seu navegador.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveViewOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSaveView}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ConversationList;
