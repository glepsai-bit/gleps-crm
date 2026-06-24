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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  conversationsBackendService,
  type Conversation,
  type ConversationPriority,
  type ConversationResolvedBy,
} from '@/services/conversations.backend.service';
import { usersBackendService } from '@/services/users.backend.service';
import { teamsBackendService } from '@/services/teams.backend.service';
import { tagsBackendService } from '@/services/tags.backend.service';
import { chatSocket } from '@/services/socket.client';

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

  const [resolveConfirm, setResolveConfirm] = useState<ConversationResolvedBy | null>(
    null
  );

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
    queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
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

  const resolveMutation = useMutation({
    mutationFn: (resolvedBy: ConversationResolvedBy) =>
      conversationsBackendService.resolveConversation(conversationId, { resolvedBy }),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Conversa resolvida' });
      setResolveConfirm(null);
    },
    onError: (err) => handleMutationError(err, 'Erro ao resolver'),
  });

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

  // CHAT-LAYOUT-003: header do thread quebrava ao tentar render todas as ações +
  // chips numa linha só. Aplicar flex-wrap permite que linhas adicionais fluam
  // para baixo (em vez de sobrepor o metadata da conversa) e gap-y separa as
  // linhas com respiro vertical.
  return (
    <div className="flex flex-wrap items-center gap-1 gap-y-1.5">
      {/* Atribuir */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8" title="Atribuir">
            <UserPlus className="w-3.5 h-3.5 mr-1" />
            <span className="text-xs hidden md:inline">Atribuir</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Atribuir a</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {user?.id && (
            <DropdownMenuItem onClick={() => assignMutation.mutate(user.id)}>
              Para mim
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => assignMutation.mutate(null)}>
            Não atribuído
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {agents.map((a) => (
            <DropdownMenuItem key={a.id} onClick={() => assignMutation.mutate(a.id)}>
              {a.nome || a.email}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Tags / Labels */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8" title="Tags">
            <TagIcon className="w-3.5 h-3.5 mr-1" />
            <span className="text-xs hidden md:inline">
              Tags{currentLabelIds.size > 0 ? ` (${currentLabelIds.size})` : ''}
            </span>
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

      {/* Prioridade */}
      <Select
        value={conversation.priority}
        onValueChange={(v) => priorityMutation.mutate(v as ConversationPriority)}
      >
        <SelectTrigger className="h-8 w-28 text-xs">
          <Flag className="w-3 h-3 mr-1" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="urgent">Urgente</SelectItem>
          <SelectItem value="high">Alta</SelectItem>
          <SelectItem value="medium">Média</SelectItem>
          <SelectItem value="low">Baixa</SelectItem>
        </SelectContent>
      </Select>

      {/* Menu adicional */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Mais ações">
            <MoreVertical className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => setTransferOpen(true)}>
            <ArrowRightLeft className="w-3.5 h-3.5 mr-2" />
            Transferir
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setSnoozeOpen(true)}
            disabled={isResolved}
          >
            <Clock className="w-3.5 h-3.5 mr-2" />
            Adiar (snooze)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {isResolved ? (
            <DropdownMenuItem
              onClick={() => reopenMutation.mutate()}
              disabled={reopenMutation.isPending}
            >
              <RotateCcw className="w-3.5 h-3.5 mr-2" />
              Reabrir
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onClick={() => setResolveConfirm('human')}>
                <CheckCircle2 className="w-3.5 h-3.5 mr-2" />
                Resolver (humano)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setResolveConfirm('ai')}>
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
        <div className="hidden xl:flex items-center gap-1 ml-1 min-w-0 flex-wrap">
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

      {/* AlertDialog Resolver */}
      <AlertDialog
        open={resolveConfirm !== null}
        onOpenChange={(open) => !open && setResolveConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resolver conversa?</AlertDialogTitle>
            <AlertDialogDescription>
              A conversa será marcada como resolvida (
              {resolveConfirm === 'ai' ? 'atribuída à IA' : 'atribuída a um humano'}).
              Você ainda poderá reabrir depois.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => resolveConfirm && resolveMutation.mutate(resolveConfirm)}
              disabled={resolveMutation.isPending}
            >
              {resolveMutation.isPending ? 'Resolvendo...' : 'Resolver'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default ConversationActions;
