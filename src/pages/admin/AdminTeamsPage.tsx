/**
 * Admin Teams Page — T-022 Fase B (Frontend)
 *
 * CRUD de Teams (departamentos) com membership.
 *
 * Backend: src/services/teams.backend.service.ts
 *   - listTeams / getTeam / createTeam / updateTeam / deleteTeam
 *   - addTeamMember / removeTeamMember
 *
 * Layout:
 *   - Tabela: nome, descrição, qtd membros, allowAutoAssign toggle, ações
 *   - Dialog criar/editar: nome, descrição, allowAutoAssign, businessHours
 *   - Dialog detalhe (aba "Membros"): listar / add / remove / role member|leader
 *   - AlertDialog delete
 */

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import {
  teamsBackendService,
  type Team,
  type TeamWithMembers,
  type TeamMember,
  type TeamMemberRole,
  type CreateTeamInput,
  type UpdateTeamInput,
} from '@/services/teams.backend.service';
import { usersBackendService } from '@/services/users.backend.service';
import type { Profile } from '@/services/users.cloud.service';

import { useAuth } from '@/contexts/AuthContext';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import {
  Plus,
  Pencil,
  Trash2,
  Users,
  Loader2,
  UserPlus,
  X,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Tipos & Schemas
// ---------------------------------------------------------------------------

const DIAS = [
  { key: 'monday', label: 'Segunda' },
  { key: 'tuesday', label: 'Terça' },
  { key: 'wednesday', label: 'Quarta' },
  { key: 'thursday', label: 'Quinta' },
  { key: 'friday', label: 'Sexta' },
  { key: 'saturday', label: 'Sábado' },
  { key: 'sunday', label: 'Domingo' },
] as const;

type DiaKey = typeof DIAS[number]['key'];

interface BusinessHourDia {
  enabled: boolean;
  open: string;
  close: string;
}

type BusinessHoursState = Record<DiaKey, BusinessHourDia>;

const DEFAULT_BUSINESS_HOURS: BusinessHoursState = DIAS.reduce(
  (acc, d) => ({
    ...acc,
    [d.key]: {
      enabled: d.key !== 'saturday' && d.key !== 'sunday',
      open: '09:00',
      close: '18:00',
    },
  }),
  {} as BusinessHoursState,
);

/**
 * Normaliza businessHours vindos do backend para o estado da UI.
 * Backend pode armazenar: { monday: { open, close }, ... } ou null.
 */
function parseBusinessHours(raw: any): BusinessHoursState {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_BUSINESS_HOURS };
  }
  const out = { ...DEFAULT_BUSINESS_HOURS };
  for (const d of DIAS) {
    const entry = raw?.[d.key];
    if (entry && typeof entry === 'object') {
      out[d.key] = {
        enabled: entry.enabled !== false,
        open: typeof entry.open === 'string' ? entry.open : '09:00',
        close: typeof entry.close === 'string' ? entry.close : '18:00',
      };
    } else {
      out[d.key] = { ...DEFAULT_BUSINESS_HOURS[d.key], enabled: false };
    }
  }
  return out;
}

/**
 * Serializa o estado da UI para o formato persistido.
 * Omite dias desabilitados.
 */
function serializeBusinessHours(state: BusinessHoursState): Record<string, { open: string; close: string }> {
  const out: Record<string, { open: string; close: string }> = {};
  for (const d of DIAS) {
    const dia = state[d.key];
    if (dia.enabled) {
      out[d.key] = { open: dia.open, close: dia.close };
    }
  }
  return out;
}

