/**
 * Admin Inboxes Page (T-022)
 *
 * CRUD dos canais de atendimento (Inbox no schema Prisma).
 * - Tabela com nome, channelType (badge), evolutionInstance, default team,
 *   coluna "WhatsApp Status" (apenas para channelType=whatsapp),
 *   toggle de ativo e ações editar/excluir.
 * - Dialog criar/editar com Select de tipo de canal, Input nome,
 *   Input evolutionInstance (apenas WhatsApp), Textarea greeting,
 *   editor de BusinessHours em Collapsible (segunda a domingo, open/close HH:MM)
 *   e Select para defaultTeam.
 * - Botão "Conectar WhatsApp" em cada row de Inbox WhatsApp abre a modal de QR
 *   (componente local `WhatsappQrModal`) com polling de status a cada 3s
 *   (máx. 60s). Quando status === 'open' mostra check + toast e fecha em 1.5s.
 * - Checkbox "Conectar WhatsApp após criar" no form abre a modal automatica
 *   após o POST quando o canal recém-criado é WhatsApp.
 * - AlertDialog para confirmar exclusão.
 *
 * Backend:
 *   - src/services/inboxes.backend.service.ts (CRUD)
 *   - src/services/inboxes-whatsapp.backend.service.ts (connect/status/disconnect)
 *   - src/services/teams.backend.service.ts (lookup do time padrão)
 */

import { useEffect, useMemo, useRef, useState } from 'react';
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
  InboxDependencies,
} from '@/services/inboxes.backend.service';
import inboxesWhatsappBackendService, {
  WhatsappConnectionStatus,
} from '@/services/inboxes-whatsapp.backend.service';
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
import { Checkbox } from '@/components/ui/checkbox';
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
  QrCode,
  Power,
  CheckCircle2,
  Loader2,
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
  // Checkbox apenas no fluxo de criação WhatsApp; abre a modal de QR
  // automaticamente após o POST. Ignorado na edição.
  connectNow: z.boolean().optional(),
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
 * Renderiza o badge da coluna "WhatsApp Status".
 * - `open`        → verde
 * - `connecting`  → laranja
 * - `close`       → cinza
 * - `unknown`/sem instance → label discreta "—"
 */
