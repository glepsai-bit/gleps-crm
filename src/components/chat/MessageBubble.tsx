/**
 * MessageBubble — CHAT-REPLY-EDIT-DEL + CHAT-REACTIONS + CHAT-MIC
 *
 * Extraído do render inline do ConversationThread.tsx (map de group.items).
 * Concentra toda a UX de bubble individual:
 *   - Menu contextual (Responder / Reagir / Editar / Apagar) via DropdownMenu
 *     que aparece em group-hover no canto do bubble.
 *   - Estado "deletado": renderiza "Mensagem apagada" em italic quando
 *     `msg.deletedAt != null`.
 *   - Pill de reactions abaixo do bubble (agregado por emoji, click toggla).
 *   - Modo edit inline: textarea substitui content + botões Salvar/Cancelar
 *     quando `editingId === msg.id`.
 *   - Regras de visibilidade:
 *       Responder: sempre (customer OR outbound)
 *       Reagir:    sempre — abre popover com 6 emojis padrão
 *       Editar:    só outbound próprio do agente + createdAt > now-15min
 *                  + !deletedAt + !isPrivate
 *       Apagar:    mesmas regras do Editar
 *
 *  Notas:
 *   - Preserva as classes do render antigo (bubble align/color) pra evitar
 *     regressão visual.
 *   - `group relative` no wrapper habilita o `group-hover` do trigger.
 */
import { memo, useEffect, useMemo, useRef } from 'react';
import {
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  CornerUpLeft,
  MoreHorizontal,
  Smile,
  Pencil,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AttachmentRenderer } from './AttachmentRenderer';
import type {
  Message,
  MessageReactionAggregate,
} from '@/services/messages.backend.service';

// Emojis padrão do quick-picker (mesmo set do WhatsApp/iMessage).
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😢', '🙏', '🎉'] as const;

// Janela em ms — 15 min. Espelha `OUTBOUND_EDIT_WINDOW_MS` do backend
// (que também rege delete-for-everyone). Se divergir, o backend recusa
// com 403 e o service devolve toast de erro pro usuário — a UI aqui
// apenas evita mostrar as ações quando obviamente fora de janela.
const OUTBOUND_EDIT_WINDOW_MS = 15 * 60 * 1000;

