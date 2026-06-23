/**
 * ConversationThread — T-022 Sprint 4
 *
 * Coluna central do chat: header com ações + lista de mensagens agrupadas por
 * dia + composer. Auto-scroll para a última mensagem; markAsRead após 2s de
 * exibição. Bubbles alinhados conforme `senderType` (customer à esquerda,
 * agent/system à direita). Notas privadas com fundo amarelo. Reply quote.
 * Indicador entregue/lida via checks.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
    queryKey: ['conversation', conversationId],
    queryFn: () =>
      conversationsBackendService.getConversation(conversationId, {
        messages: true,
        labels: true,
        participants: true,
      }),
    enabled: Boolean(conversationId),
    refetchInterval: 15_000,
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

  // Auto-scroll quando lista mudar
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
  }, [conversationQuery.data?.messages?.length]);

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

    // Nova mensagem: invalida a query da conversa (que re-busca a lista
    // com a mensagem nova). Também invalida a lista de conversas para
    // atualizar snippet/unread no menu lateral.
    const offMessage = chatSocket.onMessageCreated((payload) => {
      if (payload.conversationId !== conversationId) return;
      queryClient.invalidateQueries({
        queryKey: ['conversation', conversationId],
      });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    });

    // Mudanças na conversa (assign, status, priority etc.)
    const offConvUpdate = chatSocket.onConversationUpdated((payload) => {
      if (payload.conversationId !== conversationId) return;
      queryClient.invalidateQueries({
        queryKey: ['conversation', conversationId],
      });
    });

    const offAssigned = chatSocket.onAssigned((payload) => {
      if (payload.conversationId !== conversationId) return;
      queryClient.invalidateQueries({
        queryKey: ['conversation', conversationId],
      });
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
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Avatar className="h-9 w-9 shrink-0">
            <AvatarFallback className="text-xs bg-primary/10 text-primary">
              {getInitials(contactName)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate text-foreground">
              {contactName}
            </p>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Badge
                variant="outline"
                className={cn('text-[10px] py-0 px-1 h-4 border-0', STATUS_COLOR[conversation.status])}
              >
                {STATUS_LABEL[conversation.status]}
              </Badge>
              <span>•</span>
              <span>Prioridade: {PRIORITY_LABEL[conversation.priority]}</span>
              {conversation.assignee?.nome && (
                <>
                  <span>•</span>
                  <span>Atribuído: {conversation.assignee.nome}</span>
                </>
              )}
              {conversation.inbox?.name && (
                <>
                  <span>•</span>
                  <span className="capitalize">{conversation.inbox.name}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <ConversationActions conversation={conversation} />
      </div>

      {/* Mensagens */}
      <ScrollArea className="flex-1" ref={scrollRef as never}>
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
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <MessageSquare className="w-10 h-10 mb-2 opacity-30" />
              <p className="text-sm">Nenhuma mensagem ainda</p>
              <p className="text-xs mt-1">Envie a primeira mensagem para o cliente</p>
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
        onMessageSent={() =>
          queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
        }
      />
    </div>
  );
}

export default ConversationThread;
