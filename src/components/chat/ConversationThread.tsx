/**
 * ConversationThread — T-022 Sprint 4
 *
 * Coluna central do chat: header com ações + lista de mensagens agrupadas por
 * dia + composer. Auto-scroll para a última mensagem; markAsRead após 2s de
 * exibição. Bubbles alinhados conforme `senderType` (customer à esquerda,
 * agent/system à direita). Notas privadas com fundo amarelo. Reply quote.
 * Indicador entregue/lida via checks.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  MessageSquare,
  CornerUpLeft,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import {
  conversationsBackendService,
  type Conversation,
  type Message,
} from '@/services/conversations.backend.service';
import { chatSocket } from '@/services/socket.client';
import { tokenManager } from '@/api/client';
import { ConversationActions } from './ConversationActions';
import { MessageComposer } from './MessageComposer';
import { AttachmentRenderer } from './AttachmentRenderer';

const STATUS_LABEL: Record<Conversation['status'], string> = {
  open: 'Aberta',
  pending: 'Pendente',
  resolved: 'Resolvida',
  snoozed: 'Adiada',
};

const STATUS_COLOR: Record<Conversation['status'], string> = {
  open: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
  resolved: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  snoozed: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
};

const PRIORITY_LABEL: Record<Conversation['priority'], string> = {
  urgent: 'Urgente',
  high: 'Alta',
  medium: 'Média',
  low: 'Baixa',
};

function getInitials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function formatHour(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatDayHeader(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Hoje';
  if (sameDay(d, yesterday)) return 'Ontem';
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function groupByDay(messages: Message[]): Array<{ day: string; items: Message[] }> {
  const groups = new Map<string, Message[]>();
  for (const msg of messages) {
    const key = formatDayHeader(msg.createdAt);
    const arr = groups.get(key) ?? [];
    arr.push(msg);
    groups.set(key, arr);
  }
  return Array.from(groups.entries()).map(([day, items]) => ({ day, items }));
}

function statusIcon(status: Message['status']) {
  switch (status) {
    case 'sending':
      return <Clock className="w-3 h-3" />;
    case 'sent':
      return <Check className="w-3 h-3" />;
    case 'delivered':
      return <CheckCheck className="w-3 h-3" />;
    case 'read':
      return <CheckCheck className="w-3 h-3 text-blue-500" />;
    case 'failed':
      return <AlertCircle className="w-3 h-3 text-destructive" />;
    default:
      return null;
  }
}

interface ConversationThreadProps {
  conversationId: string;
}

export function ConversationThread({ conversationId }: ConversationThreadProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const conversationQuery = useQuery({
    // BUG-3: queryKey com sufixo 'thread-full' (COM messages) — isolado da
    // queryKey 'sidepanel-meta' (SEM messages) usada pelo ContactSidePanel/
    // AdminChatPage. Sem o isolamento, as duas queries colidiam na mesma
    // entrada de cache e a resposta sem messages podia sobrescrever a com
    // messages, fazendo a thread piscar "Nenhuma mensagem ainda" no meio
    // da conversa.
    queryKey: ['conversation', conversationId, 'thread-full'],
    queryFn: () =>
      conversationsBackendService.getConversation(conversationId, {
        messages: true,
        labels: true,
        participants: true,
      }),
    enabled: Boolean(conversationId),
    // BUG-MSG-GHOST: fail-safe sobre o shape do backend. Mesmo com o backend
    // garantindo `messages: []` quando nao incluido, blindamos aqui contra
    // qualquer payload futuro que possa vir `messages: undefined` (versoes
    // antigas de servidor, caches stale do CDN, etc). NUNCA renderizamos
    // thread sem o campo messages como array.
    select: (data) => ({
      ...data,
      messages: Array.isArray(data?.messages) ? data.messages : [],
      labels: Array.isArray(data?.labels) ? data.labels : [],
      participants: Array.isArray(data?.participants) ? data.participants : [],
    }),
    // BUG-5: refetch a cada 60s (antes 15s). Socket.IO ja entrega novas
    // mensagens em tempo real, entao o polling so serve como fallback
    // defensivo em caso de desconexao do socket. Reduzir a frequencia
    // evita re-render desnecessario que faz a ScrollArea perder posicao
    // e mostrar empty state momentaneo durante o refetch.
    refetchInterval: 60_000,
    // BUG-5: mantem dados anteriores enquanto o refetch acontece, evitando
    // o flash de "Nenhuma mensagem ainda" e queda momentanea da lista para
    // [] durante a transicao de fetch. Forma explicita (prev) => prev
    // garante que TROCA de conversationId tambem mantenha o ultimo cache
    // valido visivel ate o novo fetch resolver (em vez de empty state).
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    // BUG-2 (race residual): mantem o cache em memoria por toda a vida da
    // pagina. Sem isso, o React Query pode descartar o cache durante
    // remounts curtos (ex.: troca rapida de conversa e volta), forcando
    // refetch a partir do zero — e nesse intervalo a thread piscaria
    // "Nenhuma mensagem ainda" mesmo com o keepPreviousData.
    gcTime: Number.POSITIVE_INFINITY,
  });

  const markAsReadMutation = useMutation({
    mutationFn: () => conversationsBackendService.markAsRead(conversationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Erro ao marcar como lida';
      toast({ title: 'Falha', description: message, variant: 'destructive' });
    },
  });

  // Marca como lida após 2s na thread (apenas se houver unreadCount)
  const [markedReadFor, setMarkedReadFor] = useState<string | null>(null);
  useEffect(() => {
    if (!conversationId) return;
    const unread = conversationQuery.data?.unreadCount ?? 0;
    if (unread <= 0) return;
    if (markedReadFor === conversationId) return;
    const handle = setTimeout(() => {
      markAsReadMutation.mutate();
      setMarkedReadFor(conversationId);
    }, 2_000);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, conversationQuery.data?.unreadCount]);

  // Reset do marker quando trocar de conversa
  useEffect(() => {
    setMarkedReadFor(null);
  }, [conversationId]);

  // BUG-5: Preserva scroll position entre refetchs.
  // Salvamos scrollTop ANTES do re-render (via ref) e restauramos DEPOIS,
  // somente quando o numero de mensagens NAO mudou (= refetch sem msg nova).
  // Quando a lista cresce (mensagem nova chegou), deixamos o efeito de
  // auto-scroll abaixo levar pra ultima.
  const prevMessageCountRef = useRef<number>(0);
  const savedScrollTopRef = useRef<number | null>(null);
  const currentMessageCount = conversationQuery.data?.messages?.length ?? 0;

  // Antes do paint: capturamos o scrollTop atual ANTES do React reconciliar.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    savedScrollTopRef.current = el.scrollTop;
  });

  // Depois do paint: se a quantidade de mensagens NAO mudou (refetch silencioso),
  // restauramos a posicao salva. Se mudou, o useEffect de auto-scroll abaixo
  // levara pra ultima mensagem.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = prevMessageCountRef.current;
    if (
      prev === currentMessageCount &&
      savedScrollTopRef.current !== null &&
      currentMessageCount > 0
    ) {
      el.scrollTop = savedScrollTopRef.current;
    }
    prevMessageCountRef.current = currentMessageCount;
  }, [currentMessageCount]);

  // Auto-scroll quando lista CRESCER (mensagem nova)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
  }, [currentMessageCount]);

  // ============================================
  // Socket.IO — real-time updates (T-022 Sprint 4)
  // ============================================
  // Typing indicator state: usuários (exceto eu) que estão digitando agora.
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const typingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  useEffect(() => {
    if (!conversationId) return;
    const token = tokenManager.getToken();
    if (!token) return;

    // Captura o map de timers num local para o cleanup (evita warning
    // 'react-hooks/exhaustive-deps' de ref que pode mudar entre passes).
    const timers = typingTimersRef.current;

    // Garante conexão (idempotente) e entra na sala da conversa
    chatSocket.connect(token);
    chatSocket.joinConversation(conversationId);

    // Nova mensagem: aplicamos o payload do socket DIRETO no cache via
    // setQueryData (merge + dedup) — sem refetch. Isto resolve o Bug 1
    // ("mensagem nao aparece imediatamente"): o invalidateQueries antigo
    // disparava um GET /conversations/:id que demorava 100-500ms; nesse
    // intervalo a UI ficava sem a mensagem recem-enviada. Com merge local,
    // a thread atualiza no mesmo tick em que o evento chega.
    //
    // Dedup combinado:
    //  1) por `id` real (caso de eventos duplicados — multi-tab, reconnect)
    //  2) por `metadata.pendingExternalId` (substitui a otimistica enviada
    //     pelo MessageComposer enquanto o POST estava em voo)
    //  3) por `externalId` quando preenchido (Evolution fromMe=true que
    //     vem antes da nossa resposta HTTP)
    //
    // Fallback: se o payload nao trouxer `message` valida (versoes antigas
    // do servidor), caimos no invalidateQueries — comportamento anterior.
    const offMessage = chatSocket.onMessageCreated((payload) => {
      if (payload.conversationId !== conversationId) return;

      const incoming = payload.message as Message | undefined | null;
      const hasValidMessage =
        incoming &&
        typeof incoming === 'object' &&
        typeof (incoming as Message).id === 'string';

      if (hasValidMessage) {
        queryClient.setQueryData<Conversation | undefined>(
          ['conversation', conversationId, 'thread-full'],
          (old) => {
            // BUG-MSG-GHOST: guard contra cache inexistente/corrompido.
            // Se old.messages nao for array (cache em estado quebrado), nao
            // tentamos merge — deixa o React Query refazer fetch limpo na
            // proxima vez. Pior caso: a mensagem nova so aparece no polling.
            if (!old) return old;
            if (!Array.isArray(old.messages)) return old;
            const existing = old.messages;
            const incomingMeta = (incoming.metadata ?? null) as
              | Record<string, unknown>
              | null;
            const incomingPending =
              typeof incomingMeta?.pendingExternalId === 'string'
                ? (incomingMeta.pendingExternalId as string)
                : null;

            // Match optimistic message: id que comeca com 'optimistic:' E
            // (a) mesmo conteudo/sender, OU (b) metadata.matchingPending bate
            // com pendingExternalId. Substituicao no LUGAR (preserva ordem).
            let replaced = false;
            const merged = existing.map((m) => {
              if (m.id === incoming.id) {
                replaced = true;
                return incoming;
              }
              if (
                m.id.startsWith('optimistic:') &&
                m.senderType === incoming.senderType &&
                m.content === incoming.content &&
                !replaced
              ) {
                replaced = true;
                return incoming;
              }
              if (incomingPending) {
                const mMeta = (m.metadata ?? null) as
                  | Record<string, unknown>
                  | null;
                if (
                  typeof mMeta?.optimisticPendingId === 'string' &&
                  (mMeta.optimisticPendingId as string) === incomingPending &&
                  !replaced
                ) {
                  replaced = true;
                  return incoming;
                }
              }
              if (
                incoming.externalId &&
                m.externalId &&
                m.externalId === incoming.externalId
              ) {
                replaced = true;
                return incoming;
              }
              return m;
            });

            if (!replaced) {
              // Mantém ordem cronológica ao anexar (Evolution pode entregar
              // mensagens fora de ordem em retries; o backend ordena por
              // createdAt na hidratação inicial, então precisamos respeitar
              // o mesmo critério aqui).
              // T2-MSG-ORDER: tiebreaker por id quando createdAt colide
              // (mesmo ms — comum em respostas IA multi-parte ou cargas com
              // bursts paralelos). Sem o tiebreaker, mensagens com timestamp
              // idêntico ficavam fora de ordem entre F5/realtime.
              merged.push(incoming);
              merged.sort((a, b) => {
                const cmp = a.createdAt.localeCompare(b.createdAt);
                if (cmp !== 0) return cmp;
                return a.id.localeCompare(b.id);
              });
            }
            return { ...old, messages: merged };
          }
        );
        // BUG-4: NÃO invalidamos 'sidepanel-meta' nem ['conversations'] aqui —
        // o ConversationList já tem listener próprio em message:created que
        // invalida a lista lateral (snippet/unread/updatedAt). Sidepanel-meta
        // não precisa refetch em cada mensagem (não depende de messages, e
        // unreadCount é exibido pela lista, não pelo sidepanel). Invalidar
        // aqui também causaria os refetches duplos que produziam Bug 2
        // (oscilação do nome) e Bug 3 (flash de "Nenhuma mensagem ainda").
      } else {
        // Payload incompleto — fallback APENAS para o thread-full
        // (componente atual). Sidepanel-meta e ['conversations'] são
        // responsabilidade do ConversationList.
        queryClient.invalidateQueries({
          queryKey: ['conversation', conversationId, 'thread-full'],
        });
      }
    });

    // BUG-2 (race residual): Mudancas na conversa (assign, status, priority,
    // etc.) NAO devem invalidar a queryKey 'thread-full' — invalidate dispara
    // um GET /conversations/:id?messages=true que demora 100-500ms e, nesse
    // intervalo, mesmo com keepPreviousData, o `conversationQuery.isFetching`
    // sobe e a thread pode oscilar. Em vez disso, fazemos um MERGE PARCIAL no
    // cache aplicando SOMENTE os campos do payload (status/priority/assignee/
    // etc), preservando `messages`, `labels`, `participants` que ja temos.
    //
    // Se o payload nao trouxer o objeto `conversation`/`assignee` valido
    // (versoes antigas do backend), caimos no invalidateQueries como
    // fallback — comportamento anterior.
    const isPartialConversation = (
      value: unknown
    ): value is Partial<Conversation> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);

    const offConvUpdate = chatSocket.onConversationUpdated((payload) => {
      if (payload.conversationId !== conversationId) return;
      const partial = (payload as { conversation?: unknown }).conversation;
      if (isPartialConversation(partial)) {
        queryClient.setQueryData<Conversation | undefined>(
          ['conversation', conversationId, 'thread-full'],
          (old) => {
            // BUG-MSG-GHOST (fail-safe 1): se nao temos cache valido OU se o
            // cache foi corrompido em algum merge anterior (messages nao-array),
            // RECUSAMOS o merge — retorna `old` (talvez undefined) e deixamos
            // o proximo refetch reidratar do zero. Melhor mostrar loading do
            // que sobrescrever cache com payload incompleto.
            if (!old) return old;
            if (!Array.isArray(old.messages)) return old;
            // BUG-MSG-GHOST (fail-safe 2): NUNCA aceitar `messages` do payload
            // de conversation:updated. Eventos dessa categoria nao trazem
            // mensagens novas — apenas mudancas de status/priority/assignee.
            // Qualquer array vindo no partial (mesmo length=1 vindo do
            // FULL_CONVERSATION_INCLUDE do backend, mesmo []) sobrescreveria
            // a thread completa via spread. Mesmo padrao para labels e
            // participants: so aceitamos se vierem como array; caso contrario
            // preservamos o cache.
            const partialAny = partial as Partial<Conversation> & {
              messages?: unknown;
              labels?: unknown;
              participants?: unknown;
            };
            const { messages: _ignoredMsgs, ...partialSafe } = partialAny;
            const next: Conversation = { ...old, ...partialSafe };
            next.messages = old.messages; // forca preservar SEMPRE
            next.labels = Array.isArray(partialAny.labels)
              ? (partialAny.labels as Conversation['labels'])
              : old.labels;
            next.participants = Array.isArray(partialAny.participants)
              ? (partialAny.participants as Conversation['participants'])
              : old.participants;
            return next;
          }
        );
      } else {
        // Payload mal-formado: NAO invalidamos a queryKey thread-full (isso
        // dispararia refetch que pode demorar 100-500ms e piscar a UI).
        // Ignoramos silenciosamente — o polling de fallback (60s) e o
        // proximo evento valido reidratam.
      }
    });

    const offAssigned = chatSocket.onAssigned((payload) => {
      if (payload.conversationId !== conversationId) return;
      const assignee = (payload as { assignee?: unknown }).assignee;
      // Aceita tanto objeto (novo assignee) quanto null (desatribuir).
      if (assignee === null || isPartialConversation(assignee)) {
        queryClient.setQueryData<Conversation | undefined>(
          ['conversation', conversationId, 'thread-full'],
          (old) => {
            // BUG-MSG-GHOST: guard — nao mexer em cache vazio/corrompido.
            if (!old) return old;
            if (!Array.isArray(old.messages)) return old;
            const typed = assignee as Conversation['assignee'] | null;
            // BUG-MSG-GHOST: o payload de socket de assigned do backend hoje
            // vem como { type: 'agent'|'team', assigneeId } ou similar — NAO
            // tem `.id` nesse shape, e o codigo antigo zerava assigneeId.
            // Mantemos o comportamento antigo apenas quando o payload eh
            // null (desatribuir) ou contem `.id`. Para qualquer outro shape
            // (objeto sem `.id`), ignoramos e deixamos o proximo
            // conversation:updated (que vem logo depois) atualizar.
            const hasValidId =
              typed === null || (typed && typeof (typed as { id?: unknown }).id === 'string');
            if (!hasValidId) return old;
            return {
              ...old,
              assignee: typed,
              assigneeId: typed ? ((typed as { id: string }).id) : null,
              // Preserva relacoes pesadas — defesa em profundidade.
              messages: old.messages,
              labels: old.labels,
              participants: old.participants,
            };
          }
        );
      }
      // Payload mal-formado: ignora silenciosamente (sem invalidate que
      // causaria refetch e piscar). O cache se mantem ate proximo evento
      // ou polling.
    });

    // Typing de outros usuários (ignora o próprio)
    const offTyping = chatSocket.onTyping((payload) => {
      if (payload.conversationId !== conversationId) return;
      if (!payload.userId || payload.userId === user?.id) return;

      // limpa timer anterior (se houver) e adiciona/remove o user
      const prevTimer = timers.get(payload.userId);
      if (prevTimer) clearTimeout(prevTimer);

      if (payload.isTyping) {
        setTypingUsers((prev) => {
          const next = new Set(prev);
          next.add(payload.userId);
          return next;
        });
        // Auto-expira após 3s se não vier "false" — protege contra
        // perda do evento de parada.
        const timer = setTimeout(() => {
          setTypingUsers((prev) => {
            const next = new Set(prev);
            next.delete(payload.userId);
            return next;
          });
          timers.delete(payload.userId);
        }, 3_000);
        timers.set(payload.userId, timer);
      } else {
        setTypingUsers((prev) => {
          const next = new Set(prev);
          next.delete(payload.userId);
          return next;
        });
        timers.delete(payload.userId);
      }
    });

    return () => {
      offMessage();
      offConvUpdate();
      offAssigned();
      offTyping();
      chatSocket.leaveConversation(conversationId);
      // Limpa typing state e timers ao trocar de conversa
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      setTypingUsers(new Set());
    };
  }, [conversationId, queryClient, user?.id]);

  const conversation = conversationQuery.data ?? null;
  const messages = useMemo(
    () => conversation?.messages ?? [],
    [conversation?.messages]
  );
  const grouped = useMemo(() => groupByDay(messages), [messages]);

  if (conversationQuery.isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (conversationQuery.isError || !conversation) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
        <AlertCircle className="w-8 h-8 text-destructive" />
        <p className="text-sm">Não foi possível carregar a conversa</p>
        <Button variant="link" size="sm" onClick={() => conversationQuery.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  const contactName =
    conversation.contact?.nome || conversation.contact?.telefone || 'Sem nome';

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header — altura fixa (shrink-0) para não comprimir a área de mensagens */}
      <div className="shrink-0 flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2.5 shadow-sm min-w-0">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <Avatar className="h-9 w-9 shrink-0">
            <AvatarFallback className="text-sm bg-primary/10 text-primary">
              {getInitials(contactName)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate text-foreground">
              {contactName}
            </p>
            <div className="flex items-center gap-1 overflow-hidden text-[11px] text-muted-foreground min-w-0">
              <Badge
                variant="outline"
                className={cn('text-[10px] py-0 px-1 h-4 border-0 shrink-0', STATUS_COLOR[conversation.status])}
              >
                {STATUS_LABEL[conversation.status]}
              </Badge>
              <span className="shrink-0">•</span>
              <span className="shrink-0">P: {PRIORITY_LABEL[conversation.priority]}</span>
              {conversation.assignee?.nome && (
                <>
                  <span className="shrink-0">•</span>
                  <span className="shrink-0 truncate max-w-[80px]">{conversation.assignee.nome}</span>
                </>
              )}
              {conversation.inbox?.name && (
                <>
                  <span className="shrink-0">•</span>
                  <span className="truncate min-w-0 capitalize">{conversation.inbox.name}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="shrink-0">
          <ConversationActions conversation={conversation} />
        </div>
      </div>

      {/* Mensagens — flex-1 + min-h-0 garante que a ScrollArea não vaze */}
      <ScrollArea className="flex-1 min-h-0" ref={scrollRef as never}>
        <div
          ref={(el) => {
            // ScrollArea encapsula o viewport; usamos o div interno para scrollTo.
            if (el && !scrollRef.current) {
              const viewport = el.closest('[data-radix-scroll-area-viewport]');
              if (viewport instanceof HTMLDivElement) {
                scrollRef.current = viewport;
              }
            }
          }}
          className="p-4 space-y-4"
        >
          {messages.length === 0 && !conversationQuery.isFetching ? (
            // BUG-2 (race residual): so mostramos o empty state quando a
            // query NAO esta em refetch. Isso evita o flash de "Nenhuma
            // mensagem ainda" durante o intervalo entre o invalidate (ou
            // socket-driven refresh) e a chegada da resposta — caso em
            // que `messages` cai para [] por um frame antes do
            // keepPreviousData entrar em acao.
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <MessageSquare className="w-10 h-10 mb-2 opacity-30" />
              <p className="text-sm">Nenhuma mensagem ainda</p>
              <p className="text-xs mt-1">Envie a primeira mensagem para o cliente</p>
            </div>
          ) : messages.length === 0 ? (
            // Refetch em andamento e sem dados ainda — placeholder discreto
            // que NAO promete "nenhuma mensagem" (a query ainda esta voando).
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin opacity-50" />
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.day} className="space-y-3">
                <div className="sticky top-0 z-10 flex justify-center">
                  <Badge
                    variant="secondary"
                    className="text-[10px] px-2 py-0 h-5 rounded-full"
                  >
                    {group.day}
                  </Badge>
                </div>
                {group.items.map((msg) => {
                  const isCustomer = msg.senderType === 'customer';
                  const isSystem = msg.senderType === 'system';
                  const isPrivate = msg.isPrivate;
                  const replyMsg = msg.replyToId
                    ? messages.find((m) => m.id === msg.replyToId)
                    : null;

                  if (isSystem) {
                    return (
                      <div key={msg.id} className="flex justify-center">
                        <div className="text-[11px] text-muted-foreground italic max-w-md text-center">
                          {msg.content}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={msg.id}
                      className={cn(
                        'flex w-full',
                        isCustomer ? 'justify-start' : 'justify-end'
                      )}
                    >
                      <div
                        className={cn(
                          'max-w-[80%] rounded-lg px-3 py-2 space-y-1.5',
                          isPrivate
                            ? 'bg-yellow-100 dark:bg-yellow-900/40 border border-yellow-400/40'
                            : isCustomer
                              ? 'bg-muted text-foreground'
                              : 'bg-primary text-primary-foreground'
                        )}
                      >
                        {isPrivate && (
                          <div className="flex items-center gap-1 text-[10px] text-yellow-800 dark:text-yellow-200 font-medium uppercase">
                            <CornerUpLeft className="w-3 h-3" />
                            Nota interna
                          </div>
                        )}
                        {replyMsg && (
                          <div
                            className={cn(
                              'border-l-2 pl-2 text-[11px] opacity-80',
                              isCustomer ? 'border-primary' : 'border-primary-foreground/40'
                            )}
                          >
                            <p className="font-medium">
                              {replyMsg.senderType === 'customer' ? 'Cliente' : 'Agente'}
                            </p>
                            <p className="line-clamp-2">{replyMsg.content || '—'}</p>
                          </div>
                        )}
                        {msg.content && (
                          <p className="text-sm whitespace-pre-wrap break-words">
                            {msg.content}
                          </p>
                        )}
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="space-y-1.5">
                            {msg.attachments.map((att) => (
                              <AttachmentRenderer key={att.id} attachment={att} />
                            ))}
                          </div>
                        )}
                        <div
                          className={cn(
                            'flex items-center gap-1 text-[10px]',
                            isCustomer
                              ? 'text-muted-foreground justify-start'
                              : 'text-primary-foreground/80 justify-end'
                          )}
                        >
                          <span>{formatHour(msg.createdAt)}</span>
                          {!isCustomer && statusIcon(msg.status)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Indicador de digitação (outros usuários) */}
      {typingUsers.size > 0 && (
        <div className="border-t border-border bg-card px-3 py-1 text-[11px] italic text-muted-foreground">
          {typingUsers.size === 1
            ? 'Um usuário está digitando...'
            : `${typingUsers.size} usuários estão digitando...`}
        </div>
      )}

      {/* Composer */}
      <MessageComposer
        conversationId={conversationId}
        // BUG-1: removido invalidateQueries aqui. O proprio MessageComposer ja
        // aplica optimistic update no cache + onSuccess substitui pelo real,
        // e o socket onMessageCreated faz merge final. Invalidar aqui causava
        // refetch redundante que (em rede lenta) zerava a thread por um frame.
        onMessageSent={() => {}}
      />
    </div>
  );
}

export default ConversationThread;