function WhatsappStatusBadge({
  status,
  hasInstance,
}: {
  status: WhatsappConnectionStatus | null | undefined;
  hasInstance: boolean;
}) {
  if (!hasInstance || !status || status === 'unknown') {
    return (
      <span className="text-xs italic text-muted-foreground opacity-60">—</span>
    );
  }
  if (status === 'open') {
    return (
      <Badge className="bg-green-600 text-white hover:bg-green-600">
        Conectado
      </Badge>
    );
  }
  if (status === 'connecting') {
    return (
      <Badge className="bg-orange-500 text-white hover:bg-orange-500">
        Conectando
      </Badge>
    );
  }
  // close
  return (
    <Badge variant="secondary" className="text-muted-foreground">
      Desconectado
    </Badge>
  );
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
  // H-CONFIG-1: guardamos o inbox inteiro (não só id) pra exibir o nome
  // no aviso e validar a digitação de confirmação.
  const [deletingInbox, setDeletingInbox] = useState<Inbox | null>(null);
  const [businessHoursOpen, setBusinessHoursOpen] = useState(false);
  // Modal "Conectar WhatsApp" — guardamos só o id do inbox alvo. null = fechada.
  const [whatsappInboxId, setWhatsappInboxId] = useState<string | null>(null);

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
      connectNow: true,
      businessHours: DEFAULT_BUSINESS_HOURS,
    },
  });

  const channelType = watch('channelType');
  const defaultTeamId = watch('defaultTeamId');
  const businessHoursValue = watch('businessHours');
  const connectNowValue = watch('connectNow');

  // ----- Mutations -----

  // Guarda local: se o usuário marcou "Conectar agora" no submit, abrimos a
  // modal de QR assim que o backend devolver o Inbox recém-criado.
  const autoConnectAfterCreateRef = useRef(false);

  const mutateCriar = useMutation({
    mutationFn: (body: CreateInboxInput) => inboxesBackendService.createInbox(body),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['inboxes'] });
      toast({ title: 'Canal criado com sucesso!' });
      const shouldConnect =
        autoConnectAfterCreateRef.current &&
        created?.channelType === 'whatsapp';
      autoConnectAfterCreateRef.current = false;
      fecharDialog();
      if (shouldConnect && created?.id) {
        setWhatsappInboxId(created.id);
      }
    },
    onError: (err: Error) => {
      autoConnectAfterCreateRef.current = false;
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
      setDeletingInbox(null);
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
      connectNow: true,
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
      connectNow: false,
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
      // Marca para o onSuccess do mutateCriar abrir a modal de QR.
      autoConnectAfterCreateRef.current =
        isWhatsapp && !!data.connectNow;
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
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
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
                  <TableHead>WhatsApp</TableHead>
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
                  const isWhatsapp = inbox.channelType === 'whatsapp';
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
                      <TableCell>
                        {isWhatsapp ? (
                          <WhatsappStatusCell inbox={inbox} />
                        ) : (
                          <span className="text-xs italic text-muted-foreground opacity-60">
                            —
                          </span>
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
                          {isWhatsapp && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setWhatsappInboxId(inbox.id)}
                              title="Conectar WhatsApp"
                              aria-label={`Conectar WhatsApp de ${inbox.name}`}
                            >
                              <QrCode className="w-4 h-4" />
                            </Button>
                          )}
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
                            onClick={() => setDeletingInbox(inbox)}
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
                  Identificador da instância configurada na Evolution API. Deixe
                  em branco para que o backend gere automaticamente ao conectar.
                </p>
              </div>
            )}

            {/* Conectar agora (apenas criação WhatsApp) */}
            {channelType === 'whatsapp' && !editingInbox && (
              <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3">
                <Checkbox
                  id="connect-now"
                  checked={!!connectNowValue}
                  onCheckedChange={(checked) =>
                    setValue('connectNow', checked === true, {
                      shouldValidate: false,
                    })
                  }
                />
                <div className="space-y-0.5">
                  <Label
                    htmlFor="connect-now"
                    className="cursor-pointer text-sm font-medium"
                  >
                    Conectar WhatsApp agora
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Após criar o canal, abre a janela para escanear o QR Code.
                  </p>
                </div>
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

      {/* H-CONFIG-1: AlertDialog excluir com contagens de cascade
          + confirmação por digitação do nome (irreversível). */}
      <DeleteInboxDialog
        inbox={deletingInbox}
        isDeleting={mutateExcluir.isPending}
        onCancel={() => setDeletingInbox(null)}
        onConfirm={(id) => mutateExcluir.mutate(id)}
      />

      {/* Modal Conectar WhatsApp (QR Code + polling) */}
      <WhatsappQrModal
        inboxId={whatsappInboxId}
        onOpenChange={(open) => {
          if (!open) setWhatsappInboxId(null);
        }}
      />
    </div>
  );
}

// ============================================
// DeleteInboxDialog (H-CONFIG-1)
//
// AlertDialog de exclusão IRREVERSÍVEL com:
//   1. Busca de contagens via /api/inboxes/:id/dependencies ao abrir.
//   2. Lista do que será apagado: conversas, mensagens, anexos,
//      resolution_logs.
//   3. Input de confirmação por digitação do nome do inbox — o botão
//      "Excluir" só habilita quando o texto bate exatamente.
//
// O dialog abre quando `inbox` é não-nulo. Ao fechar (cancelar / sucesso /
// click fora), o pai zera `deletingInbox`.
// ============================================

