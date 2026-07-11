/**
 * ConversationThread — T-022 Sprint 4 + CHAT-REPLY-EDIT-DEL + CHAT-REACTIONS
 *
 * Coluna central do chat: header com ações + lista de mensagens agrupadas por
 * dia + composer. Auto-scroll para a última mensagem; markAsRead após 2s de
 * exibição. Bubbles alinhados conforme `senderType` (customer à esquerda,
 * agent/system à direita). Notas privadas com fundo amarelo. Reply quote.
 * Indicador entregue/lida via checks.
 *
 * CHAT-REPLY-EDIT-DEL: bubble ganha menu contextual (Responder / Editar /
 * Apagar). Responder → passa msg pro composer como quote; Editar → textarea
 * inline; Apagar → AlertDialog + PATCH backend (soft delete).
 *
 * CHAT-REACTIONS: menu ganha "Reagir" (popover com 6 emojis). Pill abaixo do
 * bubble mostra agregado por emoji. Click toggla (POST/DELETE). Reactions
 * ficam em Map<msgId, aggregate[]> local (não hidratamos no mount — sem
 * endpoint batch), atualizadas via mutations.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  AlertCircle,
  MessageSquare,
  Loader2,
  ArrowLeft,
  Phone,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { AuthAvatarImage } from '@/components/chat/AuthAvatarImage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
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
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import {
  conversationsBackendService,
  type Conversation,
  type Message,
  type MessageReactionServerAggregate,
} from '@/services/conversations.backend.service';
import {
  messagesBackendService,
  aggregateReactions,
  type MessageReactionAggregate,
} from '@/services/messages.backend.service';
import { chatSocket } from '@/services/socket.client';
import { tokenManager } from '@/api/client';
import { ConversationActions } from './ConversationActions';
import { MessageComposer } from './MessageComposer';
import { MessageBubble } from './MessageBubble';

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

/**
 * Iniciais para o avatar do header de conversa. Retorna `null` quando o nome
 * é apenas o telefone (contato sem identificação) — nesse caso o caller deve
 * renderizar um ícone `<Phone />` em vez de exibir o primeiro dígito do
 * telefone como "inicial" (BUG-CHAT-AVATAR-DIGIT).
 */
function getContactInitials(
  name: string | null | undefined,
  telefone?: string | null
): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  if (telefone && trimmed === telefone) return null;
  if (/^\d/.test(trimmed)) return null;
  return trimmed
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
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

/**
 * CHAT-REACTIONS FURO 2: converte o aggregate server-side (sem `byMe`)
 * para o shape consumido pelo MessageBubble. `byMe` é derivado do
 * currentUserId — o backend NÃO conhece o solicitante nas rotas
 * list()/get() (viria a custo extra de contexto no include).
 */
