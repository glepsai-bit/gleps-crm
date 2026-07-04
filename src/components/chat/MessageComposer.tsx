/**
 * MessageComposer — T-022 Sprint 4 + PISTA D (upload hibrido)
 *
 * Composer de mensagens:
 *  - Textarea auto-grow
 *  - Toggle "Privada" (notas internas)
 *  - Atalhos canned-response via "/" (autocomplete)
 *  - Attach (input file simples + dropzone) — fluxo hibrido:
 *      * arquivos <= 5MB: base64 inline no body JSON (rapido, low latency)
 *      * arquivos  > 5MB: multipart pra POST /api/attachments/upload
 *        (fluxo dedicado — cria Attachment em disco, message referencia
 *        via fileUrl=/api/attachments/<id>)
 *  - Ctrl+Enter envia
 *  - Indicador "digitando..." via chatSocket.sendTyping
 *
 * Historico: antes existia apenas o fallback base64 com teto de 10MB —
 * arquivos maiores exigiam hospedagem externa. PISTA D introduziu o
 * endpoint multipart que aceita ate 25MB (teto WhatsApp ~16MB + folga),
 * cobrindo praticamente 100% dos casos de atendimento.
 *
 * Validacoes:
 *   - limite MAX_ATTACHMENT_BYTES=25MB por arquivo (recusa selecao)
 *   - threshold base64 vs multipart em 5MB
 *   - schema aceita http(s), data URL e /api/attachments/... (relativo)
 *   - toast informativo em cada branch (base64 x multipart)
 */
import {
  ChangeEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CornerUpLeft,
  Mic,
  Paperclip,
  Send,
  Smile,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import {
  messagesBackendService,
  type SendAttachmentInput,
} from '@/services/messages.backend.service';
import { cannedResponsesBackendService } from '@/services/canned-responses.backend.service';
import { chatSocket } from '@/services/socket.client';
import type {
  AttachmentFileType,
  Conversation,
  Message,
} from '@/services/conversations.backend.service';

const EMOJIS = [
  '😀','😁','😂','🤣','😊','😍','😘','😎','🤩','🙂',
  '🤔','😐','😴','😅','😬','😭','😡','👍','👎','👏',
  '🙏','💪','🎉','❤️','🔥','✅','❌','⏰','📎','📞',
];

/**
 * PISTA D — teto real: 25MB por anexo, aplicado em qualquer branch
 * (base64 inline ou multipart dedicado). Cobre o teto pratico do WhatsApp
 * (~16MB pra imagem/video/audio) com folga pra metadata, headers e retry.
 * Anexos acima disso sao recusados na selecao (feedback imediato ao usuario).
 * A rota multipart lida com arquivos entre 5MB e 25MB; base64 fica reservado
 * pros anexos ate 5MB (rapido, low latency, evita duas ida-e-voltas HTTP).
 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * PISTA D — threshold que separa base64 inline vs multipart dedicado.
 *   arquivos <= 5MB     → base64 no body do POST /messages (rapido)
 *   arquivos  > 5MB      → POST /api/attachments/upload multipart, depois
 *                          POST /messages referenciando /api/attachments/<id>
 *
 * 5MB eh o "sweet spot": arquivos pequenos (screenshot, audio curto) enviam
 * em 1 request; arquivos grandes (video, PDF) usam multipart pra nao inflar
 * o body JSON (base64 = +33%) nem estourar express.json (24MB).
 */
const MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * PISTA D — Schemes aceitos para `fileUrl` no payload de mensagens:
 *   - http(s)://       URL hospedada externa (legado)
 *   - data:            base64 inline (fallback rapido)
 *   - /api/attachments/  path relativo pro attachment ja carregado via
 *                        upload multipart (o backend reconhece e linka)
 */
const ALLOWED_FILE_URL_SCHEMES = /^(https?:\/\/|data:|\/api\/attachments\/)/i;

function isAllowedFileUrl(url: string): boolean {
  return ALLOWED_FILE_URL_SCHEMES.test(url);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mimeToFileType(mime: string): AttachmentFileType {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface PendingAttachment {
  id: string;
  file: File;
  fileType: AttachmentFileType;
  previewUrl: string;
}

interface MessageComposerProps {
  conversationId: string;
  onMessageSent?: () => void;
  /**
   * CHAT-REPLY-EDIT-DEL: quando != null, o composer mostra preview do quote
   * acima do textarea e envia `replyToId` no POST. O parent limpa via
   * `onCancelReply` (X do preview) ou depois do send (via `onMessageSent`).
   */
  replyingTo?: Message | null;
  onCancelReply?: () => void;
}

// ============================================
// CHAT-MIC-RECORDING — mimeType preferred order
// ============================================
// Evolution sendWhatsAppAudio (encoding: true) aceita OGG/Opus e WebM;
// preferimos OGG/Opus quando o browser suporta (menor payload, mesmo codec
// nativo do WhatsApp) e caímos pra WebM. Safari geralmente só oferece
// 'audio/mp4' — mantemos fallback.
function pickAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  const candidates = [
    'audio/ogg;codecs=opus',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  for (const mt of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mt)) return mt;
    } catch {
      /* ignore */
    }
  }
  return 'audio/webm';
}

