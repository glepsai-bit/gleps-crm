/**
 * ConversationActions — T-022 Sprint 4
 *
 * Concentra as ações destrutivas/de ciclo de vida da conversa em um único
 * componente reusável (usado no header do thread). Cada ação dispara mutation
 * com toast feedback; ações destrutivas (resolver, transferir) confirmam via
 * AlertDialog.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UserPlus,
  ArrowRightLeft,
  Clock,
  CheckCircle2,
  RotateCcw,
  Tag as TagIcon,
  Flag,
  MoreVertical,
  Star,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
// SLA v2: o AlertDialog "Resolver" foi substituido por um Dialog rico com
// outcome obrigatorio + internalRating + reason + CSAT opt-out. Por isso o
// import de AlertDialog* foi removido — agora so o Dialog basico e usado.
import {
  conversationsBackendService,
  type Conversation,
  type ConversationOutcome,
  type ConversationPriority,
  type ConversationResolvedBy,
} from '@/services/conversations.backend.service';
import { usersBackendService } from '@/services/users.backend.service';
import { teamsBackendService } from '@/services/teams.backend.service';
import { tagsBackendService } from '@/services/tags.backend.service';
import { chatSocket } from '@/services/socket.client';

const PRIORITY_LABEL: Record<ConversationPriority, string> = {
  urgent: 'Urgente',
  high: 'Alta',
  medium: 'Média',
  low: 'Baixa',
};

interface ConversationActionsProps {
  conversation: Conversation;
}

export function ConversationActions({ conversation }: ConversationActionsProps) {
  const { toast } = useToast();
  const { user, account } = useAuth();
  const queryClient = useQueryClient();
  const conversationId = conversation.id;

  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTo, setTransferTo] = useState<'agent' | 'team'>('agent');
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null);
  const [transferNote, setTransferNote] = useState('');

  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeUntil, setSnoozeUntil] = useState('');

  // SLA v2 — dialog "Resolver com avaliacao". `resolveConfirm` agora alem de
  // marcar quem resolveu (ai|human) tambem abre o dialog que coleta outcome,
  // internalRating (1-5), reason e flag sendCsatToCustomer. null = fechado.
  const [resolveConfirm, setResolveConfirm] = useState<ConversationResolvedBy | null>(
    null
  );
  const [resolveOutcome, setResolveOutcome] = useState<ConversationOutcome | ''>('');
  const [resolveRating, setResolveRating] = useState<number>(0);
  const [resolveReason, setResolveReason] = useState<string>('');
  // Default ON conforme requisito v2 — agente desmarca quando faz sentido
  // (ex: spam/abandoned, conversas sem cliente real, etc).
  const [resolveSendCsat, setResolveSendCsat] = useState<boolean>(true);

  const { data: agents = [] } = useQuery({
    queryKey: ['chat-users', account?.id],
    queryFn: () => usersBackendService.list(account?.id),
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

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
    // BUG-MSG-GHOST: invalidar APENAS o sidepanel-meta. O thread-full nao
    // precisa ser invalidado aqui — o backend emite conversation:updated
    // (sem messages, ja stripado em conversation.service.ts) que o
    // ConversationThread aplica via setQueryData incremental, preservando
    // a lista de mensagens. Invalidate de thread-full causaria GET completo
    // com include=messages que demora 100-500ms e abre janela de race onde
    // a thread pisca "Nenhuma mensagem ainda".
    queryClient.invalidateQueries({
      queryKey: ['conversation', conversationId, 'sidepanel-meta'],
    });
    // CHAT-TAG-SYNC-2 (front): após aplicar/remover label numa conversa o
    // backend espelha LeadTag do contato (CHAT-TAG-SYNC-1 no
    // conversation.service). O painel "Tags do contato" (ContactSidePanel),
    // o /admin/kanban e o /admin/leads consomem essas LeadTags via outras
    // queries, então invalidamos aqui pra refletir imediatamente sem F5.
    const contactId = conversation.contactId;
    if (contactId) {
      queryClient.invalidateQueries({ queryKey: ['contact-tags', contactId] });
    }
    queryClient.invalidateQueries({ queryKey: ['contacts'] });
    queryClient.invalidateQueries({ queryKey: ['leads'] });
    queryClient.invalidateQueries({ queryKey: ['kanban'] });
    queryClient.invalidateQueries({ queryKey: ['kanban-leads'] });
  }

  function handleMutationError(err: unknown, fallback: string) {
    const message = err instanceof Error ? err.message : fallback;
    toast({ title: 'Erro', description: message, variant: 'destructive' });
  }

  const assignMutation = useMutation({
    mutationFn: (assigneeId: string | null) =>
      conversationsBackendService.assignConversation(conversationId, assigneeId),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Atribuição atualizada' });
    },
    onError: (err) => handleMutationError(err, 'Erro ao atribuir'),
  });

  const priorityMutation = useMutation({
    mutationFn: (priority: ConversationPriority) =>
      conversationsBackendService.updatePriority(conversationId, priority),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Prioridade atualizada' });
    },
    onError: (err) => handleMutationError(err, 'Erro ao atualizar prioridade'),
  });

  const transferMutation = useMutation({
    mutationFn: () =>
      conversationsBackendService.transferConversation(conversationId, {
        to: transferTo,
        targetId: transferTargetId,
        note: transferNote.trim() || undefined,
      }),
    onSuccess: () => {
      invalidate();
      // O backend já emite 'conversation:assigned' para a sala da conversa e
      // notificação direta ao novo assignee. Aqui só garantimos que o socket
      // siga vivo (heartbeat) para receber acks rapidamente.
      try {
        chatSocket.sendHeartbeat();
      } catch {
        /* socket pode não estar conectado em SSR/teste — ignore */
      }
      toast({ title: 'Conversa transferida' });
      setTransferOpen(false);
      setTransferTargetId(null);
      setTransferNote('');
    },
    onError: (err) => handleMutationError(err, 'Erro ao transferir'),
  });

  const snoozeMutation = useMutation({
    mutationFn: () => {
      if (!snoozeUntil) throw new Error('Informe data/hora');
      return conversationsBackendService.snoozeConversation(
        conversationId,
        new Date(snoozeUntil)
      );
    },
    onSuccess: () => {
      invalidate();
      toast({ title: 'Conversa adiada (snooze)' });
      setSnoozeOpen(false);
      setSnoozeUntil('');
    },
    onError: (err) => handleMutationError(err, 'Erro ao adiar'),
  });

  // SLA v2 — payload completo: outcome obrigatorio + internalRating opcional
  // + reason opcional + flag sendCsatToCustomer. resolvedBy continua sendo
  // selecionado pelo item do menu (ai|human) — preservamos a UX original.
  interface ResolvePayload {
    resolvedBy: ConversationResolvedBy;
    outcome: ConversationOutcome;
    internalRating?: number;
    reason?: string;
    sendCsatToCustomer: boolean;
  }
  const resolveMutation = useMutation({
    mutationFn: (payload: ResolvePayload) =>
      conversationsBackendService.resolveConversation(conversationId, payload),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Conversa resolvida' });
    },
    onError: (err) => handleMutationError(err, 'Erro ao resolver'),
    // SLA v2: limpa o form e fecha o dialog em sucess/error. Antes era
    // AlertDialog simples; agora e Dialog com state local que precisa reset.
    onSettled: () => {
      setResolveConfirm(null);
      setResolveOutcome('');
      setResolveRating(0);
      setResolveReason('');
      setResolveSendCsat(true);
    },
  });

  function handleResolveSubmit() {
    if (!resolveConfirm || !resolveOutcome) return;
    resolveMutation.mutate({
      resolvedBy: resolveConfirm,
      outcome: resolveOutcome as ConversationOutcome,
      internalRating: resolveRating > 0 ? resolveRating : undefined,
      reason: resolveReason.trim() ? resolveReason.trim() : undefined,
      sendCsatToCustomer: resolveSendCsat,
    });
  }

  const reopenMutation = useMutation({
    mutationFn: () => conversationsBackendService.reopenConversation(conversationId),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Conversa reaberta' });
    },
    onError: (err) => handleMutationError(err, 'Erro ao reabrir'),
  });

  const addLabelMutation = useMutation({
    mutationFn: (tagId: string) =>
      conversationsBackendService.addLabel(conversationId, tagId),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Tag adicionada' });
    },
    onError: (err) => handleMutationError(err, 'Erro ao adicionar tag'),
  });

  const removeLabelMutation = useMutation({
    mutationFn: (tagId: string) =>
      conversationsBackendService.removeLabel(conversationId, tagId),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Tag removida' });
    },
    onError: (err) => handleMutationError(err, 'Erro ao remover tag'),
  });

  const currentLabelIds = new Set(conversation.labels?.map((l) => l.tagId) ?? []);
  const isResolved = conversation.status === 'resolved';

  // CHAT-LAYOUT-003 (fix v2): substituir flex-wrap por flex-nowrap + shrink-0 no
  // wrapper. Com flex-wrap as ações ocupavam múltiplas linhas tornando o header
  // ~171px (comprimindo a área de mensagens a ~279px). Agora os botões ficam
  // em linha única e o header mantém ~56px.
  return (
    <div className="flex flex-nowrap items-center gap-1 shrink-0">
      {/* Atribuir */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Atribuir">
            <UserPlus className="w-3.5 h-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Atribuir a</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {user?.id && (
            <DropdownMenuItem
              onSelect={(e) => {
                // BUG-B1: usar onSelect + preventDefault evita que o
                // DropdownMenu feche durante a transicao de assign. Sem isso, o
                // pointerup pos-close pode atravessar portais Radix e a
                // conversa selecionada parece "deselecionar" — quando na verdade
                // a lista refiltrou (filtro \"Atribuídas a mim\" deixou de
                // bater) e o highlight do card sumiu. Manter o menu aberto +
                // chamar a mutation explicitamente preserva o contexto visual.
                e.preventDefault();
                assignMutation.mutate(user.id);
              }}
            >
              Para mim
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              assignMutation.mutate(null);
            }}
          >
            Não atribuído
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {agents.map((a) => (
            <DropdownMenuItem
              key={a.id}
              onSelect={(e) => {
                e.preventDefault();
                assignMutation.mutate(a.id);
              }}
            >
              {a.nome || a.email}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Tags / Labels */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8 relative" title={`Tags${currentLabelIds.size > 0 ? ` (${currentLabelIds.size})` : ''}`}>
            <TagIcon className="w-3.5 h-3.5" />
            {currentLabelIds.size > 0 && (
              <span className="absolute -top-0.5 -right-0.5 bg-primary text-primary-foreground text-[9px] rounded-full w-3.5 h-3.5 flex items-center justify-center leading-none">
                {currentLabelIds.size}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-2 space-y-1">
          <p className="text-xs text-muted-foreground px-1 pb-1">Marque para aplicar</p>
          <div className="max-h-60 overflow-y-auto space-y-0.5">
            {tags.length === 0 ? (
              <p className="text-xs text-muted-foreground px-1">
                Nenhuma tag cadastrada
              </p>
            ) : (
              tags.map((tag) => {
                const active = currentLabelIds.has(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() =>
                      active
                        ? removeLabelMutation.mutate(tag.id)
                        : addLabelMutation.mutate(tag.id)
                    }
                    className="flex items-center gap-2 w-full text-left px-2 py-1 rounded hover:bg-accent text-xs"
                  >
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: tag.color || '#999' }}
                    />
                    <span className="flex-1 truncate">{tag.name}</span>
                    {active && <CheckCircle2 className="w-3 h-3 text-primary" />}
                  </button>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Prioridade — dropdown compacto (ícone apenas) para caber no header estreito */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={`Prioridade: ${PRIORITY_LABEL[conversation.priority]}`}
          >
            <Flag className="w-3.5 h-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuLabel className="text-xs">Prioridade</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {(['urgent', 'high', 'medium', 'low'] as const).map((p) => (
            <DropdownMenuItem
              key={p}
              onSelect={(event) => {
                // BUG-B2: usar onSelect (API canonica do Radix) + preventDefault
                // impede que o pointerup pos-close do DropdownMenu atravesse o
                // portal recem desmontado e atinja items do dropdown "Mais
                // acoes" (sibling com align="end" na mesma regiao), o que
                // abria o AlertDialog "Resolver" de forma inesperada em
                // cliques rapidos.
                event.preventDefault();
                priorityMutation.mutate(p);
              }}
              className={conversation.priority === p ? 'font-semibold text-primary' : ''}
            >
              {PRIORITY_LABEL[p]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Menu adicional */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Mais ações">
            <MoreVertical className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {/*
            BUG-B2/B3: itens que abrem Dialog/AlertDialog DEVEM usar onSelect
            com preventDefault. Sem isso, o Radix fecha o menu e dispara focus
            restoration no mesmo ciclo de eventos do React em que o setState
            abre o modal — combinacao que cria phantom click no
            AlertDialogAction "Resolver" (resolvendo a conversa sem confirmacao).
          */}
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setTransferOpen(true); }}>
            <ArrowRightLeft className="w-3.5 h-3.5 mr-2" />
            Transferir
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => { e.preventDefault(); setSnoozeOpen(true); }}
            disabled={isResolved}
          >
            <Clock className="w-3.5 h-3.5 mr-2" />
            Adiar (snooze)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {isResolved ? (
            <DropdownMenuItem
              onSelect={(e) => { e.preventDefault(); reopenMutation.mutate(); }}
              disabled={reopenMutation.isPending}
            >
              <RotateCcw className="w-3.5 h-3.5 mr-2" />
              Reabrir
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem
                onSelect={(e) => {
                  // BUG-B3 (ajuste): onSelect + preventDefault sozinhos já
                  // bastam segundo a Radix docs — o setTimeout era band-aid
                  // empírico que mascarava outro problema (auto-close do
                  // AlertDialog short-circuitado por preventDefault no Action).
                  e.preventDefault();
                  setResolveConfirm('human');
                }}
              >
                <CheckCircle2 className="w-3.5 h-3.5 mr-2" />
                Resolver (humano)
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setResolveConfirm('ai');
                }}
              >
                <CheckCircle2 className="w-3.5 h-3.5 mr-2" />
                Resolver (IA)
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Tags ativas (chips) — só renderiza em telas xl+ pra não competir com
          as ações no espaço horizontal do header. Em telas menores o usuário
          continua vendo as tags no painel direito (ContactSidePanel) e no
          contador do popover de Tags. */}
      {conversation.labels && conversation.labels.length > 0 && (
        <div className="hidden xl:flex items-center gap-1 ml-1 max-w-[200px] flex-nowrap overflow-hidden">
          {conversation.labels.slice(0, 2).map((l) => (
            <Badge
              key={l.id}
              variant="secondary"
              className="text-[10px] py-0 px-1.5 h-5 max-w-[120px] truncate"
              style={{ borderColor: l.tag?.color || undefined }}
              title={l.tag?.name || l.tagId}
            >
              {l.tag?.name || l.tagId}
            </Badge>
          ))}
          {conversation.labels.length > 2 && (
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 h-5">
              +{conversation.labels.length - 2}
            </Badge>
          )}
        </div>
      )}

      {/* Dialog Transferir */}
      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Transferir conversa</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Destino</Label>
              <Select value={transferTo} onValueChange={(v) => setTransferTo(v as 'agent' | 'team')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">Para um agente</SelectItem>
                  <SelectItem value="team">Para um time</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                {transferTo === 'agent' ? 'Agente' : 'Time'}
              </Label>
              <Select
                value={transferTargetId ?? ''}
                onValueChange={(v) => setTransferTargetId(v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={`Escolha um ${transferTo === 'agent' ? 'agente' : 'time'}`} />
                </SelectTrigger>
                <SelectContent>
                  {(transferTo === 'agent' ? agents : teams).map((opt) => (
                    <SelectItem key={opt.id} value={opt.id}>
                      {('nome' in opt ? opt.nome : undefined) || ('name' in opt ? opt.name : opt.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Nota interna (opcional)</Label>
              <Textarea
                value={transferNote}
                onChange={(e) => setTransferNote(e.target.value)}
                placeholder="Contexto para o destinatário..."
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => transferMutation.mutate()}
              disabled={!transferTargetId || transferMutation.isPending}
            >
              {transferMutation.isPending ? 'Transferindo...' : 'Transferir'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog Snooze */}
      <Dialog open={snoozeOpen} onOpenChange={setSnoozeOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Adiar conversa</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="snooze-until" className="text-xs">
              Reativar em
            </Label>
            <Input
              id="snooze-until"
              type="datetime-local"
              value={snoozeUntil}
              onChange={(e) => setSnoozeUntil(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              A conversa retornará para o status anterior na data escolhida.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSnoozeOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => snoozeMutation.mutate()}
              disabled={!snoozeUntil || snoozeMutation.isPending}
            >
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* SLA v2 — Dialog "Resolver conversa": substitui o AlertDialog simples
          por um form completo (outcome obrigatorio, internalRating opcional
          1-5, motivo opcional, opt-out de CSAT). `resolveConfirm` agora
          carrega quem resolveu (ai|human) decidido no menu anterior. */}
      <Dialog
        open={resolveConfirm !== null}
        onOpenChange={(open) => {
          if (resolveMutation.isPending) return;
          if (!open) {
            setResolveConfirm(null);
            setResolveOutcome('');
            setResolveRating(0);
            setResolveReason('');
            setResolveSendCsat(true);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Resolver conversa</DialogTitle>
            <DialogDescription>
              Avalie o atendimento antes de fechar. {' '}
              {resolveConfirm === 'ai'
                ? 'Resolvido pela IA.'
                : 'Resolvido por humano.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Outcome obrigatorio */}
            <div className="space-y-2">
              <Label className="text-xs font-medium">
                Resultado <span className="text-destructive">*</span>
              </Label>
              <RadioGroup
                value={resolveOutcome}
                onValueChange={(v) =>
                  setResolveOutcome(v as ConversationOutcome)
                }
                className="grid grid-cols-1 gap-1.5"
              >
                <Label
                  htmlFor="ro-resolved"
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-accent text-sm font-normal"
                >
                  <RadioGroupItem value="resolved" id="ro-resolved" />
                  <span aria-hidden>✅</span> Resolvido
                </Label>
                <Label
                  htmlFor="ro-transferred"
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-accent text-sm font-normal"
                >
                  <RadioGroupItem value="transferred" id="ro-transferred" />
                  <span aria-hidden>🔄</span> Transferido
                </Label>
                <Label
                  htmlFor="ro-spam"
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-accent text-sm font-normal"
                >
                  <RadioGroupItem value="spam" id="ro-spam" />
                  <span aria-hidden>🚫</span> Spam / Inválido
                </Label>
                <Label
                  htmlFor="ro-not_related"
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-accent text-sm font-normal"
                >
                  <RadioGroupItem value="not_related" id="ro-not_related" />
                  <span aria-hidden>👤</span> Não relacionado
                </Label>
                <Label
                  htmlFor="ro-abandoned"
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-accent text-sm font-normal"
                >
                  <RadioGroupItem value="abandoned" id="ro-abandoned" />
                  <span aria-hidden>💤</span> Abandonado
                </Label>
                <Label
                  htmlFor="ro-unable"
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-accent text-sm font-normal"
                >
                  <RadioGroupItem
                    value="unable_to_resolve"
                    id="ro-unable"
                  />
                  <span aria-hidden>❌</span> Não conseguiu resolver
                </Label>
              </RadioGroup>
            </div>

            {/* Internal rating (opcional) */}
            <div className="space-y-1">
              <Label className="text-xs font-medium">
                Avaliação interna (opcional)
              </Label>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => {
                  const active = resolveRating >= n;
                  return (
                    <button
                      key={n}
                      type="button"
                      aria-label={`${n} estrela${n > 1 ? 's' : ''}`}
                      onClick={() =>
                        setResolveRating((cur) => (cur === n ? 0 : n))
                      }
                      className={cn(
                        'p-1 rounded hover:bg-accent transition-colors',
                        active ? 'text-amber-500' : 'text-muted-foreground'
                      )}
                    >
                      <Star
                        className={cn(
                          'w-5 h-5',
                          active && 'fill-amber-500'
                        )}
                      />
                    </button>
                  );
                })}
                {resolveRating > 0 && (
                  <button
                    type="button"
                    className="ml-2 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => setResolveRating(0)}
                  >
                    Limpar
                  </button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Como foi a qualidade desse atendimento?
              </p>
            </div>

            {/* Motivo (opcional) */}
            <div className="space-y-1">
              <Label htmlFor="ro-reason" className="text-xs font-medium">
                Motivo (opcional)
              </Label>
              <Textarea
                id="ro-reason"
                value={resolveReason}
                onChange={(e) => setResolveReason(e.target.value.slice(0, 500))}
                rows={3}
                maxLength={500}
                placeholder="Observações adicionais..."
              />
              <p className="text-[11px] text-muted-foreground text-right">
                {resolveReason.length}/500
              </p>
            </div>

            {/* Checkbox CSAT */}
            <div className="flex items-start gap-2 rounded-md border border-border p-3">
              <Checkbox
                id="ro-csat"
                checked={resolveSendCsat}
                onCheckedChange={(v) => setResolveSendCsat(v === true)}
              />
              <div className="grid gap-0.5">
                <Label htmlFor="ro-csat" className="cursor-pointer text-sm">
                  Enviar pesquisa CSAT pro cliente
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Default ligado — desmarque para spam, abandono ou conversas
                  internas.
                </p>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setResolveConfirm(null)}
              disabled={resolveMutation.isPending}
            >
              Cancelar
            </Button>
            <Button
              onClick={handleResolveSubmit}
              disabled={!resolveOutcome || resolveMutation.isPending}
            >
              {resolveMutation.isPending
                ? 'Resolvendo...'
                : 'Resolver com avaliação'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ConversationActions;