const teamFormSchema = z.object({
  name: z.string().trim().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  description: z.string().trim().max(500, 'Máximo 500 caracteres').optional().or(z.literal('')),
  allowAutoAssign: z.boolean().default(false),
});
type TeamFormData = z.infer<typeof teamFormSchema>;

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export default function AdminTeamsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { account } = useAuth();
  const accountId = account?.id;

  // Estado do dialog criar/editar
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<TeamWithMembers | null>(null);
  const [businessHours, setBusinessHours] = useState<BusinessHoursState>(
    { ...DEFAULT_BUSINESS_HOURS },
  );

  // Detalhe (aba Membros)
  const [detailTeamId, setDetailTeamId] = useState<string | null>(null);

  // Delete confirm
  const [deletingTeam, setDeletingTeam] = useState<TeamWithMembers | null>(null);

  // --- Form ---
  const form = useForm<TeamFormData>({
    resolver: zodResolver(teamFormSchema),
    defaultValues: { name: '', description: '', allowAutoAssign: false },
  });

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = form;

  const allowAutoAssignValue = watch('allowAutoAssign');

  // --- Queries ---
  const teamsQuery = useQuery<TeamWithMembers[]>({
    queryKey: ['teams'],
    queryFn: () => teamsBackendService.listTeams(),
  });
  const teams = teamsQuery.data ?? [];

  // Users da conta (para o seletor de membros)
  const usersQuery = useQuery<Profile[]>({
    queryKey: ['account-users', accountId],
    queryFn: () => usersBackendService.list(accountId),
    enabled: !!accountId,
  });
  const accountUsers = usersQuery.data ?? [];

  // --- Mutations ---
  const createMutation = useMutation({
    mutationFn: (payload: CreateTeamInput) => teamsBackendService.createTeam(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teams'] });
      toast({ title: 'Time criado com sucesso!' });
      closeEditDialog();
    },
    onError: (err: unknown) => {
      toast({
        title: 'Erro ao criar time',
        description: (err as { message?: string })?.message ?? 'Erro desconhecido',
        variant: 'destructive',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateTeamInput }) =>
      teamsBackendService.updateTeam(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teams'] });
      toast({ title: 'Time atualizado!' });
      closeEditDialog();
    },
    onError: (err: unknown) => {
      toast({
        title: 'Erro ao atualizar time',
        description: (err as { message?: string })?.message ?? 'Erro desconhecido',
        variant: 'destructive',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => teamsBackendService.deleteTeam(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teams'] });
      toast({ title: 'Time excluído.' });
      setDeletingTeam(null);
    },
    onError: (err: unknown) => {
      toast({
        title: 'Erro ao excluir',
        description: (err as { message?: string })?.message ?? 'Erro desconhecido',
        variant: 'destructive',
      });
    },
  });

  // Toggle inline allowAutoAssign na tabela
  const toggleAutoAssignMutation = useMutation({
    mutationFn: ({ id, allowAutoAssign }: { id: string; allowAutoAssign: boolean }) =>
      teamsBackendService.updateTeam(id, { allowAutoAssign }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
    onError: (err: unknown) => {
      toast({
        title: 'Erro ao atualizar auto-assign',
        description: (err as { message?: string })?.message ?? 'Erro desconhecido',
        variant: 'destructive',
      });
    },
  });

  // --- Handlers ---
  function openCreate() {
    setEditingTeam(null);
    reset({ name: '', description: '', allowAutoAssign: false });
    setBusinessHours({ ...DEFAULT_BUSINESS_HOURS });
    setEditDialogOpen(true);
  }

  function openEdit(team: TeamWithMembers) {
    setEditingTeam(team);
    reset({
      name: team.name,
      description: team.description ?? '',
      allowAutoAssign: team.allowAutoAssign,
    });
    setBusinessHours(parseBusinessHours(team.businessHours));
    setEditDialogOpen(true);
  }

  function closeEditDialog() {
    setEditDialogOpen(false);
    setEditingTeam(null);
    reset({ name: '', description: '', allowAutoAssign: false });
    setBusinessHours({ ...DEFAULT_BUSINESS_HOURS });
  }

  function onSubmit(data: TeamFormData) {
    const bh = serializeBusinessHours(businessHours);
    const hasBh = Object.keys(bh).length > 0;

    const basePayload = {
      name: data.name.trim(),
      description: data.description?.trim() || undefined,
      allowAutoAssign: data.allowAutoAssign,
      businessHours: hasBh ? bh : null,
    };

    if (editingTeam) {
      updateMutation.mutate({
        id: editingTeam.id,
        payload: basePayload as UpdateTeamInput,
      });
    } else {
      createMutation.mutate(basePayload as CreateTeamInput);
    }
  }

  function updateBusinessHourDay(dia: DiaKey, patch: Partial<BusinessHourDia>) {
    setBusinessHours((prev) => ({
      ...prev,
      [dia]: { ...prev[dia], ...patch },
    }));
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-foreground flex items-center gap-2">
            <Users className="w-6 h-6" />
            Times de Atendimento
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Crie departamentos para organizar agentes, definir horários de atendimento
            e habilitar atribuição automática de conversas.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 mr-2" />
          Novo Time
        </Button>
      </div>

      {/* Lista */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span>Times cadastrados</span>
            {!teamsQuery.isLoading && (
              <span className="text-sm font-normal text-muted-foreground">
                {teams.length} time{teams.length === 1 ? '' : 's'}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {teamsQuery.isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : teams.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Users className="w-12 h-12 mb-4 opacity-30" />
              <p className="text-sm font-medium">Nenhum time cadastrado</p>
              <p className="text-xs mt-1">
                Clique em "Novo Time" para criar o primeiro departamento.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[700px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[180px]">Nome</TableHead>
                    <TableHead className="hidden md:table-cell">Descrição</TableHead>
                    <TableHead className="text-center w-[100px]">Membros</TableHead>
                    <TableHead className="text-center w-[140px]">Auto-assign</TableHead>
                    <TableHead className="text-right w-[140px]">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {teams.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="font-medium">{t.name}</TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground text-sm max-w-md truncate">
                        {t.description || (
                          <span className="italic text-muted-foreground/60">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge
                          variant="secondary"
                          className="cursor-pointer hover:bg-secondary/80"
                          onClick={() => setDetailTeamId(t.id)}
                          title="Ver membros"
                        >
                          {t.members.length}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={t.allowAutoAssign}
                          onCheckedChange={(checked) =>
                            toggleAutoAssignMutation.mutate({
                              id: t.id,
                              allowAutoAssign: checked,
                            })
                          }
                          disabled={
                            toggleAutoAssignMutation.isPending &&
                            toggleAutoAssignMutation.variables?.id === t.id
                          }
                          aria-label={`Alternar auto-assign do time ${t.name}`}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDetailTeamId(t.id)}
                            title="Membros"
                            aria-label={`Ver membros do time ${t.name}`}
                          >
                            <Users className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEdit(t)}
                            title="Editar"
                            aria-label={`Editar time ${t.name}`}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeletingTeam(t)}
                            className="text-destructive hover:text-destructive"
                            title="Excluir"
                            aria-label={`Excluir time ${t.name}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialog Criar / Editar */}
      <Dialog open={editDialogOpen} onOpenChange={(open) => (open ? setEditDialogOpen(true) : closeEditDialog())}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingTeam ? `Editar time — ${editingTeam.name}` : 'Novo time'}
            </DialogTitle>
            <DialogDescription>
              Configure o nome, descrição, regras de atribuição e horário de atendimento.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-5 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="team-name">Nome</Label>
              <Input
                id="team-name"
                {...register('name')}
                placeholder="Ex: Comercial, Suporte, Financeiro..."
              />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="team-description">Descrição (opcional)</Label>
              <Textarea
                id="team-description"
                {...register('description')}
                placeholder="Breve descrição do propósito deste time"
                rows={2}
              />
              {errors.description && (
                <p className="text-xs text-destructive">{errors.description.message}</p>
              )}
            </div>

            <div className="flex items-start gap-3 rounded-lg border border-border p-3">
              <Switch
                id="team-auto-assign"
                checked={allowAutoAssignValue}
                onCheckedChange={(checked) =>
                  setValue('allowAutoAssign', checked, { shouldDirty: true })
                }
              />
              <div className="space-y-0.5">
                <Label htmlFor="team-auto-assign" className="cursor-pointer">
                  Habilitar atribuição automática
                </Label>
                <p className="text-xs text-muted-foreground">
                  Conversas atribuídas a este time serão distribuídas automaticamente
                  entre os membros disponíveis (round-robin).
                </p>
              </div>
            </div>

            {/* Business Hours */}
            <div className="space-y-2">
              <div>
                <Label className="text-sm">Horário de atendimento</Label>
                <p className="text-xs text-muted-foreground">
                  Defina os dias e horários em que o time está disponível.
                </p>
              </div>
              <div className="space-y-2 rounded-lg border border-border p-3">
                {DIAS.map((d) => {
                  const dia = businessHours[d.key];
                  return (
                    <div
                      key={d.key}
                      className="flex items-center gap-3 text-sm"
                    >
                      <div className="flex items-center gap-2 w-32">
                        <Switch
                          checked={dia.enabled}
                          onCheckedChange={(checked) =>
                            updateBusinessHourDay(d.key, { enabled: checked })
                          }
                          aria-label={`Ativar ${d.label}`}
                        />
                        <span className={dia.enabled ? '' : 'text-muted-foreground'}>
                          {d.label}
                        </span>
                      </div>
                      <Input
                        type="time"
                        value={dia.open}
                        onChange={(e) =>
                          updateBusinessHourDay(d.key, { open: e.target.value })
                        }
                        disabled={!dia.enabled}
                        className="w-28"
                      />
                      <span className="text-muted-foreground">até</span>
                      <Input
                        type="time"
                        value={dia.close}
                        onChange={(e) =>
                          updateBusinessHourDay(d.key, { close: e.target.value })
                        }
                        disabled={!dia.enabled}
                        className="w-28"
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeEditDialog}
                disabled={isSaving}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {editingTeam ? 'Salvar alterações' : 'Criar time'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Dialog detalhe (Membros) */}
      <TeamDetailDialog
        teamId={detailTeamId}
        open={!!detailTeamId}
        onOpenChange={(open) => {
          if (!open) setDetailTeamId(null);
        }}
        accountUsers={accountUsers}
      />

      {/* AlertDialog excluir */}
      <AlertDialog
        open={!!deletingTeam}
        onOpenChange={(open) => {
          if (!open) setDeletingTeam(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir time?</AlertDialogTitle>
            <AlertDialogDescription>
              O time <strong>{deletingTeam?.name}</strong> será removido
              permanentemente. Membros vinculados serão desassociados, mas as
              conversas e contas atribuídas não serão excluídas.
              Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deletingTeam && deleteMutation.mutate(deletingTeam.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: Dialog de detalhe com abas (Membros)
// ---------------------------------------------------------------------------

interface TeamDetailDialogProps {
  teamId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountUsers: Profile[];
}

function TeamDetailDialog({
  teamId,
  open,
  onOpenChange,
  accountUsers,
}: TeamDetailDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Carrega detalhe do time (com members)
  const detailQuery = useQuery<TeamWithMembers>({
    queryKey: ['team', teamId],
    queryFn: () => teamsBackendService.getTeam(teamId!),
    enabled: !!teamId && open,
  });
  const team = detailQuery.data;

  // Formulário de adição
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [selectedRole, setSelectedRole] = useState<TeamMemberRole>('member');
  const [removingMember, setRemovingMember] = useState<TeamMember | null>(null);

  // Reset campos quando fecha
  function handleOpenChange(next: boolean) {
    if (!next) {
      setSelectedUserId('');
      setSelectedRole('member');
      setRemovingMember(null);
    }
    onOpenChange(next);
  }

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['team', teamId] });
    queryClient.invalidateQueries({ queryKey: ['teams'] });
  };

  const addMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TeamMemberRole }) =>
      teamsBackendService.addTeamMember(teamId!, { userId, role }),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Membro adicionado!' });
      setSelectedUserId('');
      setSelectedRole('member');
    },
    onError: (err: unknown) => {
      toast({
        title: 'Erro ao adicionar membro',
        description: (err as { message?: string })?.message ?? 'Erro desconhecido',
        variant: 'destructive',
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) =>
      teamsBackendService.removeTeamMember(teamId!, userId),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Membro removido.' });
      setRemovingMember(null);
    },
    onError: (err: unknown) => {
      toast({
        title: 'Erro ao remover',
        description: (err as { message?: string })?.message ?? 'Erro desconhecido',
        variant: 'destructive',
      });
    },
  });

  // Atualizar role (remove + re-adiciona — backend não tem endpoint patch dedicado)
  const updateRoleMutation = useMutation({
    mutationFn: async ({
      userId,
      newRole,
    }: {
      userId: string;
      newRole: TeamMemberRole;
    }) => {
      await teamsBackendService.removeTeamMember(teamId!, userId);
      return teamsBackendService.addTeamMember(teamId!, { userId, role: newRole });
    },
    onSuccess: () => {
      invalidate();
      toast({ title: 'Papel atualizado.' });
    },
    onError: (err: unknown) => {
      toast({
        title: 'Erro ao atualizar papel',
        description: (err as { message?: string })?.message ?? 'Erro desconhecido',
        variant: 'destructive',
      });
    },
  });

  // Mapa userId -> Profile para enriquecer a lista de membros
  const usersById = useMemo(() => {
    const map = new Map<string, Profile>();
    for (const u of accountUsers) {
      map.set(u.id, u);
    }
    return map;
  }, [accountUsers]);

  // Usuários elegíveis para adicionar (que ainda não são membros)
  const availableUsers = useMemo(() => {
    if (!team) return accountUsers;
    const memberIds = new Set(team.members.map((m) => m.userId));
    return accountUsers.filter((u) => !memberIds.has(u.id));
  }, [accountUsers, team]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {team ? team.name : 'Carregando...'}
          </DialogTitle>
          {team?.description && (
            <DialogDescription>{team.description}</DialogDescription>
          )}
        </DialogHeader>

        <Tabs defaultValue="membros" className="mt-2">
          <TabsList className="grid w-full grid-cols-1">
            <TabsTrigger value="membros" className="gap-2">
              <Users className="w-4 h-4" />
              Membros {team ? `(${team.members.length})` : ''}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="membros" className="mt-4 space-y-4">
            {/* Adicionar membro */}
            <div className="rounded-lg border border-border p-3 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <UserPlus className="w-4 h-4" />
                Adicionar membro
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Select
                  value={selectedUserId}
                  onValueChange={setSelectedUserId}
                  disabled={availableUsers.length === 0 || addMutation.isPending}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue
                      placeholder={
                        availableUsers.length === 0
                          ? 'Todos os usuários já são membros'
                          : 'Selecione um usuário...'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {availableUsers.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.nome} — {u.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={selectedRole}
                  onValueChange={(v) => setSelectedRole(v as TeamMemberRole)}
                  disabled={addMutation.isPending}
                >
                  <SelectTrigger className="w-full sm:w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Membro</SelectItem>
                    <SelectItem value="leader">Líder</SelectItem>
                  </SelectContent>
                </Select>

                <Button
                  type="button"
                  onClick={() =>
                    selectedUserId &&
                    addMutation.mutate({ userId: selectedUserId, role: selectedRole })
                  }
                  disabled={!selectedUserId || addMutation.isPending}
                >
                  {addMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Plus className="w-4 h-4 mr-1" />
                      Adicionar
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* Lista de membros */}
            {detailQuery.isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : !team || team.members.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                <Users className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Nenhum membro neste time ainda.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Usuário</TableHead>
                    <TableHead className="w-[140px]">Papel</TableHead>
                    <TableHead className="text-right w-[80px]">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {team.members.map((m) => {
                    const user = usersById.get(m.userId);
                    const isUpdatingThis =
                      updateRoleMutation.isPending &&
                      updateRoleMutation.variables?.userId === m.userId;
                    return (
                      <TableRow key={m.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium text-sm">
                              {user?.nome ?? (
                                <span className="italic text-muted-foreground">
                                  Usuário {m.userId.slice(0, 8)}…
                                </span>
                              )}
                            </span>
                            {user?.email && (
                              <span className="text-xs text-muted-foreground">
                                {user.email}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={m.role}
                            onValueChange={(v) =>
                              v !== m.role &&
                              updateRoleMutation.mutate({
                                userId: m.userId,
                                newRole: v as TeamMemberRole,
                              })
                            }
                            disabled={isUpdatingThis}
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="member">
                                <span className="inline-flex items-center gap-1.5">
                                  <UserIcon className="w-3 h-3" />
                                  Membro
                                </span>
                              </SelectItem>
                              <SelectItem value="leader">
                                <span className="inline-flex items-center gap-1.5">
                                  <ShieldCheck className="w-3 h-3" />
                                  Líder
                                </span>
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setRemovingMember(m)}
                            disabled={removeMutation.isPending}
                            aria-label={`Remover ${user?.nome ?? 'membro'} do time`}
                            title="Remover do time"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Fechar
          </Button>
        </DialogFooter>

        {/* AlertDialog confirmar remoção */}
        <AlertDialog
          open={!!removingMember}
          onOpenChange={(o) => {
            if (!o) setRemovingMember(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remover membro do time?</AlertDialogTitle>
              <AlertDialogDescription>
                {(() => {
                  const u = removingMember
                    ? usersById.get(removingMember.userId)
                    : null;
                  const nome = u?.nome ?? 'O usuário';
                  return (
                    <>
                      <strong>{nome}</strong> deixará de fazer parte deste time.
                      O usuário continuará existindo na conta.
                    </>
                  );
                })()}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={removeMutation.isPending}>
                Cancelar
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() =>
                  removingMember && removeMutation.mutate(removingMember.userId)
                }
                disabled={removeMutation.isPending}
              >
                {removeMutation.isPending && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                Remover
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