function extForMime(mime: string): string {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'm4a';
  return 'webm';
}

function formatRecordingTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function timestampSuffix(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes())
  );
}

// Trecho curto do reply pra mostrar no preview (60 chars).
function replyPreviewText(msg: Message): string {
  if (msg.deletedAt) return 'Mensagem apagada';
  const body = msg.content?.trim();
  if (body) {
    return body.length > 60 ? `${body.slice(0, 60)}…` : body;
  }
  if (msg.attachments && msg.attachments.length > 0) {
    const first = msg.attachments[0];
    if (first.fileType === 'audio') return 'Mensagem de áudio';
    if (first.fileType === 'image') return 'Imagem';
    if (first.fileType === 'video') return 'Vídeo';
    return 'Arquivo';
  }
  return '—';
}

function replySenderLabel(msg: Message): string {
  if (msg.senderType === 'customer') return 'Cliente';
  if (msg.senderType === 'system') return 'Sistema';
  return 'Você';
}

export function MessageComposer({
  conversationId,
  onMessageSent,
  replyingTo,
  onCancelReply,
}: MessageComposerProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [content, setContent] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [cannedOpen, setCannedOpen] = useState(false);
  const [cannedQuery, setCannedQuery] = useState('');

  // CHAT-MIC-RECORDING states
  const [isRecording, setIsRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartRef = useRef<number>(0);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Ref pra decidir no onstop se devemos ENVIAR ou DESCARTAR. Não podemos
  // usar state porque o handler `onstop` é assíncrono e recebe uma snapshot
  // do state no momento do bind.
  const recordingIntentRef = useRef<'send' | 'cancel'>('cancel');

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [content]);

  // Canned responses (busca por shortCode no que vier depois da "/")
  const { data: cannedList = [] } = useQuery({
    queryKey: ['canned-responses', user?.account_id ?? null],
    queryFn: () => cannedResponsesBackendService.listCannedResponses(),
    staleTime: 60_000,
  });

  const filteredCanned = useMemo(() => {
    if (!cannedQuery) return cannedList.slice(0, 8);
    const q = cannedQuery.toLowerCase();
    return cannedList
      .filter(
        (c) =>
          c.shortCode.toLowerCase().includes(q) ||
          c.content.toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [cannedList, cannedQuery]);

  // Detecta "/" inicial → abre canned picker
  useEffect(() => {
    const trimmed = content.trimStart();
    if (trimmed.startsWith('/')) {
      const q = trimmed.slice(1).split(/\s/)[0] ?? '';
      setCannedQuery(q);
      setCannedOpen(true);
    } else {
      setCannedOpen(false);
      setCannedQuery('');
    }
  }, [content]);

  // Typing indicator
  function notifyTyping() {
    if (!conversationId) return;
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      chatSocket.sendTyping(conversationId, true);
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false;
      chatSocket.sendTyping(conversationId, false);
    }, 1500);
  }

  useEffect(
    () => () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (isTypingRef.current && conversationId) {
        chatSocket.sendTyping(conversationId, false);
      }
    },
    [conversationId]
  );

  // ============================================
  // Otimismo no envio (Bug HIGH)
  // ============================================
  // Sem optimistic UI, a mensagem so aparece quando o POST resolve (~200-500ms
  // para WhatsApp + Evolution). Pior: o backend emite `message:created` via
  // socket.io SINCRONAMENTE apos a transacao, ou seja, ANTES do response do
  // POST chegar ao FE. O ConversationThread invalida o cache no socket, dispara
  // refetch, e o refetch pode vencer (ou nao) contra o `onSuccess` aqui — sem
  // optimistic, a mensagem "aparece depois" e ate "some" por instantes.
  //
  // Estrategia:
  //  1. `onMutate` injeta uma mensagem otimistica com id `optimistic:<uuid>`
  //     e status `'sending'` direto no cache `['conversation', conversationId]`.
  //  2. `cancelQueries` evita que um refetch em voo sobrescreva a otimistica
  //     antes do `onSuccess`.
  //  3. `onSuccess` substitui a otimistica pela mensagem real retornada
  //     pelo POST (match por id `optimistic:<uuid>`). Se um refetch ja
  //     trouxe a real (mesmo `id` canonical do servidor), apenas removemos
  //     a otimistica — sem duplicacao.
  //  4. `onError` reverte para o snapshot e re-popula o textarea / anexos
  //     para o usuario nao perder o texto digitado.
  //  5. Mantemos `setQueryData` em vez de `invalidateQueries` no sucesso —
  //     o socket ja invalidou (e o refetch ja esta em voo); duplicar
  //     invalidate so amplifica o race.
  const OPTIMISTIC_PREFIX = 'optimistic:';

  interface SendVariables {
    text: string;
    isPrivate: boolean;
    pendingAttachments: PendingAttachment[];
    optimisticId: string;
    /**
     * CHAT-REPLY-EDIT-DEL: id da msg citada (quando o usuário está usando
     * o modo "Responder"). Vai como replyToId no POST — o backend valida
     * que pertence à mesma conversa e monta o quoted p/ Evolution.
     */
    replyToId?: string | null;
  }

  interface SendContext {
    optimisticId: string;
    previousConversation: Conversation | undefined;
    previousContent: string;
    previousIsPrivate: boolean;
    previousPending: PendingAttachment[];
  }

  function buildOptimisticMessage(
    optimisticId: string,
    text: string,
    privateFlag: boolean,
    pendingAttachments: PendingAttachment[],
    replyToId: string | null
  ): Message {
    const nowIso = new Date().toISOString();
    return {
      id: `${OPTIMISTIC_PREFIX}${optimisticId}`,
      conversationId,
      senderType: 'agent',
      senderId: user?.id ?? null,
      content: text || null,
      // CHAT-MIC-RECORDING: quando o único anexo é audio, marcamos como
      // 'audio' — bubble usa isso pra ícone/cor correto na UI.
      contentType:
        pendingAttachments.length === 1 && pendingAttachments[0].fileType === 'audio'
          ? 'audio'
          : pendingAttachments.length > 0
            ? 'media'
            : 'text',
      isPrivate: privateFlag,
      status: 'sending',
      externalId: null,
      replyToId,
      deliveredAt: null,
      readAt: null,
      metadata: { __optimisticId: optimisticId },
      createdAt: nowIso,
      attachments: pendingAttachments.map((p) => ({
        id: `${OPTIMISTIC_PREFIX}att:${p.id}`,
        messageId: `${OPTIMISTIC_PREFIX}${optimisticId}`,
        fileType: p.fileType,
        fileUrl: p.previewUrl,
        fileSize: p.file.size,
        fileName: p.file.name,
        mimeType: p.file.type,
        thumbnailUrl: null,
        duration: null,
        createdAt: nowIso,
      })),
    };
  }

  function isOptimisticMessage(m: Message): boolean {
    return typeof m.id === 'string' && m.id.startsWith(OPTIMISTIC_PREFIX);
  }

  const sendMutation = useMutation<Message, Error, SendVariables, SendContext>({
    mutationFn: async (vars) => {
      // PISTA D — Fluxo hibrido: base64 inline (rapido) pra <=5MB, multipart
      // dedicado (POST /api/attachments/upload) pra >5MB. Cada anexo eh
      // roteado independentemente pelo seu size — user pode enviar 1 foto
      // pequena + 1 video grande na mesma message; a primeira vai inline,
      // a segunda sobe primeiro e depois eh linkada por fileUrl relativo.
      const hasSmall = vars.pendingAttachments.some(
        (p) => p.file.size <= MULTIPART_THRESHOLD_BYTES
      );
      const hasLarge = vars.pendingAttachments.some(
        (p) => p.file.size > MULTIPART_THRESHOLD_BYTES
      );
      if (hasLarge) {
        toast({
          title: 'Enviando arquivo grande…',
          description:
            'Anexo(s) acima de ' +
            formatBytes(MULTIPART_THRESHOLD_BYTES) +
            ' — subindo via upload dedicado antes de enviar a mensagem.',
        });
      } else if (hasSmall) {
        toast({
          title: 'Enviando anexo inline (base64)',
          description:
            'Arquivos ate ' +
            formatBytes(MULTIPART_THRESHOLD_BYTES) +
            ' viajam inline. Limite total por arquivo: ' +
            formatBytes(MAX_ATTACHMENT_BYTES),
        });
      }

      const attachments: SendAttachmentInput[] = await Promise.all(
        vars.pendingAttachments.map(async (p): Promise<SendAttachmentInput> => {
          if (p.file.size > MULTIPART_THRESHOLD_BYTES) {
            // Branch multipart — sobe o arquivo pra rota dedicada; o backend
            // devolve fileUrl relativo (/api/attachments/<id>). O composer
            // envia a message apenas com esse fileUrl (sem base64).
            const uploaded = await messagesBackendService.uploadAttachment(
              conversationId,
              p.file
            );
            if (!isAllowedFileUrl(uploaded.fileUrl)) {
              throw new Error(
                `URL do anexo retornada pelo servidor eh invalida: "${uploaded.fileUrl}".`
              );
            }
            return {
              fileType: p.fileType,
              fileUrl: uploaded.fileUrl,
              fileName: p.file.name,
              fileSize: uploaded.fileSize,
              mimeType: uploaded.mimeType,
            };
          }

          // Branch base64 (rapido, arquivos <=5MB).
          const dataUrl = await fileToDataUrl(p.file);
          if (!isAllowedFileUrl(dataUrl)) {
            throw new Error(
              `URL de anexo invalida para "${p.file.name}". Apenas http(s)://, data: ou /api/attachments/ sao aceitos.`
            );
          }
          return {
            fileType: p.fileType,
            fileUrl: dataUrl,
            fileName: p.file.name,
            fileSize: p.file.size,
            mimeType: p.file.type,
          };
        })
      );

      return messagesBackendService.sendMessage(conversationId, {
        content: vars.text || undefined,
        isPrivate: vars.isPrivate,
        attachments: attachments.length > 0 ? attachments : undefined,
        // CHAT-REPLY-EDIT-DEL: só envia quando o backend consegue montar
        // quoted (msg citada precisa ter externalId real). O controller
        // trata graciosamente quando o parent ainda está pending — segue
        // sem quoted.
        replyToId: vars.replyToId ?? undefined,
      });
    },
    onMutate: async (vars) => {
      // BUG-1: queryKey alinhada com a do ConversationThread
      // (['conversation', id, 'thread-full']). Antes estava sem o sufixo
      // 'thread-full', entao o setQueryData escrevia numa entrada de cache
      // que ninguem lia — o optimistic nao aparecia na tela, anulando todo o
      // beneficio do onMutate.
      const queryKey = ['conversation', conversationId, 'thread-full'] as const;
      // Cancela refetches em voo para nao sobrescrever a otimistica.
      await queryClient.cancelQueries({ queryKey });

      const previousConversation = queryClient.getQueryData<Conversation>(queryKey);
      const optimistic = buildOptimisticMessage(
        vars.optimisticId,
        vars.text,
        vars.isPrivate,
        vars.pendingAttachments,
        vars.replyToId ?? null
      );

      queryClient.setQueryData<Conversation | undefined>(queryKey, (prev) => {
        if (!prev) return prev;
        const nextMessages = [...(prev.messages ?? []), optimistic];
        return { ...prev, messages: nextMessages };
      });

      // Limpa UI imediatamente — usuario percebe envio instantaneo. Se der
      // erro restauramos via `previousContent`/`previousPending` no onError.
      const previousContent = content;
      const previousIsPrivate = isPrivate;
      const previousPending = pending;
      setContent('');
      setPending([]);
      setIsPrivate(false);

      return {
        optimisticId: vars.optimisticId,
        previousConversation,
        previousContent,
        previousIsPrivate,
        previousPending,
      };
    },
    onSuccess: (realMessage, _vars, ctx) => {
      const queryKey = ['conversation', conversationId, 'thread-full'] as const;
      const optimisticId = ctx?.optimisticId;
      const optimisticFullId = optimisticId ? `${OPTIMISTIC_PREFIX}${optimisticId}` : null;

      queryClient.setQueryData<Conversation | undefined>(queryKey, (prev) => {
        if (!prev) return prev;
        const existing = prev.messages ?? [];
        // Se a mensagem real ja chegou via socket/refetch entre o onMutate e o
        // onSuccess, apenas remove a otimistica (evita duplicacao).
        const realAlreadyPresent = existing.some(
          (m) => !isOptimisticMessage(m) && m.id === realMessage.id
        );
        if (realAlreadyPresent) {
          return {
            ...prev,
            messages: existing.filter((m) => m.id !== optimisticFullId),
          };
        }
        // Caso normal: troca otimistica pela real preservando posicao.
        const next: Message[] = [];
        let swapped = false;
        for (const m of existing) {
          if (m.id === optimisticFullId) {
            next.push(realMessage);
            swapped = true;
          } else {
            next.push(m);
          }
        }
        if (!swapped) {
          // Otimistica ja foi removida (ex.: o refetch a substituiu sem
          // identificar match); garante append se a real ainda nao esta la.
          next.push(realMessage);
        }
        return { ...prev, messages: next };
      });

      // Atualiza apenas a lista de conversas (snippet/unread). Para a thread
      // ja escrevemos direto no cache — evita refetch redundante que disputa
      // com o evento socket e produz flicker / "mensagem some".
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      onMessageSent?.();
    },
    onError: (err, _vars, ctx) => {
      const queryKey = ['conversation', conversationId, 'thread-full'] as const;
      const optimisticFullId = ctx?.optimisticId
        ? `${OPTIMISTIC_PREFIX}${ctx.optimisticId}`
        : null;

      // Restaura snapshot do cache (remove a otimistica). Se nao havia
      // snapshot, apenas filtra a otimistica do estado atual.
      if (ctx?.previousConversation) {
        queryClient.setQueryData(queryKey, ctx.previousConversation);
      } else if (optimisticFullId) {
        queryClient.setQueryData<Conversation | undefined>(queryKey, (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            messages: (prev.messages ?? []).filter((m) => m.id !== optimisticFullId),
          };
        });
      }

      // Devolve texto/anexos para o usuario poder reenviar.
      // CHAT-REPLY-EDIT-DEL: `replyingTo` fica no parent (ConversationThread);
      // não limpamos aqui no onMutate, então em caso de erro o quote continua
      // visível no preview — o usuário pode retry no botão Enviar.
      if (ctx) {
        if (ctx.previousContent) setContent(ctx.previousContent);
        if (ctx.previousPending.length > 0) setPending(ctx.previousPending);
        setIsPrivate(ctx.previousIsPrivate);
      }

      const message = err instanceof Error ? err.message : 'Erro ao enviar';
      toast({ title: 'Falha no envio', description: message, variant: 'destructive' });
    },
    // BUG-1: removido onSettled com invalidateQueries.
    //
    // O invalidate forcado aqui destruia o ganho do optimistic update: depois
    // do setQueryData (onSuccess), invalidamos imediatamente o cache, o que
    // dispara um GET /conversations/:id. Se esse GET demorasse 100-500ms, a
    // mensagem real podia "sumir" e voltar (a thread renderizava com
    // [previous + real], depois com [previous (stale)] enquanto loading, e
    // por fim com [previous + real + outras].
    //
    // O cache ja esta consistente: onSuccess colocou a mensagem real no
    // lugar da otimistica, e o socket onMessageCreated faz merge final
    // (com dedup por id) quando o backend emitir 'message:created' a partir
    // do servidor. Sidepanel-meta (unreadCount) e atualizado pelo socket.
    // Apenas o ['conversations'] continua sendo invalidado no onSuccess para
    // atualizar snippet/unread na lista lateral.
  });

  /**
   * Encapsula validacao + montagem das variaveis. Retorna `null` quando
   * nao houver nada a enviar OU quando algum anexo violar limites — nesse
   * caso a funcao ja exibiu o toast apropriado.
   */
  function prepareSend(): SendVariables | null {
    const text = content.trim();
    if (!text && pending.length === 0) {
      toast({
        title: 'Mensagem vazia',
        description: 'Digite algo ou anexe um arquivo antes de enviar.',
        variant: 'destructive',
      });
      return null;
    }
    const oversized = pending.filter((p) => p.file.size > MAX_ATTACHMENT_BYTES);
    if (oversized.length > 0) {
      const names = oversized
        .map((p) => `${p.file.name} (${formatBytes(p.file.size)})`)
        .join(', ');
      toast({
        title: 'Anexo acima do limite',
        description: `Arquivo(s) acima do limite de ${formatBytes(MAX_ATTACHMENT_BYTES)}: ${names}. Hospede em URL publica e cole o link.`,
        variant: 'destructive',
      });
      return null;
    }
    return {
      text,
      isPrivate,
      pendingAttachments: pending,
      optimisticId:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      // CHAT-REPLY-EDIT-DEL: pega o id do quote atual (ou null quando não
      // está respondendo). Nota interna também pode carregar quote — o
      // backend permite replyToId em ambos os casos.
      replyToId: replyingTo?.id ?? null,
    };
  }

  function triggerSend() {
    const vars = prepareSend();
    if (!vars) return;
    sendMutation.mutate(vars);
  }

  // ============================================
  // CHAT-MIC-RECORDING — gravação de áudio (PTT)
  // ============================================

  function cleanupRecordingResources() {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    const stream = mediaStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch { /* ignore */ }
      }
      mediaStreamRef.current = null;
    }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
  }

  // Ao trocar de conversa ou desmontar, aborta gravação em andamento.
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        recordingIntentRef.current = 'cancel';
        try {
          mediaRecorderRef.current.stop();
        } catch { /* ignore */ }
      }
      cleanupRecordingResources();
      setIsRecording(false);
      setRecordingMs(0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  async function startRecording() {
    // Guard-rails: API precisa existir + já não estar gravando.
    if (isRecording) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      toast({
        title: 'Microfone indisponível',
        description: 'Seu navegador não suporta gravação de áudio.',
        variant: 'destructive',
      });
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      toast({
        title: 'Microfone indisponível',
        description: 'MediaRecorder não suportado neste navegador.',
        variant: 'destructive',
      });
      return;
    }

    // Anexar/áudio gravado é mutuamente exclusivo com outros anexos pendentes
    // pra evitar payload com múltiplos áudios / mix de tipos que o backend
    // rota diferente.
    if (pending.length > 0) {
      toast({
        title: 'Remova os anexos antes',
        description: 'Grave áudio sem outros anexos na fila.',
        variant: 'destructive',
      });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const mimeType = pickAudioMimeType();
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      recordingIntentRef.current = 'cancel'; // default seguro

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        const chunks = audioChunksRef.current;
        const intent = recordingIntentRef.current;
        cleanupRecordingResources();
        setIsRecording(false);
        setRecordingMs(0);

        if (intent !== 'send' || chunks.length === 0) return;

        const blob = new Blob(chunks, { type: mimeType });
        // Blob acima do limite de anexo — WhatsApp aceita até ~16MB PTT mas
        // nosso backend limita a 5MB pra proteger o payload JSON. Feedback
        // ao usuário e aborta.
        if (blob.size > MAX_ATTACHMENT_BYTES) {
          toast({
            title: 'Áudio muito longo',
            description: `Gravação de ${formatBytes(blob.size)} excede o limite de ${formatBytes(MAX_ATTACHMENT_BYTES)}. Grave um trecho menor.`,
            variant: 'destructive',
          });
          return;
        }

        const file = new File(
          [blob],
          `recording-${timestampSuffix()}.${extForMime(mimeType)}`,
          { type: mimeType }
        );

        const pendingAudio: PendingAttachment = {
          id:
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          fileType: 'audio',
          previewUrl: URL.createObjectURL(blob),
        };

        // Dispara envio imediato — texto opcional (o usuário pode ter
        // digitado enquanto gravava). Backend roteia sendWhatsAppAudio
        // quando o único attachment é audio (PTT nativo).
        const optimisticId =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

        sendMutation.mutate({
          text: content.trim(),
          isPrivate,
          pendingAttachments: [pendingAudio],
          optimisticId,
          replyToId: replyingTo?.id ?? null,
        });
      };

      recordingStartRef.current = Date.now();
      setRecordingMs(0);
      recorder.start();
      setIsRecording(true);
      recordingTimerRef.current = setInterval(() => {
        setRecordingMs(Date.now() - recordingStartRef.current);
      }, 250);
    } catch (err) {
      cleanupRecordingResources();
      const message =
        err instanceof Error ? err.message : 'Erro ao acessar microfone';
      toast({
        title: 'Falha na gravação',
        description: message,
        variant: 'destructive',
      });
    }
  }

  function stopRecording(intent: 'send' | 'cancel') {
    if (!isRecording) return;
    recordingIntentRef.current = intent;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop(); // dispara ondataavailable + onstop
      } catch {
        // Estado inconsistente — força cleanup
        cleanupRecordingResources();
        setIsRecording(false);
        setRecordingMs(0);
      }
    } else {
      cleanupRecordingResources();
      setIsRecording(false);
      setRecordingMs(0);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Ignora envios durante composicao IME (ex.: digitacao de acentos PT-BR,
    // teclados japoneses/chineses, mobile). Caso contrario, o Enter de
    // confirmacao do IME dispara send acidental.
    if (e.nativeEvent.isComposing) return;

    // Ctrl+Enter / Cmd+Enter: envia (atalho redundante, mantido por compat
    // com usuarios acostumados ao padrao antigo).
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      triggerSend();
      return;
    }
    // Enter sozinho: envia (padrao WhatsApp/Slack/Chatwoot).
    // Shift+Enter: quebra linha (deixa o comportamento nativo).
    // Nao envia quando o picker de canned-responses esta aberto — Enter
    // deveria selecionar a resposta (futuro), ou pelo menos nao enviar lixo.
    if (e.key === 'Enter' && !e.shiftKey && !cannedOpen) {
      e.preventDefault();
      triggerSend();
    }
  }

  function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    // Bloqueia já na seleção arquivos acima do limite — feedback imediato.
    const accepted: File[] = [];
    const rejected: File[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        rejected.push(file);
      } else {
        accepted.push(file);
      }
    }
    if (rejected.length > 0) {
      const names = rejected
        .map((f) => `${f.name} (${formatBytes(f.size)})`)
        .join(', ');
      toast({
        title: 'Arquivo muito grande',
        description: `Limite de ${formatBytes(MAX_ATTACHMENT_BYTES)} por anexo. Rejeitado(s): ${names}.`,
        variant: 'destructive',
      });
    }

    const next: PendingAttachment[] = accepted.map((file) => ({
      id: crypto.randomUUID(),
      file,
      fileType: mimeToFileType(file.type),
      previewUrl: URL.createObjectURL(file),
    }));
    if (next.length > 0) {
      setPending((prev) => [...prev, ...next]);
    }
    e.target.value = ''; // permite re-selecionar o mesmo arquivo
  }

  function removePending(id: string) {
    setPending((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  function applyCanned(shortCode: string, contentText: string) {
    setContent(contentText);
    setCannedOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
    toast({ title: `Resposta /${shortCode} aplicada` });
  }

  function insertEmoji(emoji: string) {
    setContent((prev) => prev + emoji);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  return (
    <div
      className={cn(
        'shrink-0 border-t border-border bg-card p-3 space-y-2 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] dark:shadow-[0_-2px_8px_rgba(0,0,0,0.3)] focus-within:border-t-primary/40 transition-colors',
        isPrivate && 'bg-yellow-50 dark:bg-yellow-950/30'
      )}
    >
      {/* WAVE 1.4 — Tabs Responder / Nota interna substituem o toggle "Privada".
          O state `isPrivate` continua sendo a fonte de verdade — apenas a UI muda. */}
      <Tabs
        value={isPrivate ? 'private' : 'reply'}
        onValueChange={(v) => setIsPrivate(v === 'private')}
      >
        <TabsList className="h-8 bg-transparent border-b border-border rounded-none w-full justify-start p-0">
          <TabsTrigger
            value="reply"
            className="text-xs h-8 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Responder
          </TabsTrigger>
          <TabsTrigger
            value="private"
            className="text-xs h-8 rounded-none border-b-2 border-transparent data-[state=active]:border-yellow-500 data-[state=active]:text-yellow-700 dark:data-[state=active]:text-yellow-300 data-[state=active]:bg-yellow-50 dark:data-[state=active]:bg-yellow-950/30 data-[state=active]:shadow-none"
          >
            Nota interna
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* CHAT-REPLY-EDIT-DEL: preview do quote acima do textarea */}
      {replyingTo && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5',
            'dark:bg-primary/10'
          )}
        >
          <CornerUpLeft className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0 border-l-2 border-primary pl-2">
            <p className="text-[11px] font-medium text-primary">
              Respondendo a {replySenderLabel(replyingTo)}
            </p>
            <p className="text-[11px] text-muted-foreground truncate">
              {replyPreviewText(replyingTo)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onCancelReply?.()}
            className="text-muted-foreground hover:text-foreground shrink-0"
            aria-label="Cancelar resposta"
            title="Cancelar resposta"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Anexos pendentes */}
      {pending.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pending.map((p) => (
            <div
              key={p.id}
              className="relative flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
              title={`${p.file.name} — ${formatBytes(p.file.size)}`}
            >
              <Paperclip className="w-3 h-3 text-muted-foreground" />
              <span className="max-w-[140px] truncate">{p.file.name}</span>
              <span className="text-[10px] text-muted-foreground">
                {formatBytes(p.file.size)}
              </span>
              <button
                type="button"
                onClick={() => removePending(p.id)}
                className="text-muted-foreground hover:text-destructive"
                aria-label="Remover anexo"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* CHAT-MIC-RECORDING: barra de gravação — substitui a textarea/actions
          normais enquanto isRecording=true. Timer + Cancelar + Enviar. */}
      {isRecording && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-destructive" />
          </span>
          <span className="text-sm font-medium text-destructive tabular-nums">
            {formatRecordingTime(recordingMs)}
          </span>
          <span className="text-xs text-muted-foreground flex-1">
            Gravando… fale agora
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => stopRecording('cancel')}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1" />
            Cancelar
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            onClick={() => stopRecording('send')}
          >
            <Send className="w-3.5 h-3.5 mr-1" />
            Enviar
          </Button>
        </div>
      )}

      {/* Picker de canned responses */}
      <Popover open={cannedOpen && filteredCanned.length > 0} onOpenChange={setCannedOpen}>
        <PopoverTrigger asChild>
          <div />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className="w-72 p-1"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="text-[11px] text-muted-foreground px-2 py-1">
            Respostas prontas
          </div>
          {filteredCanned.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => applyCanned(c.shortCode, c.content)}
              className="w-full text-left px-2 py-1 rounded hover:bg-accent"
            >
              <p className="text-xs font-medium">/{c.shortCode}</p>
              <p className="text-[11px] text-muted-foreground line-clamp-2">
                {c.content}
              </p>
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Textarea + actions — escondidos durante gravação p/ evitar
          conflito de foco / envio duplicado (envio do áudio dispara
          sendMutation quando o usuário clica "Enviar" na barra de rec). */}
      {!isRecording && (
        <>
          <Textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              notifyTyping();
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              isPrivate
                ? 'Nota interna (não visível ao cliente)...'
                : 'Digite uma mensagem. Use / para respostas prontas. Enter envia, Shift+Enter quebra linha.'
            }
            rows={2}
            className={cn(
              'resize-none text-sm min-h-[44px] max-h-[200px] focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:border-primary/50',
              isPrivate && 'bg-yellow-100/60 dark:bg-yellow-900/30'
            )}
          />

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileSelected}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => fileInputRef.current?.click()}
                title="Anexar arquivo"
              >
                <Paperclip className="w-4 h-4" />
              </Button>

              {/* CHAT-MIC-RECORDING: botão Mic — inicia gravação */}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={startRecording}
                title="Gravar áudio"
                aria-label="Gravar áudio"
                disabled={sendMutation.isPending}
              >
                <Mic className="w-4 h-4" />
              </Button>

              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title="Emoji"
                  >
                    <Smile className="w-4 h-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-2">
                  <div className="grid grid-cols-10 gap-1">
                    {EMOJIS.map((e) => (
                      <button
                        key={e}
                        type="button"
                        className="text-lg hover:bg-accent rounded p-0.5"
                        onClick={() => insertEmoji(e)}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

            </div>

            <Button
              type="button"
              size="sm"
              onClick={() => triggerSend()}
              disabled={
                sendMutation.isPending ||
                (!content.trim() && pending.length === 0)
              }
            >
              {sendMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <Send className="w-3.5 h-3.5 mr-1" />
                  Enviar
                </>
              )}
            </Button>
          </div>
        </>
      )}

    </div>
  );
}

export default MessageComposer;
