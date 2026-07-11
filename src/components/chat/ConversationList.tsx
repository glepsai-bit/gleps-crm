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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search,
  SearchX,
  Bookmark,
  BookmarkPlus,
  AlertCircle,
  Inbox as InboxIcon,
  Phone,
  SlidersHorizontal,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { AuthAvatarImage } from '@/components/chat/AuthAvatarImage';
import { Skeleton } from '@/components/ui/skeleton';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/hooks/use-toast';
import {
  conversationsBackendService,
  type Conversation,
  type ConversationPriority,
  type ConversationStatus,
  type Message,
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

/**
 * Retorna as iniciais para o AvatarFallback OU `null` indicando que o caller
 * deve renderizar um ícone (Phone) em vez de iniciais.
 *
 * BUG-CHAT-AVATAR-DIGIT: quando o contato não tem nome (só telefone), o nome
 * exibido cai para o telefone — e `getInitials('5534...')` virava o caractere
 * "5" no avatar, o que parece bug visual. Sinalizamos null para o caller
 * usar `<Phone />` como fallback semântico.
 */
function getContactInitials(
  name: string | null | undefined,
  telefone?: string | null
): string | null {
  const trimmed = name?.trim();
  // Sem nome OU nome igual ao telefone OU nome começa com dígito → ícone.
  if (!trimmed) return null;
  if (telefone && trimmed === telefone) return null;
  if (/^\d/.test(trimmed)) return null;
  return trimmed
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

  // AUDIT-UNREAD-GHOST: o handler de socket abaixo é registrado uma vez
  // (deps [account?.id]) — ler selectedConversationId direto criaria closure
  // stale. Ref sempre atualizada resolve sem re-subscrever a cada seleção.
  const selectedConversationIdRef = useRef(selectedConversationId);
  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

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

  // Socket.IO: a divisão de responsabilidade entre componentes (T-022) garante
  // que cada evento socket dispara uma ÚNICA cadeia de invalidação:
  //
  //   - ConversationList    → invalida ['conversations'] em qualquer evento
  //                          e ['conversation', id, 'sidepanel-meta'] em
  //                          conversation:updated/assigned (rare events).
  //   - ConversationThread  → faz setQueryData direto em 'thread-full' (zero
  //                          refetch para message:created) e invalida AMBAS
  //                          as variantes em conversation:updated/assigned.
  //   - AdminChatPage       → não registra socket listener nenhum.
  //
  // BUG-4 (listeners duplicados, root cause comum):
  //   Antes, ConversationList invalidava 'thread-full' + 'sidepanel-meta' via
  //   predicate, E ConversationThread invalidava o mesmo predicate. Resultado:
  //   2 refetches paralelos por evento. Em rajada (cliente manda 3 msgs/s),
  //   o vencedor variável da corrida zerava o cache (Bug 3 — "Nenhuma
  //   mensagem ainda" piscando) e a resposta tardia da query reescrevia
  //   contact/inbox com snapshot velho (Bug 2 — nome oscilando).
  //   Corrigido aqui: este efeito NÃO mais toca 'thread-full' — quando a
  //   conversa está aberta, o ConversationThread cuida; quando não está,
  //   não há cache 'thread-full' pra invalidar mesmo. O 'sidepanel-meta'
  //   é invalidado pelos dois lados, mas o cache é leve (sem messages),
  //   o refetch é idempotente e os dois fluxos convergem pro mesmo valor.
  //
  // BUG-2 (cross-aba): mantém invalidação de 'sidepanel-meta' aqui para
  // que outra aba que edite o contato veja o nome correto na sidebar.
  // message:created NÃO invalida o meta porque mensagem nova nunca muda
  // contact/inbox/assignee.
  useEffect(() => {
    if (!account?.id) return;
    const token = tokenManager.getToken();
    if (!token) return;

    // connect() é idempotente — não derruba conexões existentes do mesmo token.
    chatSocket.connect(token);

    // refetchType:'active' garante que a query atualmente montada (a lista
    // visível) seja refetchada imediatamente — sem isso a invalidação pode
    // só marcar como stale e o usuário fica olhando "Sem mensagens ainda"
    // até o próximo tick de refetchInterval (30s) ou foco da janela.
    const invalidateList = () =>
      queryClient.invalidateQueries({
        queryKey: ['conversations'],
        refetchType: 'active',
      });

    const offMessage = chatSocket.onMessageCreated((payload) => {
      // Patch otimista: injeta a mensagem nova como `messages[0]` da conversa
      // alvo em TODOS os caches ['conversations', ...] que contenham ela.
      // Isso elimina o gap entre o evento socket e a chegada do refetch onde
      // o card mostrava "Sem mensagens ainda" mesmo com o thread já populado.
      // BUG-6: a invalidação a seguir continua sendo a fonte de verdade —
      // o patch só evita a janela de inconsistência visual.
      if (payload?.conversationId && payload?.message) {
        const incoming = payload.message as Message;
        const targetId = payload.conversationId;
        // Mensagem inbound (do cliente) precisa incrementar unreadCount na
        // lista se essa conversa nao e a atualmente aberta. Se e a aberta,
        // o ConversationThread mesmo emite mark-as-read via useEffect.
        const isInbound = incoming.senderType === 'customer';
        // AUDIT-UNREAD-GHOST: antes lia ?conversationId= da URL, que NUNCA é
        // setado (AdminChatPage guarda a seleção em useState) — isOpenHere era
        // sempre false e o badge incrementava mesmo com a conversa aberta.
        const isOpenHere = selectedConversationIdRef.current === targetId;
        queryClient.setQueriesData<{ data?: Conversation[] } | undefined>(
          { queryKey: ['conversations'] },
          (old) => {
            if (!old?.data) return old;
            const idx = old.data.findIndex((c) => c.id === targetId);
            if (idx < 0) return old;
            const existing = old.data[idx];
            const existingMsgs = existing.messages ?? [];
            const dedup = existingMsgs.some((m) => m.id === incoming.id)
              ? existingMsgs
              : [incoming, ...existingMsgs].slice(0, 1);
            const nextUnread =
              isInbound && !isOpenHere
                ? (existing.unreadCount ?? 0) + 1
                : existing.unreadCount ?? 0;
            const updated: Conversation = {
              ...existing,
              messages: dedup,
              updatedAt: incoming.createdAt ?? existing.updatedAt,
              unreadCount: nextUnread,
            };
            // Reordena: a conversa afetada sobe pro topo (orderBy updatedAt
            // DESC do backend). Antes desta correcao o patch mantinha a
            // posicao original — sem invalidateList a conv "nova" nunca
            // subia, entrando em conflito com o polling a cada 30s.
            const nextData = [updated, ...old.data.filter((_, i) => i !== idx)];
            return { ...old, data: nextData };
          }
        );
      }
      // PERF-AUDIT (Round 1): invalidateList() foi removida deste handler
      // (antes disparava em CADA mensagem em CADA conversa — tempestade de
      // refetches). O patch acima ja cobre: atualiza snippet, updatedAt,
      // unreadCount E reordena a lista. Sem esse trabalho manual a lista
      // divergia da ordem do backend ate o refetchInterval de 30s.
    });
    const offUpdated = chatSocket.onConversationUpdated((payload) => {
      invalidateList();
      if (payload?.conversationId) {
        // Apenas o cache leve do sidepanel — o thread-full é responsabilidade
        // do ConversationThread (que tem listener próprio e contexto pra
        // setQueryData incremental). Invalidar aqui também causaria refetch
        // duplo e re-introduziria o piscar de "Nenhuma mensagem ainda".
        queryClient.invalidateQueries({
          queryKey: ['conversation', payload.conversationId, 'sidepanel-meta'],
        });
      }
    });
    const offAssigned = chatSocket.onAssigned((payload) => {
      invalidateList();
      if (payload?.conversationId) {
        queryClient.invalidateQueries({
          queryKey: ['conversation', payload.conversationId, 'sidepanel-meta'],
        });
      }
    });

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

  // Sticky selection: garante que a conversa selecionada permaneça visível
  // na lista mesmo que ela não bata com os filtros atuais (ex.: usuário
  // resolveu a conversa e o filtro padrão é "open"). Lê do cache leve
  // 'sidepanel-meta' que já é mantido pelo ConversationThread.
  const visibleConversations = useMemo(() => {
    if (!selectedConversationId) return conversations;
    if (conversations.some((c) => c.id === selectedConversationId)) return conversations;
    const cached = queryClient.getQueryData<Conversation | undefined>([
      'conversation',
      selectedConversationId,
      'sidepanel-meta',
    ]);
    if (!cached) return conversations;
    return [{ ...cached, __outOfFilter: true } as Conversation, ...conversations];
  }, [conversations, selectedConversationId, queryClient]);

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

  // Onda 1.1: subset dos filtros que ficam dentro do dropdown "Filtros
  // avancados" (badge no ícone SlidersHorizontal). status/assignee/search
  // ficam visiveis fora e nao contam aqui.
  const advancedActiveCount = useMemo(() => {
    let c = 0;
    if (filters.teamId !== 'all') c += 1;
    if (filters.inboxId !== 'all') c += 1;
    if (filters.priority !== 'all') c += 1;
    if (filters.labelId !== 'all') c += 1;
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
    // BUG-CHAT-OVERFLOW: `w-full min-w-0` evita que o min-content do header
    // (grid 2-col com Selects) estoure os 320px da coluna pai (aside no
    // AdminChatPage). Sem isso, o card da conversa selecionada cresce para
    // ~412px e sobrepoe a thread do meio com bg-primary/10.
    <div className="flex h-full w-full min-w-0 flex-col border-r border-border bg-card">
      {/* Cabeçalho + busca */}
      <div className="border-b border-border p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            Conversas {total > 0 && <span className="text-muted-foreground">({total})</span>}
          </h2>
          <div className="flex items-center gap-1.5">
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

        {/* Onda 1.1 (layout Chatwoot-style): tabs assignee + status pills +
            dropdown filtros avancados. Substitui o grid 2-col de 6 selects
            empilhados — mesma state shape (filters/setFilters), so reorganiza
            visualmente. */}
        <Tabs
          value={filters.assignee}
          onValueChange={(v) =>
            setFilters((f) => ({ ...f, assignee: v as AssigneeFilter }))
          }
        >
          <TabsList className="grid grid-cols-3 w-full h-8 gap-0.5">
            <TabsTrigger
              value="me"
              className="text-[11px] h-7 px-1 min-w-0 truncate"
              title="Minhas conversas"
            >
              <span className="truncate">Minhas</span>
            </TabsTrigger>
            <TabsTrigger
              value="unassigned"
              className="text-[11px] h-7 px-1 min-w-0 truncate"
              title="Não atribuídas"
            >
              <span className="truncate">Não atrib.</span>
            </TabsTrigger>
            <TabsTrigger
              value="all"
              className="text-[11px] h-7 px-1 min-w-0 truncate"
              title="Todas as conversas"
            >
              <span className="truncate">Todas</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* QA-UI (painel 360px): trocado overflow-x-auto por flex-wrap pra
            evitar que pills sejam cortadas ou que o pill ativo "salte" sobre
            os vizinhos quando o scroll horizontal era quase invisivel. Usa
            transition-colors (nao transition-all) pra impedir transform/scale
            jump no estado active. */}
        <div className="flex items-center flex-wrap gap-1.5 pb-0.5">
          {(['open', 'pending', 'resolved', 'snoozed', 'all'] as StatusFilter[]).map(
            (s) => {
              const active = filters.status === s;
              const label =
                s === 'all'
                  ? 'Todas'
                  : STATUS_LABEL[s as ConversationStatus];
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilters((f) => ({ ...f, status: s }))}
                  className={cn(
                    'shrink-0 h-6 px-2.5 text-[11px] rounded-full border transition-colors',
                    active
                      ? 'bg-primary/15 text-primary border-primary font-medium'
                      : 'border-transparent text-muted-foreground hover:bg-muted/60'
                  )}
                >
                  {label}
                </button>
              );
            }
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 ml-auto shrink-0 relative"
                title="Filtros avançados"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                {advancedActiveCount > 0 && (
                  <span className="absolute -top-1 -right-1 text-[9px] bg-primary text-primary-foreground rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-1">
                    {advancedActiveCount}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 p-2 space-y-2">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground px-1 py-0">
                Filtros avançados
              </DropdownMenuLabel>
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
            </DropdownMenuContent>
          </DropdownMenu>
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

      {/* Lista.
          BUG-CHAT-OVERFLOW: o Viewport interno do Radix ScrollArea coloca um
          wrapper `<div style="min-width:100%; display:table">`. Esse
          `display:table` faz shrink-wrap pelo min-content do filho — entao,
          mesmo com `min-w-0` em todos os ancestrais, o botao da conversa
          consegue expandir o wrapper alem dos 320px da coluna. Forcamos
          `block` para neutralizar o table-shrink-wrap. */}
      <ScrollArea className="flex-1 [&>[data-radix-scroll-area-viewport]>div]:!block">
        {listQuery.isLoading ? (
          // C2 — Skeleton rows (5) imitando o card real (avatar + 2 linhas)
          // dão sensação concreta de "tem conteúdo vindo" em vez do spinner
          // genérico que parecia um erro/lentidão.
          <div className="space-y-2 p-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
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
        ) : visibleConversations.length === 0 ? (
          activeFiltersCount > 0 ? (
            <EmptyState
              icon={<SearchX className="w-10 h-10" />}
              title={
                filters.search.trim()
                  ? 'Nenhuma conversa para essa busca'
                  : 'Nenhuma conversa corresponde aos filtros'
              }
              description="Ajuste a busca ou os filtros para ver mais resultados."
              action={
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  Limpar filtros
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<InboxIcon className="w-10 h-10" />}
              title="Nenhuma conversa ainda"
              description="As conversas dos seus canais conectados aparecerao aqui."
            />
          )
        ) : (
          // BUG-CHAT-OVERFLOW: `min-w-0` impede que o min-content do card
          // (avatar + badges) estoure a largura da coluna pai. Sem isso, o
          // botao individual fica com ~411px mesmo dentro do aside de 320px.
          <div className="divide-y divide-border min-w-0">
            {visibleConversations.map((conv) => {
              const isSelected = conv.id === selectedConversationId;
              const isOutOfFilter = Boolean((conv as Conversation & { __outOfFilter?: boolean }).__outOfFilter);
              const contactName = conv.contact?.nome || conv.contact?.telefone || 'Sem nome';
              const avatarInitials = getContactInitials(
                conv.contact?.nome,
                conv.contact?.telefone
              );
              const snippet = lastMessageSnippet(conv);
              const lastUpdate = relativeTime(conv.updatedAt);

              return (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => onSelectConversation(conv.id)}
                  aria-current={isSelected ? 'true' : undefined}
                  aria-selected={isSelected}
                  data-state={isSelected ? 'active' : 'inactive'}
                  className={cn(
                    'relative flex w-full items-start gap-2 p-3 text-left transition-colors border-l-2 border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                    !isSelected && 'hover:bg-muted/60 dark:hover:bg-muted/40',
                    isSelected && 'bg-primary/10 border-l-primary dark:bg-primary/15'
                  )}
                >
                  <Avatar className="h-9 w-9 shrink-0">
                    {conv.contact?.profilePicUrl ? (
                      <AuthAvatarImage
                        src={conv.contact.profilePicUrl}
                        alt={contactName}
                      />
                    ) : null}
                    <AvatarFallback
                      className={cn(
                        'text-xs text-primary',
                        isSelected ? 'bg-primary/20 dark:bg-primary/25' : 'bg-primary/10'
                      )}
                    >
                      {avatarInitials ?? <Phone className="w-4 h-4" />}
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
                      {isOutOfFilter && (
                        <Badge
                          variant="outline"
                          className="text-[9px] py-0 px-1 h-4 border-dashed text-muted-foreground"
                          title="Conversa selecionada mas fora dos filtros atuais"
                        >
                          Fora do filtro
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