function DeleteInboxDialog({
  inbox,
  isDeleting,
  onCancel,
  onConfirm,
}: {
  inbox: Inbox | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: (id: string) => void;
}) {
  const isOpen = !!inbox;
  const [typedName, setTypedName] = useState('');

  // Reset do input toda vez que abre pra um inbox diferente — evita
  // que o operador "herde" texto de uma tentativa anterior.
  useEffect(() => {
    if (isOpen) setTypedName('');
  }, [isOpen, inbox?.id]);

  const { data: deps, isLoading: isLoadingDeps } = useQuery<InboxDependencies>({
    queryKey: ['inboxes', inbox?.id, 'dependencies'],
    queryFn: () => inboxesBackendService.getInboxDependencies(inbox!.id),
    enabled: isOpen,
    // Cascade counts são "live" — não cache; cada abertura busca de novo
    // pra refletir mensagens que entraram entre o último fetch e agora.
    staleTime: 0,
  });

  const nameMatches = !!inbox && typedName === inbox.name;
  const canConfirm = nameMatches && !isLoadingDeps && !isDeleting;

  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !isDeleting) onCancel();
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-destructive">
            Excluir esta inbox vai apagar:
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 pt-2">
              {isLoadingDeps ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Calculando o impacto...
                </div>
              ) : (
                <ul className="text-sm space-y-1 list-disc pl-5">
                  <li>
                    <strong>{deps?.conversations ?? 0}</strong> conversa
                    {(deps?.conversations ?? 0) === 1 ? '' : 's'}
                  </li>
                  <li>
                    <strong>{deps?.messages ?? 0}</strong> mensage
                    {(deps?.messages ?? 0) === 1 ? 'm' : 'ns'}
                  </li>
                  <li>
                    <strong>{deps?.attachments ?? 0}</strong> anexo
                    {(deps?.attachments ?? 0) === 1 ? '' : 's'}
                  </li>
                  <li>
                    <strong>{deps?.resolutionLogs ?? 0}</strong> log
                    {(deps?.resolutionLogs ?? 0) === 1 ? '' : 's'} de
                    resolução
                  </li>
                </ul>
              )}
              <p className="text-sm font-semibold text-destructive">
                Esta ação é IRREVERSÍVEL.
              </p>
              <div className="space-y-1.5">
                <Label
                  htmlFor="delete-confirm-name"
                  className="text-sm font-medium"
                >
                  Digite o nome do inbox para confirmar:{' '}
                  <span className="font-mono text-foreground">
                    {inbox?.name}
                  </span>
                </Label>
                <Input
                  id="delete-confirm-name"
                  autoComplete="off"
                  autoFocus
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  placeholder={inbox?.name ?? ''}
                  disabled={isDeleting}
                  aria-label="Confirmar nome do inbox para exclusão"
                />
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>
            Cancelar
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            disabled={!canConfirm}
            onClick={(e) => {
              // Sem confirmação digitada não dispara, mesmo se algum
              // browser respeitar o disabled de forma estranha.
              if (!canConfirm || !inbox) {
                e.preventDefault();
                return;
              }
              onConfirm(inbox.id);
            }}
          >
            {isDeleting ? 'Excluindo...' : 'Excluir'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ============================================
// WhatsappStatusCell — busca o estado da instance Evolution sob demanda.
// Usado na coluna "WhatsApp" da tabela. Cacheia por 15s pra evitar
// flood de requests; refaz só quando o inbox volta a ficar visível.
// ============================================

function WhatsappStatusCell({ inbox }: { inbox: Inbox }) {
  const hasInstance = !!inbox.evolutionInstance;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['inboxes', inbox.id, 'whatsapp-status'],
    queryFn: () =>
      inboxesWhatsappBackendService.getWhatsappStatus(inbox.id),
    enabled: hasInstance,
    refetchInterval: 15_000,
    staleTime: 15_000,
  });

  if (!hasInstance) {
    return <WhatsappStatusBadge status={null} hasInstance={false} />;
  }
  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="w-3 h-3 animate-spin" />
        Verificando
      </span>
    );
  }
  if (isError) {
    return (
      <Badge variant="outline" className="text-destructive border-destructive">
        Erro
      </Badge>
    );
  }
  return (
    <WhatsappStatusBadge status={data?.status ?? null} hasInstance={true} />
  );
}

// ============================================
// WhatsappQrModal — modal de QR Code com polling.
//
// Fluxo:
//   1. Abre → POST /whatsapp/connect → recebe { qrcodeBase64, status }
//   2. Renderiza <img> do QR centralizado
//   3. Inicia polling /whatsapp/status a cada 3s, máx 60s (20 tentativas)
//   4. Se status === 'open' → toast + check + fecha em 1.5s
//   5. Botão "Desconectar" quando conectado → POST /whatsapp/disconnect
//
// Lifecycle: ao desmontar / fechar, todos os timers são limpos.
// ============================================

const POLLING_INTERVAL_MS = 3_000;
const POLLING_TIMEOUT_MS = 60_000;