function toClientAggregate(
  server: MessageReactionServerAggregate[] | undefined,
  currentUserId: string | null | undefined
): MessageReactionAggregate[] {
  if (!Array.isArray(server) || server.length === 0) return [];
  return server.map((r) => ({
    emoji: r.emoji,
    count: r.count,
    userIds: r.userIds,
    externalContactIds: r.externalContactIds,
    byMe: Boolean(currentUserId) && r.userIds.includes(currentUserId as string),
  }));
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

// formatHour + statusIcon movidos para MessageBubble.tsx (CHAT-REPLY-EDIT-DEL)

interface ConversationThreadProps {
  conversationId: string;
  /**
   * BUG-CRIT-4 (chat mobile): callback opcional para o botao "Voltar" que
   * aparece SOMENTE em viewports <lg. No mobile, a lista de conversas e a
   * thread se alternam (em vez de ficarem lado a lado), entao precisamos
   * de um caminho de volta. Em desktop (lg+) o botao fica escondido via
   * `lg:hidden` e essa prop pode ser omitida sem efeito.
   */
  onBack?: () => void;
}

export function ConversationThread({ conversationId, onBack }: ConversationThreadProps) {
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

  // ============================================
  // SCROLL (reescrito) — modelo robusto em 3 regras.
  // Pre-requisito: scrollRef aponta pro VIEWPORT rolavel do Radix ScrollArea
  // (ver bloco do <ScrollArea> mais abaixo). Antes apontava pra raiz
  // overflow-hidden e TODO scrollTop era no-op — causa real do bug de "abrir
  // conversa e nao ver a ultima mensagem".
  // ============================================
  const currentMessageCount = conversationQuery.data?.messages?.length ?? 0;
  // Com placeholderData:(prev)=>prev, durante a TROCA de conversa o
  // conversationQuery.data ainda e o da conversa ANTERIOR. So agimos quando os
  // dados REAIS da conversa selecionada chegaram (data.id === conversationId).
  const loadedConversationId =
    (conversationQuery.data as { id?: string } | undefined)?.id ?? null;
  const dataMatchesSelected = loadedConversationId === conversationId;

  const prevMessageCountRef = useRef<number>(0);
  const savedScrollTopRef = useRef<number | null>(null);
  // Marca pra qual conversationId ja fizemos o scroll inicial (evita repetir e
  // evita brigar com o scroll de nova-mensagem).
  const initialScrollForRef = useRef<string | null>(null);

  // Reset ao trocar de conversa: permite novo scroll inicial da proxima.
  useEffect(() => {
    initialScrollForRef.current = null;
    prevMessageCountRef.current = 0;
    savedScrollTopRef.current = null;
  }, [conversationId]);

  // Antes do paint: guarda a posicao atual (pra preservar em refetch silencioso).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) savedScrollTopRef.current = el.scrollTop;
  });

  // REGRA 1 — Scroll inicial ao ABRIR/TROCAR de conversa.
  // Dispara UMA vez, quando os dados reais da conversa chegam. Scroll
  // instantaneo pro fim + re-scrolls curtos cobrindo o layout shift de
  // imagens/audios que so ganham altura depois do primeiro paint.
  useLayoutEffect(() => {
    if (!dataMatchesSelected || currentMessageCount === 0) return;
    if (initialScrollForRef.current === conversationId) return;
    const el = scrollRef.current;
    if (!el) return;
    const toBottom = () => {
      el.scrollTop = el.scrollHeight;
    };
    toBottom();
    const timers = [60, 160, 320, 640].map((ms) =>
      window.setTimeout(toBottom, ms)
    );
    initialScrollForRef.current = conversationId;
    prevMessageCountRef.current = currentMessageCount;
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [conversationId, dataMatchesSelected, currentMessageCount]);

  // REGRA 2 — Nova mensagem na conversa JA aberta -> segue pro fim (suave),
  // mas so se o usuario ja estava perto do fim (nao arranca quem leu historico).
  // REGRA 3 — Refetch silencioso sem msg nova -> preserva a posicao.
  useLayoutEffect(() => {
    // So depois do scroll inicial desta conversa (senao briga com a Regra 1).
    if (initialScrollForRef.current !== conversationId) return;
    const el = scrollRef.current;
    if (!el) return;

    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = currentMessageCount;

    if (currentMessageCount > prevCount) {
      // Chegou mensagem nova. Segue pro fim se estava perto do fim.
      const nearBottom =
        (savedScrollTopRef.current ?? 0) + el.clientHeight >=
        el.scrollHeight - 160;
      if (nearBottom) {
        requestAnimationFrame(() =>
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
        );
      }
    } else if (
      currentMessageCount === prevCount &&
      savedScrollTopRef.current !== null
    ) {
      // Refetch silencioso (mesma quantidade) -> nao pula, restaura posicao.
      el.scrollTop = savedScrollTopRef.current;
    }
  }, [conversationId, currentMessageCount]);

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

    // CHAT-REPLY-EDIT-DEL: mutações em mensagem existente (edit/soft delete)
    // chegam em 'message:updated'. PATCH direto na mensagem correspondente
    // no cache do thread — troca content, deletedAt e metadata (edited flag,
    // editedAt, previousContent). NÃO reordena a thread: id e createdAt
    // são preservados. Se a mensagem não estiver no cache (usuário abriu a
    // conversa tarde), ignoramos silenciosamente — o próximo refetch a traz.
    const offMessageUpdated = chatSocket.onMessageUpdated((payload) => {
      if (payload.conversationId !== conversationId) return;
      const incoming = payload.message as Message | undefined | null;
      const hasValidMessage =
        incoming &&
        typeof incoming === 'object' &&
        typeof (incoming as Message).id === 'string';
      if (!hasValidMessage) return;

      queryClient.setQueryData<Conversation | undefined>(
        ['conversation', conversationId, 'thread-full'],
        (old) => {
          if (!old) return old;
          if (!Array.isArray(old.messages)) return old;
          let touched = false;
          const merged = old.messages.map((m) => {
            if (m.id === incoming.id) {
              touched = true;
              // Merge (nao replace): editMessage/softDeleteMessage nao incluem
              // REACTIONS_INCLUDE no include do prisma.update — sem o spread
              // de `m` primeiro, o campo `reactions` da msg sumiria do cache
              // depois de qualquer edit/delete (pill some da UI ate proximo
              // refetch). Padrao consistente com onMessageReactionUpdated.
              return { ...m, ...incoming };
            }
            return m;
          });
          if (!touched) return old;
          return { ...old, messages: merged };
        }
      );
    });

    // CHAT-REACTIONS FURO 2: add/remove de reactions (do agente atual, de
    // outros agentes, ou do cliente via webhook) chegam em
    // 'message:reaction:updated'. Payload traz `reactions` já agregado por
    // emoji — sem precisar refetch. Aplicamos em DOIS lugares:
    //   1) cache do thread (msg.reactions) — persiste entre remounts e
    //      alimenta a hidratação inicial via useEffect abaixo.
    //   2) Map local reactionsByMsg — render imediato do pill (evita esperar
    //      o re-run do useEffect que só dispara quando allMessages muda de
    //      referência).
    const offReactionUpdated = chatSocket.onMessageReactionUpdated((payload) => {
      if (payload.conversationId !== conversationId) return;
      const messageId = payload.messageId;
      if (!messageId) return;
      const server =
        (payload.reactions as MessageReactionServerAggregate[] | undefined) ?? [];

      queryClient.setQueryData<Conversation | undefined>(
        ['conversation', conversationId, 'thread-full'],
        (old) => {
          if (!old) return old;
          if (!Array.isArray(old.messages)) return old;
          let touched = false;
          const merged = old.messages.map((m) => {
            if (m.id === messageId) {
              touched = true;
              return { ...m, reactions: server };
            }
            return m;
          });
          if (!touched) return old;
          return { ...old, messages: merged };
        }
      );

      setReactionsByMsg((prev) => {
        const next = new Map(prev);
        if (server.length === 0) {
          next.delete(messageId);
        } else {
          next.set(messageId, toClientAggregate(server, user?.id));
        }
        return next;
      });
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
      offMessageUpdated();
      offReactionUpdated();
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

  // ============================================
  // CHAT-REPLY-EDIT-DEL + CHAT-REACTIONS — states + mutations
  // ============================================
  // Reply: msg citada quando != null; MessageComposer lê via props e envia
  // o replyToId no POST. Cancelamos ao trocar de conversa ou depois do envio.
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  // Edit inline: id da msg em edição + o texto sendo digitado.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string>('');
  // Delete: msg selecionada para AlertDialog (confirmação).
  const [pendingDeleteMsg, setPendingDeleteMsg] = useState<Message | null>(null);
  // Reactions: agregado por msgId, mantido em Map local. FURO 2: agora o
  // backend retorna `msg.reactions` embutido em list()/get() e emite
  // `message:reaction:updated` no socket. Hidratamos abaixo via useEffect.
  const [reactionsByMsg, setReactionsByMsg] = useState<
    Map<string, MessageReactionAggregate[]>
  >(() => new Map());

  // Reset de todos os states auxiliares ao trocar de conversa — evita que
  // `replyingTo` de uma conversa vaze pra outra (BUG UX comum).
  useEffect(() => {
    setReplyingTo(null);
    setEditingMessageId(null);
    setEditingValue('');
    setPendingDeleteMsg(null);
    setReactionsByMsg(new Map());
  }, [conversationId]);

  // CHAT-REACTIONS FURO 2: hidrata reactionsByMsg a partir do msg.reactions
  // que o backend agora devolve embutido em list()/get(). Isso resolve o
  // caso "F5 = pill some" (sem hidratação, o Map ficava vazio até o próximo
  // toggle do usuário).
  //
  // MERGE que respeita optimistic: para cada msg com reactions server-side,
  // sobrescreve com o server truth (correto). Para msgs sem reactions
  // server-side, NAO apaga entries locais — protege contra a race entre
  // onMutate (optimistic) e o socket message:reaction:updated que vem depois.
  //
  // Depende de `conversationQuery.data?.messages` (não do allMessages memo
  // que ainda não foi definido nesse ponto). A referência muda a cada
  // setQueryData do socket, então uma reaction chegando via socket
  // (message:reaction:updated) que altere msg.reactions no cache também
  // dispara aqui — belt-and-suspenders sobre o handler direto do socket.
  const threadMessages = conversationQuery.data?.messages;
  useEffect(() => {
    if (!Array.isArray(threadMessages) || threadMessages.length === 0) return;
    setReactionsByMsg((prev) => {
      const next = new Map(prev);
      for (const m of threadMessages) {
        const server =
          (m.reactions as MessageReactionServerAggregate[] | undefined) ?? [];
        if (server.length === 0) continue;
        next.set(m.id, toClientAggregate(server, user?.id));
      }
      return next;
    });
  }, [threadMessages, user?.id]);

  // ---- Edit ----
  const editMutation = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      messagesBackendService.editMessage(id, content),
    onSuccess: (updated) => {
      // Merge direto no cache — mesma queryKey da thread.
      queryClient.setQueryData<Conversation | undefined>(
        ['conversation', conversationId, 'thread-full'],
        (prev) => {
          if (!prev) return prev;
          if (!Array.isArray(prev.messages)) return prev;
          return {
            ...prev,
            messages: prev.messages.map((m) => (m.id === updated.id ? { ...m, ...updated } : m)),
          };
        }
      );
      setEditingMessageId(null);
      setEditingValue('');
      toast({ title: 'Mensagem editada' });
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Erro ao editar';
      toast({ title: 'Falha ao editar', description: message, variant: 'destructive' });
    },
  });

  function handleReply(msg: Message) {
    setReplyingTo(msg);
    // Cancela edit em andamento se houver — não faz sentido responder e editar
    // simultâneo.
    setEditingMessageId(null);
    setEditingValue('');
  }

  function handleCancelReply() {
    setReplyingTo(null);
  }

  function handleEditStart(msg: Message) {
    setEditingMessageId(msg.id);
    setEditingValue(msg.content ?? '');
    setReplyingTo(null);
  }

  function handleEditCancel() {
    setEditingMessageId(null);
    setEditingValue('');
  }

  function handleEditSave() {
    if (!editingMessageId) return;
    const trimmed = editingValue.trim();
    if (!trimmed) {
      toast({
        title: 'Conteúdo obrigatório',
        description: 'Digite algo antes de salvar.',
        variant: 'destructive',
      });
      return;
    }
    editMutation.mutate({ id: editingMessageId, content: trimmed });
  }

  // ---- Delete ----
  const deleteMutation = useMutation({
    mutationFn: (id: string) => messagesBackendService.deleteMessage(id),
    onSuccess: (updated) => {
      queryClient.setQueryData<Conversation | undefined>(
        ['conversation', conversationId, 'thread-full'],
        (prev) => {
          if (!prev) return prev;
          if (!Array.isArray(prev.messages)) return prev;
          return {
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === updated.id ? { ...m, ...updated } : m
            ),
          };
        }
      );
      setPendingDeleteMsg(null);
      toast({ title: 'Mensagem apagada' });
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Erro ao apagar';
      toast({
        title: 'Falha ao apagar',
        description: message,
        variant: 'destructive',
      });
      setPendingDeleteMsg(null);
    },
  });

  function handleDeleteRequest(msg: Message) {
    setPendingDeleteMsg(msg);
  }

  function handleDeleteConfirm() {
    if (!pendingDeleteMsg) return;
    deleteMutation.mutate(pendingDeleteMsg.id);
  }

  // ---- React (add / remove) ----
  //
  // Cada mutação atualiza `reactionsByMsg` sincronamente antes de disparar
  // (optimistic) e reconcilia com a resposta do backend. Pra minimizar
  // complexidade de rollback, guardamos o snapshot no `ctx`.
  const reactMutation = useMutation<
    unknown,
    Error,
    { msg: Message; emoji: string; action: 'add' | 'remove' },
    { previous: MessageReactionAggregate[] | undefined }
  >({
    mutationFn: ({ msg, emoji, action }) => {
      if (action === 'add') {
        return messagesBackendService.reactMessage(msg.id, emoji);
      }
      return messagesBackendService.removeReaction(msg.id, emoji);
    },
    onMutate: ({ msg, emoji, action }) => {
      const previous = reactionsByMsg.get(msg.id);
      setReactionsByMsg((prev) => {
        const next = new Map(prev);
        const current = prev.get(msg.id) ?? [];
        const idx = current.findIndex((r) => r.emoji === emoji);
        if (action === 'add') {
          if (idx === -1) {
            next.set(msg.id, [
              ...current,
              {
                emoji,
                count: 1,
                userIds: user?.id ? [user.id] : [],
                externalContactIds: [],
                byMe: true,
              },
            ]);
          } else {
            const existing = current[idx];
            // Já tem esse emoji — se byMe true, era um noop (backend upsert),
            // se byMe false, incrementa e marca como meu.
            if (!existing.byMe) {
              const clone = [...current];
              clone[idx] = {
                ...existing,
                count: existing.count + 1,
                userIds: user?.id ? [...existing.userIds, user.id] : existing.userIds,
                byMe: true,
              };
              next.set(msg.id, clone);
            }
          }
        } else {
          if (idx !== -1) {
            const existing = current[idx];
            const nextCount = Math.max(existing.count - 1, 0);
            if (nextCount === 0) {
              next.set(
                msg.id,
                current.filter((_, i) => i !== idx)
              );
            } else {
              const clone = [...current];
              clone[idx] = {
                ...existing,
                count: nextCount,
                userIds: user?.id
                  ? existing.userIds.filter((id) => id !== user.id)
                  : existing.userIds,
                byMe: false,
              };
              next.set(msg.id, clone);
            }
          }
        }
        return next;
      });
      return { previous };
    },
    onError: (err, { msg }, ctx) => {
      // Reverte para o snapshot pré-mutação
      setReactionsByMsg((prev) => {
        const next = new Map(prev);
        if (ctx?.previous) {
          next.set(msg.id, ctx.previous);
        } else {
          next.delete(msg.id);
        }
        return next;
      });
      const message = err instanceof Error ? err.message : 'Erro ao reagir';
      toast({ title: 'Falha na reação', description: message, variant: 'destructive' });
    },
    onSuccess: (_data, { msg }) => {
      // Best-effort: reidrata as reactions dessa msg com o server-side pra
      // captar reactions de outros agentes/clientes que possam ter caído
      // no meio do fluxo. Silencioso em caso de falha.
      messagesBackendService
        .listReactions(msg.id)
        .then((rows) => {
          const agg = aggregateReactions(rows, user?.id ?? null);
          setReactionsByMsg((prev) => {
            const next = new Map(prev);
            if (agg.length === 0) {
              next.delete(msg.id);
            } else {
              next.set(msg.id, agg);
            }
            return next;
          });
        })
        .catch(() => { /* ignore */ });
    },
  });

  function handleReact(msg: Message, emoji: string) {
    reactMutation.mutate({ msg, emoji, action: 'add' });
  }

  function handleUnreact(msg: Message, emoji: string) {
    reactMutation.mutate({ msg, emoji, action: 'remove' });
  }

  const conversation = conversationQuery.data ?? null;
  const allMessages = useMemo(
    () => conversation?.messages ?? [],
    [conversation?.messages]
  );

  // L-CHAT-3: paginacao "Carregar mais" pra mitigar render pesado em threads
  // longas. Antes a thread renderizava todas as bubbles (141 observado, 1000+
  // travava o browser). Agora mostra so as ULTIMAS `visibleCount` msgs;
  // botao no topo carrega +50. Mensagens novas (socket/optimistic) sempre
  // aparecem porque pegamos as ultimas N do array. Virtualizacao real
  // (react-window) fica como follow-up.
  // Bumped from 50 -> 200 apos QA D2: com 50, threads medias (100-200 msgs)
  // exigiam clicar "Carregar mais" logo apos auto-scroll pousar no fim, mas o
  // botao ficava fora do viewport (topo). Com 200 cobrimos a maioria das
  // conversas sem pagineacao visivel. Virtualizacao real fica como follow-up.
  const PAGE_SIZE = 200;
  const [visibleCount, setVisibleCount] = useState<number>(PAGE_SIZE);

  // Reset paginacao ao trocar de conversa — sem isso, abrir uma conversa
  // nova herdaria o visibleCount aumentado da anterior (pequeno bug visual
  // mas inconsistente).
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [conversationId]);

  const totalCount = allMessages.length;
  const hasMore = totalCount > visibleCount;
  const messages = useMemo(() => {
    if (totalCount <= visibleCount) return allMessages;
    // slice das ultimas N preserva a ordem cronologica (mensagens novas
    // sao sempre as ultimas no array, mantidas no merge do socket).
    return allMessages.slice(totalCount - visibleCount);
  }, [allMessages, totalCount, visibleCount]);
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
  const headerAvatarInitials = getContactInitials(
    conversation.contact?.nome,
    conversation.contact?.telefone
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header — altura fixa (shrink-0) para não comprimir a área de mensagens */}
      <div className="shrink-0 flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2.5 shadow-sm min-w-0">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {/* BUG-CRIT-4: botao "Voltar" no header, visivel SO em <lg
              (mobile/tablet portrait). Em desktop, lista e thread ficam lado
              a lado, entao o botao seria redundante. Em mobile, e o unico
              caminho de volta para a lista de conversas. */}
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden h-8 w-8 shrink-0 -ml-2"
              onClick={onBack}
              aria-label="Voltar para lista de conversas"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          {/* Onda 1.2 (layout Chatwoot-style): avatar h-10 (era h-9), nome
              em destaque + canal em LINHA PROPRIA abaixo (era inline com
              demais badges). Status/prioridade/assignee continuam como
              metadata mas em linha separada do canal. */}
          <Avatar className="h-10 w-10 shrink-0">
            {conversation.contact?.profilePicUrl ? (
              <AuthAvatarImage src={conversation.contact.profilePicUrl} alt={contactName} />
            ) : null}
            <AvatarFallback className="text-base bg-primary/10 text-primary">
              {headerAvatarInitials ?? <Phone className="w-4 h-4" />}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate text-foreground leading-tight">
              {contactName}
            </p>
            {conversation.inbox?.name && (
              <p className="text-[11px] text-muted-foreground truncate capitalize leading-tight">
                {conversation.inbox.name}
              </p>
            )}
            <div className="flex items-center gap-1 overflow-hidden text-[11px] text-muted-foreground min-w-0 mt-0.5">
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
            </div>
          </div>
        </div>

        <div className="shrink-0">
          <ConversationActions conversation={conversation} renderResolveOutside />
        </div>
      </div>

      {/* Mensagens — flex-1 + min-h-0 garante que a ScrollArea não vaze.
          BUG-SCROLL (raiz real): o Radix ScrollArea encaminha `ref` para o
          ROOT (overflow-hidden, NAO rola). O elemento rolavel e o VIEWPORT
          interno ([data-radix-scroll-area-viewport], overflow:scroll). Antes
          havia `ref={scrollRef}` na <ScrollArea> E um callback resolvendo o
          viewport — mas o ref do ScrollArea (pai, dispara depois do filho)
          SOBRESCREVIA o viewport pela raiz. Resultado: todo `scrollTop` caia
          num elemento que nao rola -> auto-scroll silenciosamente inope. */}
      <ScrollArea className="flex-1 min-h-0">
        <div
          ref={(el) => {
            // Resolve SEMPRE o viewport rolavel a partir deste div interno.
            // Sem guarda `!scrollRef.current` — o ScrollArea nao seta mais o
            // ref, entao aqui e a unica fonte e deve reatribuir com seguranca.
            if (el) {
              const viewport = el.closest('[data-radix-scroll-area-viewport]');
              scrollRef.current =
                viewport instanceof HTMLDivElement ? viewport : null;
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
            <>
              {/* L-CHAT-3: botao "Carregar mais" no topo. Aparece so quando
                  ha msgs mais antigas escondidas. Click adiciona +PAGE_SIZE
                  msgs ao inicio da lista visivel. O auto-scroll abaixo nao
                  dispara (currentMessageCount nao muda — usa allMessages),
                  entao o scroll fica no topo permitindo ler as msgs novas. */}
              {hasMore && (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() =>
                      setVisibleCount((prev) =>
                        Math.min(prev + PAGE_SIZE, totalCount)
                      )
                    }
                  >
                    Carregar mais ({totalCount - visibleCount} restantes)
                  </Button>
                </div>
              )}
              {grouped.map((group) => (
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
                  const replyMsg = msg.replyToId
                    ? messages.find((m) => m.id === msg.replyToId) ?? null
                    : null;
                  const reactions = reactionsByMsg.get(msg.id);
                  const isEditing = editingMessageId === msg.id;

                  return (
                    <MessageBubble
                      key={msg.id}
                      msg={msg}
                      replyMsg={replyMsg}
                      isCustomer={isCustomer}
                      currentUserId={user?.id ?? null}
                      reactions={reactions}
                      onReply={handleReply}
                      onEdit={handleEditStart}
                      onDelete={handleDeleteRequest}
                      onReact={handleReact}
                      onUnreact={handleUnreact}
                      isEditing={isEditing}
                      editingValue={isEditing ? editingValue : ''}
                      onEditChange={setEditingValue}
                      onEditSave={handleEditSave}
                      onEditCancel={handleEditCancel}
                    />
                  );
                })}
              </div>
              ))}
            </>
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

      {/* Composer — recebe replyingTo pra montar preview + enviar replyToId */}
      <MessageComposer
        // AUDIT-DRAFT-LEAK: sem key, o React reconcilia a MESMA instância ao
        // trocar de conversa e o rascunho (texto/anexos/nota privada) vazava
        // para a conversa seguinte — Enter mandava o texto de A pro contato B.
        // key={conversationId} força remount limpo por conversa.
        key={conversationId}
        conversationId={conversationId}
        replyingTo={replyingTo}
        onCancelReply={handleCancelReply}
        // BUG-1: removido invalidateQueries aqui. O proprio MessageComposer ja
        // aplica optimistic update no cache + onSuccess substitui pelo real,
        // e o socket onMessageCreated faz merge final. Invalidar aqui causava
        // refetch redundante que (em rede lenta) zerava a thread por um frame.
        onMessageSent={() => {
          // Após enviar, limpa reply — o quote foi "consumido".
          setReplyingTo(null);
        }}
      />

      {/* AlertDialog — confirmação de apagar (CHAT-REPLY-EDIT-DEL) */}
      <AlertDialog
        open={pendingDeleteMsg !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteMsg(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar essa mensagem para todos?</AlertDialogTitle>
            <AlertDialogDescription>
              A mensagem será removida do WhatsApp do cliente e ficará marcada como
              &quot;Mensagem apagada&quot; no histórico. Essa ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDeleteConfirm();
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                'Apagar'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default ConversationThread;
