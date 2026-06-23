/**
 * Admin Inboxes Page (T-022)
 *
 * CRUD dos canais de atendimento (Inbox no schema Prisma).
 * - Tabela com nome, channelType (badge), evolutionInstance, default team,
 *   toggle de ativo e ações editar/excluir.
 * - Dialog criar/editar com Select de tipo de canal, Input nome,
 *   Input evolutionInstance (apenas WhatsApp), Textarea greeting,
 *   editor de BusinessHours em Collapsible (segunda a domingo, open/close HH:MM)
 *   e Select para defaultTeam.
 * - AlertDialog para confirmar exclusão.
 *
 * Backend: src/services/inboxes.backend.service.ts (+ teams.backend.service.ts).
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import inboxesBackendService, {
  Inbox,
  InboxBusinessHours,
  InboxChannelType,
  CreateInboxInput,
  UpdateInboxInput,
} from '@/services/inboxes.backend.service';
import teamsBackendService, { Team } from '@/services/teams.backend.service';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useToast } from '@/hooks/use-toast';
import {
  Plus,
  Pencil,
  Trash2,
  Inbox as InboxIcon,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Mail,
  Facebook,
  Instagram,
} from 'lucide-react';

// ============================================
// Schema & Tipos
// ============================================

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const businessHoursDaySchema = z
  .object({
    enabled: z.boolean(),
    open: z.string(),
    close: z.string(),
  })
  .refine(
    (v) => !v.enabled || (TIME_REGEX.test(v.open) && TIME_REGEX.test(v.close)),
    { message: 'Horário inválido (use HH:MM)' },
  )
  .refine(
    (v) => !v.enabled || v.open < v.close,
    { message: 'Abertura deve ser antes do fechamento' },
  );

const schema = z.object({
  name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  channelType: z.enum(['whatsapp', 'email', 'facebook', 'instagram']),
  evolutionInstance: z.string().optional(),
  greeting: z.string().optional(),
  defaultTeamId: z.string().optional(),
  businessHours: z.object({
    mon: businessHoursDaySchema,
    tue: businessHoursDaySchema,
    wed: businessHoursDaySchema,
    thu: businessHoursDaySchema,
    fri: businessHoursDaySchema,
    sat: businessHoursDaySchema,
    sun: businessHoursDaySchema,
  }),
});

type FormData = z.infer<typeof schema>;

const CHANNEL_TYPES: { value: InboxChannelType; label: string }[] = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'E-mail' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' },
];

const DIAS_SEMANA: { key: keyof FormData['businessHours']; label: string }[] = [
  { key: 'mon', label: 'Segunda' },
  { key: 'tue', label: 'Terça' },
  { key: 'wed', label: 'Quarta' },
  { key: 'thu', label: 'Quinta' },
  { key: 'fri', label: 'Sexta' },
  { key: 'sat', label: 'Sábado' },
  { key: 'sun', label: 'Domingo' },
];

const NO_TEAM_VALUE = '__none__';

const DEFAULT_BUSINESS_HOURS: FormData['businessHours'] = {
  mon: { enabled: false, open: '08:00', close: '18:00' },
  tue: { enabled: false, open: '08:00', close: '18:00' },
  wed: { enabled: false, open: '08:00', close: '18:00' },
  thu: { enabled: false, open: '08:00', close: '18:00' },
  fri: { enabled: false, open: '08:00', close: '18:00' },
  sat: { enabled: false, open: '08:00', close: '13:00' },
  sun: { enabled: false, open: '08:00', close: '13:00' },
};

function channelLabel(type: InboxChannelType): string {
  return CHANNEL_TYPES.find((c) => c.value === type)?.label ?? type;
}

function channelIcon(type: InboxChannelType) {
  switch (type) {
    case 'whatsapp':
      return <MessageSquare className="w-3 h-3 mr-1" />;
    case 'email':
      return <Mail className="w-3 h-3 mr-1" />;
    case 'facebook':
      return <Facebook className="w-3 h-3 mr-1" />;
    case 'instagram':
      return <Instagram className="w-3 h-3 mr-1" />;
  }
}

function channelBadgeVariant(
  type: InboxChannelType,
): 'default' | 'secondary' | 'outline' {
  switch (type) {
    case 'whatsapp':
      return 'default';
    case 'email':
      return 'secondary';
    default:
      return 'outline';
  }
}

/**
 * Converte o objeto vindo do backend (apenas dias presentes com {open, close})
 * para o formato do formulário (todos os dias + flag enabled).
 */
