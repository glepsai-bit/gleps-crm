/**
 * MessageComposer — T-022 Sprint 4
 *
 * Composer de mensagens:
 *  - Textarea auto-grow
 *  - Toggle "Privada" (notas internas)
 *  - Atalhos canned-response via "/" (autocomplete)
 *  - Attach (input file simples + dropzone)
 *  - Ctrl+Enter envia
 *  - Indicador "digitando..." via chatSocket.sendTyping
 *
 * Observação: upload real de arquivos depende de endpoint dedicado. Aqui
 * mantemos compat com o backend `sendMessage` que aceita `attachments[]`
 * com `fileUrl` já hospedado. O input de file converte para base64 inline
 * em data URL como fallback, sinalizado por toast.
 *
 * IMPORTANTE (bug HIGH): o fallback base64 quebra o body do POST quando o
 * arquivo passa do limite do `express.json` (10MB) — o Evolution também
 * rejeita base64 mal-formado / muito grande. Enquanto o endpoint dedicado
 * de upload não existir, aplicamos:
 *   - limite explícito de 5 MB por arquivo (após base64 o body cresce ~33%)
 *   - validação do esquema do `fileUrl` (http(s):// ou data:)
 *   - aviso visual (toast) sempre que cair no fallback inline
 *   - bloqueio do envio quando algum anexo excede o limite
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
import { Paperclip, Send, Smile, Lock, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import {
  messagesBackendService,
  type SendAttachmentInput,
} from '@/services/messages.backend.service';
import { cannedResponsesBackendService } from '@/services/canned-responses.backend.service';
import { chatSocket } from '@/services/socket.client';
import type { AttachmentFileType } from '@/services/conversations.backend.service';

const EMOJIS = [
  '😀','😁','😂','🤣','😊','😍','😘','😎','🤩','🙂',
  '🤔','😐','😴','😅','😬','😭','😡','👍','👎','👏',
  '🙏','💪','🎉','❤️','🔥','✅','❌','⏰','📎','📞',
];

/**
 * Limite máximo (em bytes) por anexo enquanto não existir endpoint dedicado de
 * upload. O backend recebe via `express.json` (default ~10MB) e o base64 inflaciona
 * em ~33%, então mantemos 5MB de margem segura. Anexos acima desse limite são
 * recusados no cliente antes de qualquer chamada de rede.
 */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * Schemes aceitos para `fileUrl` no payload de mensagens. Backend espera URL
 * hospedada (http/https) ou data URL para o fallback inline. Qualquer outro
 * esquema (blob:, file:, javascript:, etc.) é rejeitado.
 */
const ALLOWED_FILE_URL_SCHEMES = /^(https?:\/\/|data:)/i;

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
}

export function MessageComposer({ conversationId, onMessageSent }: MessageComposerProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [content, setContent] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [cannedOpen, setCannedOpen] = useState(false);
  const [cannedQuery, setCannedQuery] = useState('');

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

  const sendMutation = useMutation({
    mutationFn: async () => {
      const text = content.trim();
      if (!text && pending.length === 0) {
        throw new Error('Mensagem vazia');
      }

      // Enforcement de tamanho: sem endpoint dedicado de upload, base64 inline
      // estoura o limite do express.json e o Evolution rejeita payloads muito
      // grandes. Abortamos antes de chamar a API.
      const oversized = pending.filter((p) => p.file.size > MAX_ATTACHMENT_BYTES);
      if (oversized.length > 0) {
        const names = oversized.map((p) => `${p.file.name} (${formatBytes(p.file.size)})`).join(', ');
        throw new Error(
          `Arquivo(s) acima do limite de ${formatBytes(MAX_ATTACHMENT_BYTES)}: ${names}. Hospede em URL pública e cole o link.`
        );
      }

      // Aviso ao usuário de que estamos no fallback base64 (não é upload real).
      if (pending.length > 0) {
        toast({
          title: 'Enviando anexo inline (base64)',
          description:
            'Upload dedicado ainda não disponível — arquivos grandes podem demorar ou falhar. Limite por arquivo: ' +
            formatBytes(MAX_ATTACHMENT_BYTES),
        });
      }

      // Converte anexos pendentes (fallback: data URL inline).
      const attachments: SendAttachmentInput[] = await Promise.all(
        pending.map(async (p) => {
          const dataUrl = await fileToDataUrl(p.file);
          if (!isAllowedFileUrl(dataUrl)) {
            throw new Error(
              `URL de anexo inválida para "${p.file.name}". Apenas http(s):// ou data: são aceitos.`
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
        content: text || undefined,
        isPrivate,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
    },
    onSuccess: () => {
      setContent('');
      pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      setPending([]);
      setIsPrivate(false);
      queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      onMessageSent?.();
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Erro ao enviar';
      toast({ title: 'Falha no envio', description: message, variant: 'destructive' });
    },
  });

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendMutation.mutate();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !cannedOpen) {
      // Enter simples envia também (padrão chat). Shift+Enter quebra linha.
      e.preventDefault();
      sendMutation.mutate();
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
        'border-t border-border bg-card p-3 space-y-2 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] dark:shadow-[0_-2px_8px_rgba(0,0,0,0.3)] focus-within:border-t-primary/40 transition-colors',
        isPrivate && 'bg-yellow-50 dark:bg-yellow-950/30'
      )}
    >
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

          <Button
            type="button"
            variant={isPrivate ? 'default' : 'ghost'}
            size="sm"
            className="h-7 px-2"
            onClick={() => setIsPrivate((v) => !v)}
            title="Alternar nota interna"
          >
            <Lock className="w-3.5 h-3.5 mr-1" />
            <span className="text-xs">Privada</span>
          </Button>

          {isPrivate && (
            <Badge variant="outline" className="text-[10px] py-0 h-5 border-yellow-500 text-yellow-700 dark:text-yellow-300">
              Nota interna
            </Badge>
          )}
        </div>

        <Button
          type="button"
          size="sm"
          onClick={() => sendMutation.mutate()}
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

      <p className="text-[10px] text-muted-foreground">
        Ctrl+Enter envia. Use <kbd className="px-1 rounded bg-muted">/</kbd> para abrir respostas prontas.
      </p>
    </div>
  );
}

export default MessageComposer;