function WhatsappQrModal({
  inboxId,
  onOpenChange,
}: {
  inboxId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isOpen = !!inboxId;

  const [qrcodeBase64, setQrcodeBase64] = useState<string | null>(null);
  const [status, setStatus] = useState<WhatsappConnectionStatus>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  // Refs para conseguir cancelar timers no cleanup.
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const giveUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (giveUpTimerRef.current) {
      clearTimeout(giveUpTimerRef.current);
      giveUpTimerRef.current = null;
    }
  };

  // Reseta estado interno quando fecha; ao abrir, dispara o /connect inicial.
  useEffect(() => {
    if (!isOpen || !inboxId) {
      stopPolling();
      if (autoCloseTimerRef.current) {
        clearTimeout(autoCloseTimerRef.current);
        autoCloseTimerRef.current = null;
      }
      setQrcodeBase64(null);
      setStatus('connecting');
      setErrorMessage(null);
      setIsInitializing(false);
      setIsDisconnecting(false);
      setTimedOut(false);
      return;
    }

    let cancelled = false;
    setIsInitializing(true);
    setErrorMessage(null);
    setTimedOut(false);

    inboxesWhatsappBackendService
      .connectWhatsapp(inboxId)
      .then((res) => {
        if (cancelled) return;
        setQrcodeBase64(res.qrcodeBase64);
        setStatus(res.status);
        setIsInitializing(false);

        // Se já veio open, não precisa polling — apenas dispara auto-close.
        if (res.status === 'open') {
          toast({ title: 'WhatsApp conectado!' });
          autoCloseTimerRef.current = setTimeout(() => {
            onOpenChange(false);
          }, 1500);
          return;
        }

        // Inicia polling
        pollTimerRef.current = setInterval(async () => {
          try {
            const next =
              await inboxesWhatsappBackendService.getWhatsappStatus(inboxId);
            if (cancelled) return;
            setStatus(next.status);
            if (next.status === 'open') {
              stopPolling();
              toast({ title: 'WhatsApp conectado!' });
              queryClient.invalidateQueries({
                queryKey: ['inboxes', inboxId, 'whatsapp-status'],
              });
              autoCloseTimerRef.current = setTimeout(() => {
                onOpenChange(false);
              }, 1500);
            }
          } catch {
            // Erros transientes no polling não derrubam o modal; só logamos.
          }
        }, POLLING_INTERVAL_MS);

        giveUpTimerRef.current = setTimeout(() => {
          stopPolling();
          if (!cancelled) setTimedOut(true);
        }, POLLING_TIMEOUT_MS);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setIsInitializing(false);
        setErrorMessage(err.message || 'Falha ao gerar QR Code');
      });

    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, inboxId]);

  const handleDisconnect = async () => {
    if (!inboxId) return;
    setIsDisconnecting(true);
    try {
      await inboxesWhatsappBackendService.disconnectWhatsapp(inboxId);
      toast({ title: 'WhatsApp desconectado.' });
      queryClient.invalidateQueries({
        queryKey: ['inboxes', inboxId, 'whatsapp-status'],
      });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: 'Erro ao desconectar',
        description: (err as Error)?.message,
        variant: 'destructive',
      });
    } finally {
      setIsDisconnecting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Conectar WhatsApp</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center justify-center gap-4 py-4 min-h-[320px]">
          {isInitializing && (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin" />
              <p className="text-sm">Gerando QR Code...</p>
            </div>
          )}

          {!isInitializing && errorMessage && (
            <div className="text-center space-y-2">
              <p className="text-sm text-destructive font-medium">
                {errorMessage}
              </p>
              <p className="text-xs text-muted-foreground">
                Verifique se a URL e API Key da Evolution estão configuradas
                em System Settings.
              </p>
            </div>
          )}

          {!isInitializing && !errorMessage && status === 'open' && (
            <div className="flex flex-col items-center gap-2">
              <CheckCircle2 className="w-16 h-16 text-green-600" />
              <p className="text-sm font-medium">Conectado!</p>
            </div>
          )}

          {!isInitializing &&
            !errorMessage &&
            status !== 'open' &&
            qrcodeBase64 && (
              <>
                <img
                  src={
                    qrcodeBase64.startsWith('data:')
                      ? qrcodeBase64
                      : `data:image/png;base64,${qrcodeBase64}`
                  }
                  alt="QR Code WhatsApp"
                  className="w-64 h-64 object-contain border rounded"
                />
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium">
                    Escaneie com o WhatsApp do celular
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Abra WhatsApp → Aparelhos conectados → Conectar aparelho
                  </p>
                  {!timedOut && (
                    <p className="text-xs text-muted-foreground inline-flex items-center gap-1 mt-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Aguardando conexão...
                    </p>
                  )}
                  {timedOut && (
                    <p className="text-xs text-orange-600 mt-1">
                      Tempo esgotado. Feche e tente novamente.
                    </p>
                  )}
                </div>
              </>
            )}

          {!isInitializing &&
            !errorMessage &&
            status !== 'open' &&
            !qrcodeBase64 && (
              <p className="text-sm text-muted-foreground">
                Nenhum QR disponível. Tente novamente.
              </p>
            )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {status === 'open' ? (
            <Button
              variant="destructive"
              onClick={handleDisconnect}
              disabled={isDisconnecting}
            >
              <Power className="w-4 h-4 mr-2" />
              {isDisconnecting ? 'Desconectando...' : 'Desconectar'}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Fechar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