function businessHoursFromBackend(
  bh: InboxBusinessHours | null,
): FormData['businessHours'] {
  const result: FormData['businessHours'] = JSON.parse(
    JSON.stringify(DEFAULT_BUSINESS_HOURS),
  );
  if (!bh) return result;
  DIAS_SEMANA.forEach(({ key }) => {
    const day = bh[key];
    if (day && typeof day.open === 'string' && typeof day.close === 'string') {
      result[key] = { enabled: true, open: day.open, close: day.close };
    }
  });
  return result;
}

/**
 * Converte o estado do formulário para o shape que o backend espera
 * (somente dias habilitados). Retorna null se nenhum dia estiver habilitado.
 */
function businessHoursToBackend(
  bh: FormData['businessHours'],
): InboxBusinessHours | null {
  const out: InboxBusinessHours = {};
  DIAS_SEMANA.forEach(({ key }) => {
    const day = bh[key];
    if (day.enabled) {
      out[key] = { open: day.open, close: day.close };
    }
  });
  return Object.keys(out).length > 0 ? out : null;
}

function countActiveBusinessDays(bh: InboxBusinessHours | null): number {
  if (!bh) return 0;
  return Object.keys(bh).length;
}

// ============================================
// Componente
// ============================================

export default function AdminInboxesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingInbox, setEditingInbox] = useState<Inbox | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [businessHoursOpen, setBusinessHoursOpen] = useState(false);

  const { data: inboxes = [], isLoading } = useQuery({
    queryKey: ['inboxes'],
    queryFn: () => inboxesBackendService.listInboxes(),
  });

  const { data: teams = [] } = useQuery<Team[]>({
    queryKey: ['teams'],
    queryFn: () => teamsBackendService.listTeams(),
  });

  const teamsById = useMemo(() => {
    const map = new Map<string, Team>();
    teams.forEach((t) => map.set(t.id, t));
    return map;
  }, [teams]);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      channelType: 'whatsapp',
      evolutionInstance: '',
      greeting: '',
      defaultTeamId: NO_TEAM_VALUE,
      businessHours: DEFAULT_BUSINESS_HOURS,
    },
  });

  const channelType = watch('channelType');
  const defaultTeamId = watch('defaultTeamId');
  const businessHoursValue = watch('businessHours');

  // ----- Mutations -----

  const mutateCriar = useMutation({
    mutationFn: (body: CreateInboxInput) => inboxesBackendService.createInbox(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inboxes'] });
      toast({ title: 'Canal criado com sucesso!' });
      fecharDialog();
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao criar canal',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const mutateEditar = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateInboxInput }) =>
      inboxesBackendService.updateInbox(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inboxes'] });
      toast({ title: 'Canal atualizado!' });
      fecharDialog();
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao atualizar canal',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const mutateExcluir = useMutation({
    mutationFn: (id: string) => inboxesBackendService.deleteInbox(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inboxes'] });
      toast({ title: 'Canal excluído.' });
      setDeletingId(null);
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao excluir canal',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const mutateToggleActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      inboxesBackendService.updateInbox(id, { active }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['inboxes'] });
      toast({
        title: vars.active ? 'Canal ativado' : 'Canal desativado',
      });
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao alterar status',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  // ----- Handlers -----

  const abrirCriar = () => {
    setEditingInbox(null);
    reset({
      name: '',
      channelType: 'whatsapp',
      evolutionInstance: '',
      greeting: '',
      defaultTeamId: NO_TEAM_VALUE,
      businessHours: DEFAULT_BUSINESS_HOURS,
    });
    setBusinessHoursOpen(false);
    setDialogOpen(true);
  };

  const abrirEditar = (inbox: Inbox) => {
    setEditingInbox(inbox);
    reset({
      name: inbox.name,
      channelType: inbox.channelType,
      evolutionInstance: inbox.evolutionInstance ?? '',
      greeting: inbox.greeting ?? '',
      defaultTeamId: inbox.defaultTeamId ?? NO_TEAM_VALUE,
      businessHours: businessHoursFromBackend(inbox.businessHours),
    });
    setBusinessHoursOpen(!!inbox.businessHours);
    setDialogOpen(true);
  };

  const fecharDialog = () => {
    setDialogOpen(false);
    setEditingInbox(null);
  };

  const onSubmit = (data: FormData) => {
    const isWhatsapp = data.channelType === 'whatsapp';
    const evolutionInstance =
      isWhatsapp && data.evolutionInstance && data.evolutionInstance.trim().length > 0
        ? data.evolutionInstance.trim()
        : null;
    const greeting =
      data.greeting && data.greeting.trim().length > 0 ? data.greeting.trim() : null;
    const defaultTeamIdValue =
      data.defaultTeamId && data.defaultTeamId !== NO_TEAM_VALUE
        ? data.defaultTeamId
        : null;
    const businessHours = businessHoursToBackend(data.businessHours);

    if (editingInbox) {
      mutateEditar.mutate({
        id: editingInbox.id,
        body: {
          name: data.name,
          channelType: data.channelType,
          evolutionInstance,
          greeting,
          defaultTeamId: defaultTeamIdValue,
          businessHours,
        },
      });
    } else {
      mutateCriar.mutate({
        name: data.name,
        channelType: data.channelType,
        evolutionInstance,
        greeting,
        defaultTeamId: defaultTeamIdValue,
        businessHours,
      });
    }
  };

  // Garantir que ao trocar para um canal != whatsapp limpamos a instance
  // (evita enviar valor stale ao backend).
  useEffect(() => {
    if (channelType !== 'whatsapp') {
      setValue('evolutionInstance', '');
    }
  }, [channelType, setValue]);

  const isSaving = mutateCriar.isPending || mutateEditar.isPending;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Canais de Atendimento</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure inboxes (WhatsApp, e-mail, redes sociais) e horários de atendimento
          </p>
        </div>
        <Button onClick={abrirCriar}>
          <Plus className="w-4 h-4 mr-2" />
          Novo Canal
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Canais cadastrados ({inboxes.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : inboxes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <InboxIcon className="w-12 h-12 mb-4 opacity-30" />
              <p className="text-sm font-medium">Nenhum canal cadastrado</p>
              <p className="text-xs mt-1">
                Clique em &quot;Novo Canal&quot; para criar o primeiro
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead className="hidden md:table-cell">
                    Instância Evolution
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">Time padrão</TableHead>
                  <TableHead>Ativo</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inboxes.map((inbox) => {
                  const team = inbox.defaultTeamId
                    ? teamsById.get(inbox.defaultTeamId)
                    : null;
                  return (
                    <TableRow key={inbox.id}>
                      <TableCell className="font-medium">
                        <div className="flex flex-col">
                          <span>{inbox.name}</span>
                          {countActiveBusinessDays(inbox.businessHours) > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {countActiveBusinessDays(inbox.businessHours)} dia(s)
                              configurado(s)
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={channelBadgeVariant(inbox.channelType)}
                          className="inline-flex items-center"
                        >
                          {channelIcon(inbox.channelType)}
                          {channelLabel(inbox.channelType)}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground text-sm">
                        {inbox.evolutionInstance ?? (
                          <span className="italic opacity-60">—</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm">
                        {team ? (
                          team.name
                        ) : (
                          <span className="italic text-muted-foreground opacity-60">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={inbox.active}
                          disabled={mutateToggleActive.isPending}
                          onCheckedChange={(checked) =>
                            mutateToggleActive.mutate({
                              id: inbox.id,
                              active: checked,
                            })
                          }
                          aria-label={`Alternar status de ${inbox.name}`}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => abrirEditar(inbox)}
                            title="Editar"
                            aria-label={`Editar canal ${inbox.name}`}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeletingId(inbox.id)}
                            className="text-destructive hover:text-destructive"
                            title="Excluir"
                            aria-label={`Excluir canal ${inbox.name}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Dialog criar/editar */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) fecharDialog();
          else setDialogOpen(true);
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingInbox ? 'Editar Canal' : 'Novo Canal'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-2">
            {/* Tipo de canal */}
            <div className="space-y-1">
              <Label>Tipo de canal</Label>
              <Select
                value={channelType}
                onValueChange={(val) =>
                  setValue('channelType', val as InboxChannelType, {
                    shouldValidate: true,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o tipo" />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_TYPES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.channelType && (
                <p className="text-xs text-destructive">
                  {errors.channelType.message}
                </p>
              )}
            </div>

            {/* Nome */}
            <div className="space-y-1">
              <Label>Nome do canal</Label>
              <Input
                {...register('name')}
                placeholder="Ex: Atendimento WhatsApp principal"
              />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              )}
            </div>

            {/* Evolution Instance (somente WhatsApp) */}
            {channelType === 'whatsapp' && (
              <div className="space-y-1">
                <Label>Instância Evolution</Label>
                <Input
                  {...register('evolutionInstance')}
                  placeholder="Ex: minha-instancia-01"
                />
                <p className="text-xs text-muted-foreground">
                  Identificador da instância configurada na Evolution API.
                </p>
              </div>
            )}

            {/* Greeting */}
            <div className="space-y-1">
              <Label>Mensagem de boas-vindas (opcional)</Label>
              <Textarea
                {...register('greeting')}
                rows={3}
                placeholder="Olá! Obrigado por entrar em contato. Em breve um atendente irá te responder."
              />
            </div>

            {/* Time padrão */}
            <div className="space-y-1">
              <Label>Time padrão</Label>
              <Select
                value={defaultTeamId || NO_TEAM_VALUE}
                onValueChange={(val) =>
                  setValue('defaultTeamId', val, { shouldValidate: true })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Nenhum" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TEAM_VALUE}>Nenhum</SelectItem>
                  {teams.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Time que recebe automaticamente as conversas deste canal.
              </p>
            </div>

            {/* Business Hours */}
            <Collapsible
              open={businessHoursOpen}
              onOpenChange={setBusinessHoursOpen}
              className="border rounded-md"
            >
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between p-3 text-left hover:bg-muted/40 rounded-md"
                >
                  <div>
                    <p className="text-sm font-medium">Horário de atendimento</p>
                    <p className="text-xs text-muted-foreground">
                      Defina os dias e horários em que o canal aceita mensagens
                    </p>
                  </div>
                  {businessHoursOpen ? (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  )}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="p-3 pt-0 space-y-2">
                {DIAS_SEMANA.map(({ key, label }) => {
                  const day = businessHoursValue[key];
                  const dayError = errors.businessHours?.[key];
                  return (
                    <div
                      key={key}
                      className="grid grid-cols-1 sm:grid-cols-[120px_auto_1fr_1fr] gap-2 items-center py-1"
                    >
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`bh-${key}`}
                          checked={day.enabled}
                          onCheckedChange={(checked) =>
                            setValue(`businessHours.${key}.enabled`, checked, {
                              shouldValidate: true,
                            })
                          }
                          aria-label={`Ativar ${label}`}
                        />
                        <Label
                          htmlFor={`bh-${key}`}
                          className="cursor-pointer text-sm"
                        >
                          {label}
                        </Label>
                      </div>
                      <span className="text-xs text-muted-foreground hidden sm:inline">
                        das
                      </span>
                      <Input
                        type="time"
                        value={day.open}
                        disabled={!day.enabled}
                        onChange={(e) =>
                          setValue(`businessHours.${key}.open`, e.target.value, {
                            shouldValidate: true,
                          })
                        }
                        aria-label={`Horário de abertura ${label}`}
                      />
                      <Input
                        type="time"
                        value={day.close}
                        disabled={!day.enabled}
                        onChange={(e) =>
                          setValue(`businessHours.${key}.close`, e.target.value, {
                            shouldValidate: true,
                          })
                        }
                        aria-label={`Horário de fechamento ${label}`}
                      />
                      {dayError && (
                        <p className="text-xs text-destructive col-span-full">
                          {label}: {dayError.message as string}
                        </p>
                      )}
                    </div>
                  );
                })}
              </CollapsibleContent>
            </Collapsible>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={fecharDialog}
                disabled={isSaving}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving
                  ? 'Salvando...'
                  : editingInbox
                    ? 'Salvar alterações'
                    : 'Criar canal'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* AlertDialog excluir */}
      <AlertDialog
        open={!!deletingId}
        onOpenChange={(open) => {
          if (!open) setDeletingId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir canal?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. O canal será removido permanentemente.
              Conversas vinculadas a ele podem ficar sem inbox de origem.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deletingId && mutateExcluir.mutate(deletingId)}
              disabled={mutateExcluir.isPending}
            >
              {mutateExcluir.isPending ? 'Excluindo...' : 'Excluir'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