function formatHour(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
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

export interface MessageBubbleProps {
  msg: Message;
  /** Mensagem citada (busca externa no thread pelo replyToId). */
  replyMsg?: Message | null;
  isCustomer: boolean;
  /** id do usuário autenticado — usado pra ownership e byMe em reactions. */
  currentUserId: string | null | undefined;
  /** Aggregate por emoji; vazio quando não há reactions. */
  reactions?: MessageReactionAggregate[];

  // Callbacks — quem controla o state fica no ConversationThread.
  onReply: (msg: Message) => void;
  onEdit: (msg: Message) => void;
  onDelete: (msg: Message) => void;
  onReact: (msg: Message, emoji: string) => void;
  onUnreact: (msg: Message, emoji: string) => void;

  // Edit inline
  isEditing: boolean;
  editingValue: string;
  onEditChange: (value: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
}

function MessageBubbleInner({
  msg,
  replyMsg,
  isCustomer,
  currentUserId,
  reactions,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onUnreact,
  isEditing,
  editingValue,
  onEditChange,
  onEditSave,
  onEditCancel,
}: MessageBubbleProps) {
  const isPrivate = msg.isPrivate;
  const isDeleted = Boolean(msg.deletedAt);

  // Ownership + janela: só o próprio autor pode editar/apagar, e apenas
  // dentro dos 15 min (WhatsApp rejeita fora dessa janela).
  const isOwnOutbound =
    !isCustomer &&
    msg.senderType === 'agent' &&
    typeof currentUserId === 'string' &&
    msg.senderId === currentUserId;

  const createdAtMs = useMemo(() => {
    const t = new Date(msg.createdAt).getTime();
    return Number.isFinite(t) ? t : Date.now();
  }, [msg.createdAt]);

  // Recalcula a cada re-render usando Date.now() — não temos ticker, mas
  // qualquer interação com o menu (hover/click) já força um re-render que
  // reavalia a janela. Bom o bastante pro caso real.
  const withinEditWindow = Date.now() - createdAtMs < OUTBOUND_EDIT_WINDOW_MS;

  const canEdit = isOwnOutbound && !isPrivate && !isDeleted && withinEditWindow;
  const canDelete = canEdit;

  // Foco automático + resize inicial do textarea de edição.
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (isEditing) {
      requestAnimationFrame(() => {
        editRef.current?.focus();
        const el = editRef.current;
        if (el) {
          el.style.height = 'auto';
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        }
      });
    }
  }, [isEditing]);

  return (
    <div
      className={cn('flex w-full', isCustomer ? 'justify-start' : 'justify-end')}
    >
      <div className={cn('max-w-[80%] flex flex-col', isCustomer ? 'items-start' : 'items-end')}>
        <div
          className={cn(
            // `group relative` habilita o group-hover no trigger do menu.
            'group relative rounded-lg px-3 py-2 space-y-1.5',
            isPrivate
              ? 'bg-yellow-100 dark:bg-yellow-900/40 border border-yellow-400/40'
              : isCustomer
                ? 'bg-muted text-foreground'
                : 'bg-primary text-primary-foreground'
          )}
        >
          {/* Menu de contexto — trigger MoreHorizontal aparece em hover */}
          {!isDeleted && !isEditing && (
            <div
              className={cn(
                'absolute -top-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity',
                isCustomer ? '-right-2' : '-left-2'
              )}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="h-6 w-6 rounded-full bg-background text-foreground border border-border shadow-sm flex items-center justify-center hover:bg-accent"
                    aria-label="Ações da mensagem"
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align={isCustomer ? 'start' : 'end'} className="w-40">
                  <DropdownMenuItem onSelect={() => onReply(msg)}>
                    <CornerUpLeft className="w-4 h-4 mr-2" />
                    Responder
                  </DropdownMenuItem>
                  {/* React sub-menu — DropdownMenuSub para evitar race de
                      focus com Popover aninhado. Grid de 6 emojis lado a lado. */}
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Smile className="w-4 h-4 mr-2" />
                      Reagir
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="p-1 flex gap-0.5">
                      {REACTION_EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => onReact(msg, emoji)}
                          className="text-lg hover:bg-accent rounded p-1 leading-none focus:bg-accent focus:outline-none"
                          aria-label={`Reagir com ${emoji}`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  {canEdit && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => onEdit(msg)}>
                        <Pencil className="w-4 h-4 mr-2" />
                        Editar
                      </DropdownMenuItem>
                    </>
                  )}
                  {canDelete && (
                    <DropdownMenuItem
                      onSelect={() => onDelete(msg)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Apagar
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}

          {isPrivate && (
            <div className="flex items-center gap-1 text-[10px] text-yellow-800 dark:text-yellow-200 font-medium uppercase">
              <CornerUpLeft className="w-3 h-3" />
              Nota interna
            </div>
          )}

          {/* Reply quote — mostra a msg citada em um bloco à parte */}
          {replyMsg && !isDeleted && (
            <div
              className={cn(
                'border-l-2 pl-2 text-[11px] opacity-80',
                isCustomer ? 'border-primary' : 'border-primary-foreground/40'
              )}
            >
              <p className="font-medium">
                {replyMsg.senderType === 'customer'
                  ? 'Cliente'
                  : replyMsg.senderType === 'system'
                    ? 'Sistema'
                    : 'Agente'}
              </p>
              <p className="line-clamp-2">
                {replyMsg.deletedAt ? 'Mensagem apagada' : replyMsg.content || '—'}
              </p>
            </div>
          )}

          {/* Body: deletado / editando / normal */}
          {isDeleted ? (
            <p className="text-sm italic opacity-60">Mensagem apagada</p>
          ) : isEditing ? (
            <div className="space-y-1.5">
              <Textarea
                ref={editRef}
                value={editingValue}
                onChange={(e) => onEditChange(e.target.value)}
                rows={2}
                className={cn(
                  'resize-none text-sm min-h-[44px] max-h-[200px]',
                  // Contrast em bubble outbound (fundo primário) exige
                  // sobrescrever cores do textarea.
                  !isCustomer &&
                    'bg-primary-foreground/95 text-foreground border-primary-foreground/40'
                )}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onEditSave();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    onEditCancel();
                  }
                }}
              />
              <div className="flex items-center justify-end gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-7 text-xs',
                    !isCustomer && 'text-primary-foreground hover:bg-primary-foreground/10'
                  )}
                  onClick={onEditCancel}
                >
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={onEditSave}
                  disabled={editingValue.trim().length === 0}
                >
                  Salvar
                </Button>
              </div>
            </div>
          ) : (
            <>
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
            </>
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
            {!isCustomer && !isDeleted && statusIcon(msg.status)}
          </div>
        </div>

        {/* Reactions pill — abaixo do bubble, mesmo alinhamento */}
        {reactions && reactions.length > 0 && !isDeleted && (
          <div
            className={cn(
              'flex flex-wrap gap-1 mt-1',
              isCustomer ? 'justify-start' : 'justify-end'
            )}
          >
            {reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                onClick={() => (r.byMe ? onUnreact(msg, r.emoji) : onReact(msg, r.emoji))}
                className={cn(
                  'text-xs bg-background border rounded-full px-2 py-0.5 hover:bg-accent transition-colors flex items-center gap-1',
                  r.byMe && 'border-primary text-primary'
                )}
                title={r.byMe ? 'Remover sua reação' : 'Reagir também'}
              >
                <span>{r.emoji}</span>
                <span className="text-[10px] font-medium">{r.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * PERF-AUDIT (Round 1): threads longas re-renderizavam todas as bubbles a
 * cada tecla no composer, cada evento socket, cada edit inline — porque o
 * pai (ConversationThread) recria os handlers e passa refs novas via props.
 * React.memo com custom comparator: so re-renderiza se o proprio msg mudou,
 * reactions mudaram, isEditing/editingValue mudaram (dessa row) OU
 * currentUserId mudou. Os handlers `on*` sao intencionalmente ignorados no
 * compare — o pai deve envolve-los em useCallback para nao invalidar tudo,
 * mas mesmo sem useCallback do lado do pai a memoizacao continua util pra
 * qualquer prop instavel que nao entre no comparator.
 */
function propsAreEqualForMemo(
  prev: MessageBubbleProps,
  next: MessageBubbleProps
): boolean {
  // Estado da propria bubble: mudou algum campo relevante da msg?
  if (prev.msg !== next.msg) {
    // Referencia diferente: comparar por campos sensiveis pra renderizacao.
    if (
      prev.msg.id !== next.msg.id ||
      prev.msg.content !== next.msg.content ||
      prev.msg.status !== next.msg.status ||
      prev.msg.deletedAt !== next.msg.deletedAt ||
      prev.msg.externalId !== next.msg.externalId ||
      prev.msg.readAt !== next.msg.readAt ||
      prev.msg.deliveredAt !== next.msg.deliveredAt
    ) {
      return false;
    }
    // Attachments: comparar por indice. NAO basta length+id porque o worker
    // de download materializa `storageStatus: pending -> downloaded`, muda
    // `fileUrl` (proxy /api/attachments/<id>) e preenche `thumbnailUrl`
    // depois de a Message ja existir — mesmo id de attachment, campos
    // diferentes. Se ignorarmos, a bubble mantem "loading" ate um refetch
    // completo (30s de polling).
    const prevAtt = prev.msg.attachments ?? [];
    const nextAtt = next.msg.attachments ?? [];
    if (prevAtt.length !== nextAtt.length) return false;
    for (let i = 0; i < prevAtt.length; i += 1) {
      const a = prevAtt[i];
      const b = nextAtt[i];
      if (
        a?.id !== b?.id ||
        a?.fileUrl !== b?.fileUrl ||
        a?.thumbnailUrl !== b?.thumbnailUrl ||
        a?.mimeType !== b?.mimeType ||
        a?.fileSize !== b?.fileSize ||
        a?.duration !== b?.duration
      ) {
        return false;
      }
    }
  }
  if (prev.isCustomer !== next.isCustomer) return false;
  if (prev.currentUserId !== next.currentUserId) return false;
  // replyMsg: comparar tambem content+deletedAt porque uma msg citada pode
  // ser editada (novo content) ou apagada (deletedAt setado + content zerado
  // pelo backend). Sem esses campos o quote fica travado no texto original.
  if (prev.replyMsg?.id !== next.replyMsg?.id) return false;
  if (prev.replyMsg?.content !== next.replyMsg?.content) return false;
  if (prev.replyMsg?.deletedAt !== next.replyMsg?.deletedAt) return false;
  // Reactions: comparar por conteudo (referencia sempre muda com o hydrate
  // do effect, mas o conteudo pode ser igual).
  const prevR = prev.reactions ?? [];
  const nextR = next.reactions ?? [];
  if (prevR.length !== nextR.length) return false;
  for (let i = 0; i < prevR.length; i += 1) {
    if (
      prevR[i].emoji !== nextR[i].emoji ||
      prevR[i].count !== nextR[i].count ||
      prevR[i].byMe !== nextR[i].byMe
    ) {
      return false;
    }
  }
  // Edicao inline: so importa pra bubble em edicao.
  if (prev.isEditing !== next.isEditing) return false;
  if (prev.isEditing && prev.editingValue !== next.editingValue) return false;
  return true;
}

export const MessageBubble = memo(MessageBubbleInner, propsAreEqualForMemo);

export default MessageBubble;
