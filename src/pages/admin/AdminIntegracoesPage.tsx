/**
 * Página de Integrações — Sprint 3 T-022
 *
 * 3 abas:
 *   1. Webhooks de saída (outbound subscriptions)
 *   2. Webhooks de entrada (inbound handlers)
 *   3. Logs de entrega
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  webhooksBackendService,
  WEBHOOK_EVENTS,
  type WebhookSubscription,
  type CreatedWebhook,
  type WebhookEvent,
  type WebhookDelivery,
  type WebhookFilters,
} from '@/services/webhooks.backend.service';
import {
  apiKeysBackendService,
  type ApiKey,
  type CreatedApiKey,
} from '@/services/api-keys.backend.service';
import { inboxesBackendService } from '@/services/inboxes.backend.service';
import {
  inboundIntegrationsBackendService,
  INBOUND_HANDLERS,
  type InboundIntegration,
  type InboundHandler,
} from '@/services/inbound-integrations.backend.service';
import {
  accountIntegrationsBackendService,
  INTEGRATIONS_SENTINEL,
  type IntegrationProvider,
  type IntegrationsView,
} from '@/services/account-integrations.backend.service';
import { useAuth } from '@/contexts/AuthContext';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Checkbox,
} from '@/components/ui/checkbox';
import {
  Copy,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
  Webhook,
  Plug,
  ScrollText,
  FlaskConical,
  Pencil,
  Sparkles,
  Eraser,
} from 'lucide-react';
import { toast } from 'sonner';
import { safeFormatDateBR } from '@/utils/dateUtils';

// ---------------------------------------------------------------------------
// Schemas de formulário
// ---------------------------------------------------------------------------

const webhookSchema = z.object({
  name: z.string().min(1, 'Nome é obrigatório'),
  url: z.string().url('URL inválida'),
  events: z.array(z.string()).min(1, 'Selecione ao menos um evento'),
  active: z.boolean(),
  // Condições (anti-loop) — plano §4.3. LIGADAS por padrão.
  onlyCustomers: z.boolean(),
  excludePrivate: z.boolean(),
  inboxIds: z.array(z.string()),
});
type WebhookFormData = z.infer<typeof webhookSchema>;

/** Monta o objeto filters da assinatura a partir do formulário. */
function buildFilters(data: WebhookFormData): WebhookFilters | undefined {
  const filters: WebhookFilters = {};
  if (data.events.includes('message.created')) {
    if (data.onlyCustomers) filters.senderTypes = ['customer'];
    if (data.excludePrivate) filters.excludePrivate = true;
  }
  if (data.inboxIds.length > 0) filters.inboxIds = data.inboxIds;
  return Object.keys(filters).length > 0 ? filters : undefined;
}

const FORM_DEFAULTS: WebhookFormData = {
  name: '',
  url: '',
  events: [],
  active: true,
  onlyCustomers: true,
  excludePrivate: true,
  inboxIds: [],
};

const inboundSchema = z.object({
  slug: z
    .string()
    .min(1, 'Slug é obrigatório')
    .regex(/^[a-z0-9-]+$/, 'Slug: apenas letras minúsculas, números e hífens'),
  handler: z.string().min(1, 'Handler é obrigatório') as z.ZodType<InboundHandler>,
  configRaw: z
    .string()
    .optional()
    .refine(
      (s) => {
        if (!s || s.trim() === '') return true;
        try {
          JSON.parse(s);
          return true;
        } catch {
          return false;
        }
      },
      'JSON inválido'
    ),
});
type InboundFormData = z.infer<typeof inboundSchema>;

// ---------------------------------------------------------------------------
// Helpers de formatação
// ---------------------------------------------------------------------------

function statusBadge(status: WebhookDelivery['status']) {
  if (status === 'success')
    return (
      <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30" variant="outline">
        Sucesso
      </Badge>
    );
  if (status === 'failed')
    return (
      <Badge className="bg-red-500/10 text-red-500 border-red-500/30" variant="outline">
        Falha
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Pendente
    </Badge>
  );
}

function activeBadge(active: boolean) {
  return active ? (
    <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30" variant="outline">
      Ativo
    </Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">
      Inativo
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Aba: Webhooks de Saída
// ---------------------------------------------------------------------------

function AbaWebhooksSaida() {
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editando, setEditando] = useState<WebhookSubscription | null>(null);
  const [excluindo, setExcluindo] = useState<WebhookSubscription | null>(null);
  const [criado, setCriado] = useState<CreatedWebhook | null>(null);

  const {
    data: webhooks = [],
    isLoading,
  } = useQuery<WebhookSubscription[]>({
    queryKey: ['webhooks-saida'],
    queryFn: () => webhooksBackendService.listWebhooks(),
  });

  const form = useForm<WebhookFormData>({
    resolver: zodResolver(webhookSchema),
    defaultValues: FORM_DEFAULTS,
  });

  // Inboxes para a condição opcional "apenas destes inboxes"
  const { data: inboxes = [] } = useQuery({
    queryKey: ['inboxes'],
    queryFn: () => inboxesBackendService.listInboxes(),
  });

  const createMutation = useMutation({
    mutationFn: (data: WebhookFormData) =>
      webhooksBackendService.createWebhook({
        name: data.name,
        url: data.url,
        events: data.events as WebhookEvent[],
        filters: buildFilters(data),
        active: data.active,
      }),
    onSuccess: (data) => {
      setCriado(data);
      queryClient.invalidateQueries({ queryKey: ['webhooks-saida'] });
    },
    onError: (err: unknown) => {
      toast.error('Erro ao criar webhook: ' + ((err as { message?: string })?.message ?? 'desconhecido'));
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: WebhookFormData) =>
      webhooksBackendService.updateWebhook(editando!.id, {
        name: data.name,
        url: data.url,
        events: data.events as WebhookEvent[],
        filters: buildFilters(data) ?? {},
        active: data.active,
      }),
    onSuccess: () => {
      toast.success('Webhook atualizado');
      queryClient.invalidateQueries({ queryKey: ['webhooks-saida'] });
      fecharDialog();
    },
    onError: (err: unknown) => {
      toast.error('Erro ao atualizar: ' + ((err as { message?: string })?.message ?? 'desconhecido'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => webhooksBackendService.deleteWebhook(id),
    onSuccess: () => {
      toast.success('Webhook excluído');
      queryClient.invalidateQueries({ queryKey: ['webhooks-saida'] });
      setExcluindo(null);
    },
    onError: (err: unknown) => {
      toast.error('Erro ao excluir: ' + ((err as { message?: string })?.message ?? 'desconhecido'));
    },
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => webhooksBackendService.testWebhook(id),
    onSuccess: (res, id) => {
      const wh = webhooks.find((w) => w.id === id);
      if (res.success) {
        toast.success(`Evento de teste enviado para "${wh?.name ?? id}"`);
      } else {
        toast.error(`Falha no teste: ${res.message ?? 'erro desconhecido'}`);
      }
    },
  });

  function abrirNovoDialog() {
    setEditando(null);
    setCriado(null);
    form.reset(FORM_DEFAULTS);
    setIsDialogOpen(true);
  }

  function abrirEditarDialog(wh: WebhookSubscription) {
    setEditando(wh);
    setCriado(null);
    const f = wh.filters ?? {};
    form.reset({
      name: wh.name,
      url: wh.url,
      events: wh.events,
      active: wh.active,
      onlyCustomers: Array.isArray(f.senderTypes)
        ? f.senderTypes.includes('customer') && f.senderTypes.length === 1
        : false,
      excludePrivate: f.excludePrivate === true,
      inboxIds: Array.isArray(f.inboxIds) ? f.inboxIds : [],
    });
    setIsDialogOpen(true);
  }

  function fecharDialog() {
    setIsDialogOpen(false);
    setEditando(null);
    setCriado(null);
    form.reset();
  }

  function onSubmit(data: WebhookFormData) {
    if (editando) {
      updateMutation.mutate(data);
    } else {
      createMutation.mutate(data);
    }
  }

  const selectedEvents = form.watch('events');

  function toggleEvent(eventValue: string) {
    const current = form.getValues('events');
    if (current.includes(eventValue)) {
      form.setValue('events', current.filter((e) => e !== eventValue), { shouldValidate: true });
    } else {
      form.setValue('events', [...current, eventValue], { shouldValidate: true });
    }
  }

  async function copiarSecret() {
    if (!criado) return;
    try {
      await navigator.clipboard.writeText(criado.secret);
      toast.success('Secret copiado para a área de transferência');
    } catch {
      toast.error('Não foi possível copiar — copie manualmente');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Configure destinos que receberão eventos gerados pelo CRM via HTTP POST.
        </p>
        <Button onClick={abrirNovoDialog} className="gap-2">
          <Plus className="w-4 h-4" />
          Nova automação
        </Button>
      </div>

      <Card>
        <CardContent className="pt-4">
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : webhooks.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Webhook className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="font-medium">Nenhum webhook configurado</p>
              <p className="text-xs mt-1">
                Clique em "+ Novo Webhook" para começar.
                {/* Backend Sprint 3 pendente — retornará lista vazia até ser implementado */}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Eventos</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Última entrega</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {webhooks.map((wh) => (
                  <TableRow key={wh.id}>
                    <TableCell className="font-medium">{wh.name}</TableCell>
                    <TableCell className="max-w-[200px]">
                      <span className="text-xs font-mono truncate block" title={wh.url}>
                        {wh.url}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {wh.events.slice(0, 2).map((ev) => (
                          <Badge key={ev} variant="secondary" className="text-xs">
                            {ev}
                          </Badge>
                        ))}
                        {wh.events.length > 2 && (
                          <Badge variant="outline" className="text-xs">
                            +{wh.events.length - 2}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{activeBadge(wh.active)}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {wh.lastDeliveryAt
                        ? safeFormatDateBR(wh.lastDeliveryAt, 'dd/MM/yyyy HH:mm')
                        : 'Nunca'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Editar"
                          aria-label={`Editar webhook ${wh.name}`}
                          onClick={() => abrirEditarDialog(wh)}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Testar"
                          aria-label={`Testar webhook ${wh.name}`}
                          disabled={testMutation.isPending}
                          onClick={() => testMutation.mutate(wh.id)}
                        >
                          {testMutation.isPending && testMutation.variables === wh.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <FlaskConical className="w-4 h-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          title="Excluir"
                          aria-label={`Excluir webhook ${wh.name}`}
                          onClick={() => setExcluindo(wh)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Dialog criar/editar */}
      <Dialog open={isDialogOpen} onOpenChange={(open) => !open && fecharDialog()}>
        <DialogContent className="max-w-lg">
          {/* Após criar: exibe secret */}
          {criado ? (
            <>
              <DialogHeader>
                <DialogTitle>Webhook criado</DialogTitle>
                <DialogDescription>
                  O webhook <strong>{criado.name}</strong> foi criado com sucesso.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="rounded-lg border-2 border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
                  <div className="flex items-start gap-2">
                    <ShieldAlert className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      Copie o secret HMAC agora — não será exibido novamente.
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono bg-background/60 px-3 py-2 rounded border break-all select-all">
                      {criado.secret}
                    </code>
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={copiarSecret}
                      title="Copiar secret"
                      aria-label="Copiar secret HMAC"
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-amber-800 dark:text-amber-300/80">
                    Use este secret para validar a assinatura HMAC-SHA256 no cabeçalho
                    <code className="mx-1">x-webhook-signature</code> de cada requisição recebida.
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={fecharDialog}>Fechar</Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={form.handleSubmit(onSubmit)}>
              <DialogHeader>
                <DialogTitle>{editando ? 'Editar automação' : 'Nova automação'}</DialogTitle>
                <DialogDescription>
                  {editando
                    ? 'Atualize as configurações do webhook.'
                    : 'Configure um endpoint para receber eventos do CRM via HTTP POST.'}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                {/* Nome */}
                <div className="space-y-2">
                  <Label htmlFor="wh-name">Nome da automação</Label>
                  <Input
                    id="wh-name"
                    placeholder="Ex: Mensagem recebida → n8n (IA)"
                    {...form.register('name')}
                  />
                  {form.formState.errors.name && (
                    <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
                  )}
                </div>

                {/* QUANDO — gatilhos agrupados */}
                <div className="space-y-2">
                  <Label className="font-semibold">Quando (gatilhos)</Label>
                  <div className="border rounded-md p-3 space-y-3 max-h-56 overflow-y-auto">
                    {Array.from(new Set(WEBHOOK_EVENTS.map((e) => e.group))).map((group) => (
                      <div key={group} className="space-y-1.5">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {group}
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          {WEBHOOK_EVENTS.filter((e) => e.group === group).map((ev) => (
                            <div key={ev.value} className="flex items-center gap-2">
                              <Checkbox
                                id={`ev-${ev.value}`}
                                checked={selectedEvents.includes(ev.value)}
                                onCheckedChange={() => toggleEvent(ev.value)}
                              />
                              <Label
                                htmlFor={`ev-${ev.value}`}
                                className="text-sm cursor-pointer font-normal"
                              >
                                {ev.label}
                              </Label>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  {form.formState.errors.events && (
                    <p className="text-xs text-destructive">{form.formState.errors.events.message}</p>
                  )}
                </div>

                {/* SE — condições anti-loop (só para message.created) */}
                {selectedEvents.includes('message.created') && (
                  <div className="space-y-2">
                    <Label className="font-semibold">Se (condições)</Label>
                    <div className="border rounded-md p-3 space-y-3 bg-muted/30">
                      <div className="flex items-start gap-2">
                        <Checkbox
                          id="wh-only-customers"
                          checked={form.watch('onlyCustomers')}
                          onCheckedChange={(v) =>
                            form.setValue('onlyCustomers', v === true)
                          }
                        />
                        <div>
                          <Label htmlFor="wh-only-customers" className="text-sm cursor-pointer font-normal">
                            Apenas mensagens de clientes
                          </Label>
                          <p className="text-[11px] text-muted-foreground">
                            Impede que a resposta da própria IA dispare a automação de novo (loop).
                          </p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2">
                        <Checkbox
                          id="wh-exclude-private"
                          checked={form.watch('excludePrivate')}
                          onCheckedChange={(v) =>
                            form.setValue('excludePrivate', v === true)
                          }
                        />
                        <Label htmlFor="wh-exclude-private" className="text-sm cursor-pointer font-normal">
                          Ignorar notas internas
                        </Label>
                      </div>
                      {inboxes.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-sm">Apenas destes inboxes (opcional)</p>
                          <div className="grid grid-cols-2 gap-2">
                            {inboxes.map((ib) => {
                              const selected = form.watch('inboxIds').includes(ib.id);
                              return (
                                <div key={ib.id} className="flex items-center gap-2">
                                  <Checkbox
                                    id={`wh-ib-${ib.id}`}
                                    checked={selected}
                                    onCheckedChange={() => {
                                      const cur = form.getValues('inboxIds');
                                      form.setValue(
                                        'inboxIds',
                                        selected
                                          ? cur.filter((i) => i !== ib.id)
                                          : [...cur, ib.id]
                                      );
                                    }}
                                  />
                                  <Label
                                    htmlFor={`wh-ib-${ib.id}`}
                                    className="text-sm cursor-pointer font-normal truncate"
                                  >
                                    {ib.name}
                                  </Label>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ENTÃO — destino */}
                <div className="space-y-2">
                  <Label htmlFor="wh-url" className="font-semibold">
                    Então (dispara webhook para)
                  </Label>
                  <Input
                    id="wh-url"
                    placeholder="https://seu-n8n.com/webhook/abc"
                    {...form.register('url')}
                  />
                  {form.formState.errors.url && (
                    <p className="text-xs text-destructive">{form.formState.errors.url.message}</p>
                  )}
                </div>

                {/* Ativo */}
                <div className="flex items-center gap-3">
                  <Switch
                    id="wh-active"
                    checked={form.watch('active')}
                    onCheckedChange={(v) => form.setValue('active', v)}
                  />
                  <Label htmlFor="wh-active" className="cursor-pointer">
                    Ativo
                  </Label>
                </div>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={fecharDialog}>
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                >
                  {(createMutation.isPending || updateMutation.isPending) && (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  )}
                  {editando ? 'Salvar' : 'Criar'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirmar exclusão */}
      <AlertDialog open={!!excluindo} onOpenChange={(open) => !open && setExcluindo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir webhook?</AlertDialogTitle>
            <AlertDialogDescription>
              O webhook <strong>{excluindo?.name}</strong> será removido permanentemente
              e nenhum evento futuro será enviado para {excluindo?.url}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => excluindo && deleteMutation.mutate(excluindo.id)}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba: Webhooks de Entrada
// ---------------------------------------------------------------------------

function AbaWebhooksEntrada() {
  const { account } = useAuth();
  const accountId = account?.id ?? '';
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [excluindo, setExcluindo] = useState<InboundIntegration | null>(null);

  const { data: integracoes = [], isLoading } = useQuery<InboundIntegration[]>({
    queryKey: ['webhooks-entrada', accountId],
    queryFn: () => inboundIntegrationsBackendService.listInbound(accountId),
  });

  const form = useForm<InboundFormData>({
    resolver: zodResolver(inboundSchema),
    defaultValues: { slug: '', handler: 'contact_upsert', configRaw: '{}' },
  });

  const createMutation = useMutation({
    mutationFn: (data: InboundFormData) => {
      let config: Record<string, unknown> = {};
      try { config = JSON.parse(data.configRaw || '{}'); } catch { /* usa {} */ }
      return inboundIntegrationsBackendService.createInbound(
        { slug: data.slug, handler: data.handler as InboundHandler, config },
        accountId
      );
    },
    onSuccess: () => {
      toast.success('Handler criado com sucesso');
      queryClient.invalidateQueries({ queryKey: ['webhooks-entrada', accountId] });
      fecharDialog();
    },
    onError: (err: unknown) => {
      toast.error('Erro ao criar handler: ' + ((err as { message?: string })?.message ?? 'desconhecido'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (slug: string) => inboundIntegrationsBackendService.deleteInbound(slug),
    onSuccess: () => {
      toast.success('Handler removido');
      queryClient.invalidateQueries({ queryKey: ['webhooks-entrada', accountId] });
      setExcluindo(null);
    },
    onError: (err: unknown) => {
      toast.error('Erro ao remover: ' + ((err as { message?: string })?.message ?? 'desconhecido'));
    },
  });

  function fecharDialog() {
    setIsDialogOpen(false);
    form.reset({ slug: '', handler: 'contact_upsert', configRaw: '{}' });
  }

  async function copiarUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('URL copiada');
    } catch {
      toast.error('Não foi possível copiar');
    }
  }

  const handlerSelecionado = form.watch('handler');
  const slugAtual = form.watch('slug');
  const urlPronta = !!(accountId && slugAtual);
  const urlExemplo = urlPronta
    ? `${window.location.origin}/api/integrations/inbound-receive/${accountId}/${slugAtual}`
    : '';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Receba dados de sistemas externos (n8n, Zapier, Pacto, etc.) via HTTP POST.
        </p>
        <Button onClick={() => setIsDialogOpen(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          Novo Handler
        </Button>
      </div>

      <Card>
        <CardContent className="pt-4">
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : integracoes.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Plug className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="font-medium">Nenhum handler configurado</p>
              <p className="text-xs mt-1">
                Crie um handler para receber dados de sistemas externos.
                {/* Backend Sprint 3 pendente */}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {integracoes.map((int) => {
                const handlerInfo = INBOUND_HANDLERS.find((h) => h.value === int.handler);
                return (
                  <div
                    key={int.slug}
                    className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg border bg-card"
                  >
                    <div className="flex-1 space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{int.slug}</span>
                        <Badge variant="secondary" className="text-xs">
                          {handlerInfo?.label ?? int.handler}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <code className="text-xs text-muted-foreground truncate">
                          {int.webhookUrl}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 flex-shrink-0"
                          onClick={() => copiarUrl(int.webhookUrl)}
                          title="Copiar URL"
                          aria-label={`Copiar URL do handler ${int.slug}`}
                        >
                          <Copy className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive flex-shrink-0"
                      onClick={() => setExcluindo(int)}
                      title="Remover handler"
                      aria-label={`Remover handler ${int.slug}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialog criar handler */}
      <Dialog open={isDialogOpen} onOpenChange={(open) => !open && fecharDialog()}>
        <DialogContent className="max-w-lg">
          <form onSubmit={form.handleSubmit((data) => createMutation.mutate(data))}>
            <DialogHeader>
              <DialogTitle>Novo Handler de Entrada</DialogTitle>
              <DialogDescription>
                Crie um endpoint para receber dados de um sistema externo.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* Slug */}
              <div className="space-y-2">
                <Label htmlFor="ib-slug">Slug (identificador único)</Label>
                <Input
                  id="ib-slug"
                  placeholder="pacto-checkin"
                  {...form.register('slug')}
                />
                {form.formState.errors.slug && (
                  <p className="text-xs text-destructive">{form.formState.errors.slug.message}</p>
                )}
              </div>

              {/* Handler */}
              <div className="space-y-2">
                <Label>Handler</Label>
                <Select
                  value={handlerSelecionado}
                  onValueChange={(v) => form.setValue('handler', v as InboundHandler)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione um handler" />
                  </SelectTrigger>
                  <SelectContent>
                    {INBOUND_HANDLERS.map((h) => (
                      <SelectItem key={h.value} value={h.value}>
                        {h.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {handlerSelecionado && (
                  <p className="text-xs text-muted-foreground">
                    {INBOUND_HANDLERS.find((h) => h.value === handlerSelecionado)?.descricao}
                  </p>
                )}
              </div>

              {/* Config JSON */}
              <div className="space-y-2">
                <Label htmlFor="ib-config">Configuração (JSON)</Label>
                <Textarea
                  id="ib-config"
                  className="font-mono text-xs"
                  rows={4}
                  placeholder='{"tagId": "abc123"}'
                  aria-invalid={!!form.formState.errors.configRaw}
                  {...form.register('configRaw')}
                />
                {form.formState.errors.configRaw && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.configRaw.message}
                  </p>
                )}
              </div>

              {/* URL gerada */}
              {urlPronta && (
                <div className="space-y-2">
                  <Label>URL gerada</Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono bg-muted px-3 py-2 rounded border break-all">
                      {urlExemplo}
                    </code>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      onClick={() => copiarUrl(urlExemplo)}
                      aria-label="Copiar URL gerada"
                      title="Copiar URL gerada"
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}

              {/* Exemplo cURL */}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Exemplo cURL</Label>
                {urlPronta ? (
                  <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto whitespace-pre-wrap">
{`curl -X POST "${urlExemplo}" \\
  -H "Content-Type: application/json" \\
  -d '{"contactId": "xxx", "telefone": "5511999999999"}'`}
                  </pre>
                ) : (
                  <p className="text-xs text-muted-foreground italic px-3 py-2 bg-muted rounded-md">
                    &lt;preencha slug acima&gt;
                  </p>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={fecharDialog}>
                Cancelar
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Criar Handler
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Confirmar exclusão */}
      <AlertDialog open={!!excluindo} onOpenChange={(open) => !open && setExcluindo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover handler?</AlertDialogTitle>
            <AlertDialogDescription>
              O handler <strong>{excluindo?.slug}</strong> será removido e a URL{' '}
              <code className="text-xs">{excluindo?.webhookUrl}</code> deixará de funcionar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => excluindo && deleteMutation.mutate(excluindo.slug)}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba: Logs de entrega
// ---------------------------------------------------------------------------

function AbaLogs() {
  const {
    data: webhooks = [],
    isLoading: loadingWebhooks,
  } = useQuery<WebhookSubscription[]>({
    queryKey: ['webhooks-saida'],
    queryFn: () => webhooksBackendService.listWebhooks(),
  });

  const [selectedWebhookId, setSelectedWebhookId] = useState<string>('');

  const { data: deliveries = [], isLoading: loadingDeliveries } = useQuery<WebhookDelivery[]>({
    queryKey: ['webhook-deliveries', selectedWebhookId],
    queryFn: () => webhooksBackendService.getDeliveries(selectedWebhookId, 50),
    enabled: !!selectedWebhookId,
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Histórico das últimas 50 entregas de cada webhook.
      </p>

      <div className="flex items-center gap-3">
        <Label className="whitespace-nowrap">Webhook:</Label>
        {loadingWebhooks ? (
          <Skeleton className="h-9 w-48" />
        ) : (
          <Select value={selectedWebhookId} onValueChange={setSelectedWebhookId}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Selecione um webhook" />
            </SelectTrigger>
            <SelectContent>
              {webhooks.map((wh) => (
                <SelectItem key={wh.id} value={wh.id}>
                  {wh.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <Card>
        <CardContent className="pt-4">
          {!selectedWebhookId ? (
            <div className="text-center py-12 text-muted-foreground">
              <ScrollText className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>Selecione um webhook acima para ver os logs.</p>
            </div>
          ) : loadingDeliveries ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : deliveries.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <ScrollText className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>Nenhuma entrega registrada ainda.</p>
              {/* Backend Sprint 3 pendente */}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Evento</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Latência</TableHead>
                  <TableHead>Tentativas</TableHead>
                  <TableHead>Data</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <code className="text-xs">{d.eventName}</code>
                    </TableCell>
                    <TableCell className="max-w-[160px]">
                      <span className="text-xs truncate block" title={d.url}>{d.url}</span>
                    </TableCell>
                    <TableCell>{statusBadge(d.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {d.latencyMs != null ? `${d.latencyMs} ms` : '-'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {d.retryCount}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {safeFormatDateBR(d.createdAt, 'dd/MM HH:mm')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba: IA (chaves OpenAI / Anthropic) — T-025
// ---------------------------------------------------------------------------

interface ProviderCardProps {
  provider: IntegrationProvider;
  titulo: string;
  descricao: string;
  placeholderFormato: string;
  configurado: boolean;
  inputValue: string;
  onInputChange: (v: string) => void;
  onSave: () => void;
  onClear: () => void;
  onTest: () => void;
  saving: boolean;
  clearing: boolean;
  testing: boolean;
  dirty: boolean;
}

function AIProviderCard({
  provider,
  titulo,
  descricao,
  placeholderFormato,
  configurado,
  inputValue,
  onInputChange,
  onSave,
  onClear,
  onTest,
  saving,
  clearing,
  testing,
  dirty,
}: ProviderCardProps) {
  const inputId = `ai-${provider}-key`;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-muted-foreground" />
          {titulo}
          {configurado ? (
            <Badge
              className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30"
              variant="outline"
            >
              Configurada
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              Nao configurada
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{descricao}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={inputId}>Chave de API</Label>
          <Input
            id={inputId}
            type="password"
            autoComplete="off"
            placeholder={configurado ? '•••• configurada' : placeholderFormato}
            value={inputValue}
            onChange={(e) => onInputChange(e.target.value)}
            aria-label={`Chave ${titulo}`}
          />
          <p className="text-xs text-muted-foreground">
            {configurado
              ? 'Deixe em branco para manter a chave atual. Digite uma nova chave para substituir.'
              : 'Cole sua chave de API para habilitar o provider.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={onSave}
            disabled={saving || !dirty || inputValue.trim() === ''}
            className="gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Salvar
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onTest}
            disabled={testing || !configurado}
            className="gap-2"
            title={!configurado ? 'Salve a chave antes de testar' : 'Testar conexao'}
          >
            {testing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <FlaskConical className="w-4 h-4" />
            )}
            Testar
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onClear}
            disabled={clearing || !configurado}
            className="gap-2 text-destructive hover:text-destructive"
          >
            {clearing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Eraser className="w-4 h-4" />
            )}
            Limpar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AbaIA() {
  const queryClient = useQueryClient();
  const [openaiInput, setOpenaiInput] = useState('');
  const [anthropicInput, setAnthropicInput] = useState('');

  const { data, isLoading } = useQuery<IntegrationsView>({
    queryKey: ['admin-integrations-ai'],
    queryFn: () => accountIntegrationsBackendService.getIntegrations(),
  });

  const openaiConfigurado = data?.openaiApiKey === INTEGRATIONS_SENTINEL;
  const anthropicConfigurado = data?.anthropicApiKey === INTEGRATIONS_SENTINEL;

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['admin-integrations-ai'] });
  }

  const saveOpenaiMutation = useMutation({
    mutationFn: () =>
      accountIntegrationsBackendService.updateIntegrations({ openaiApiKey: openaiInput.trim() }),
    onSuccess: () => {
      toast.success('Chave OpenAI atualizada');
      setOpenaiInput('');
      invalidate();
    },
    onError: (err: unknown) => {
      toast.error('Erro ao salvar OpenAI: ' + ((err as { message?: string })?.message ?? 'desconhecido'));
    },
  });

  const clearOpenaiMutation = useMutation({
    mutationFn: () =>
      accountIntegrationsBackendService.updateIntegrations({ openaiApiKey: null }),
    onSuccess: () => {
      toast.success('Chave OpenAI removida');
      setOpenaiInput('');
      invalidate();
    },
    onError: (err: unknown) => {
      toast.error('Erro ao remover OpenAI: ' + ((err as { message?: string })?.message ?? 'desconhecido'));
    },
  });

  // T-025/BUG-02: o backend SEMPRE responde 200 ao test/:provider, com
  // {ok:true|false, message}. Sem checar res.ok explicitamente o toast nao
  // aparecia (success path silenciava o erro). Agora garantimos toast em
  // qualquer caminho, com fallback de mensagem se o backend nao enviar.
  const testOpenaiMutation = useMutation({
    mutationFn: () => accountIntegrationsBackendService.testProvider('openai'),
    onSuccess: (res) => {
      const msg = res?.message?.trim();
      if (res?.ok) {
        toast.success(`OpenAI: ${msg || 'conexao OK'}`);
      } else {
        toast.error(`OpenAI: ${msg || 'falha no teste (chave invalida ou expirada)'}`);
      }
    },
    onError: (err: unknown) => {
      toast.error('Erro ao testar OpenAI: ' + ((err as { message?: string })?.message ?? 'desconhecido'));
    },
  });

  const saveAnthropicMutation = useMutation({
    mutationFn: () =>
      accountIntegrationsBackendService.updateIntegrations({
        anthropicApiKey: anthropicInput.trim(),
      }),
    onSuccess: () => {
      toast.success('Chave Anthropic atualizada');
      setAnthropicInput('');
      invalidate();
    },
    onError: (err: unknown) => {
      toast.error('Erro ao salvar Anthropic: ' + ((err as { message?: string })?.message ?? 'desconhecido'));
    },
  });

  const clearAnthropicMutation = useMutation({
    mutationFn: () =>
      accountIntegrationsBackendService.updateIntegrations({ anthropicApiKey: null }),
    onSuccess: () => {
      toast.success('Chave Anthropic removida');
      setAnthropicInput('');
      invalidate();
    },
    onError: (err: unknown) => {
      toast.error('Erro ao remover Anthropic: ' + ((err as { message?: string })?.message ?? 'desconhecido'));
    },
  });

  // T-025/BUG-02 (idem testOpenaiMutation): toast garantido em ok=false.
  const testAnthropicMutation = useMutation({
    mutationFn: () => accountIntegrationsBackendService.testProvider('anthropic'),
    onSuccess: (res) => {
      const msg = res?.message?.trim();
      if (res?.ok) {
        toast.success(`Anthropic: ${msg || 'conexao OK'}`);
      } else {
        toast.error(`Anthropic: ${msg || 'falha no teste (chave invalida ou expirada)'}`);
      }
    },
    onError: (err: unknown) => {
      toast.error('Erro ao testar Anthropic: ' + ((err as { message?: string })?.message ?? 'desconhecido'));
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Configure as chaves de API dos provedores de IA usados pela sua conta. As chaves ficam
        armazenadas com seguranca e nunca sao exibidas apos serem salvas — somente o status
        (configurada / nao configurada).
      </p>

      <AIProviderCard
        provider="openai"
        titulo="OpenAI"
        descricao="Usada por modelos GPT (transcricao de audio, IA conversacional, embeddings)."
        placeholderFormato="sk-..."
        configurado={openaiConfigurado}
        inputValue={openaiInput}
        onInputChange={setOpenaiInput}
        onSave={() => saveOpenaiMutation.mutate()}
        onClear={() => clearOpenaiMutation.mutate()}
        onTest={() => testOpenaiMutation.mutate()}
        saving={saveOpenaiMutation.isPending}
        clearing={clearOpenaiMutation.isPending}
        testing={testOpenaiMutation.isPending}
        dirty={openaiInput.trim().length > 0}
      />

      <AIProviderCard
        provider="anthropic"
        titulo="Anthropic (Claude)"
        descricao="Usada por modelos Claude (analise, sumarizacao, respostas longas)."
        placeholderFormato="sk-ant-..."
        configurado={anthropicConfigurado}
        inputValue={anthropicInput}
        onInputChange={setAnthropicInput}
        onSave={() => saveAnthropicMutation.mutate()}
        onClear={() => clearAnthropicMutation.mutate()}
        onTest={() => testAnthropicMutation.mutate()}
        saving={saveAnthropicMutation.isPending}
        clearing={clearAnthropicMutation.isPending}
        testing={testAnthropicMutation.isPending}
        dirty={anthropicInput.trim().length > 0}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba: Chaves de API (plano §4.3) — duas seções OPOSTAS:
//   1. Chaves do CRM: o CRM GERA (glk_) pra sistemas externos nos acessarem.
//   2. Provedores de IA: você COLA a chave de fora pro CRM consumir IA.
// ---------------------------------------------------------------------------

function SecaoChavesCrm() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const accountId = user?.account_id ?? '';

  const [dialogOpen, setDialogOpen] = useState(false);
  const [nomeChave, setNomeChave] = useState('');
  const [criada, setCriada] = useState<CreatedApiKey | null>(null);
  const [revogando, setRevogando] = useState<ApiKey | null>(null);

  const { data: chaves = [], isLoading } = useQuery({
    queryKey: ['api-keys', accountId],
    queryFn: () => apiKeysBackendService.listApiKeys(accountId),
    enabled: Boolean(accountId),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiKeysBackendService.createApiKey(accountId, { name: nomeChave.trim() }),
    onSuccess: (data) => {
      setCriada(data);
      setNomeChave('');
      queryClient.invalidateQueries({ queryKey: ['api-keys', accountId] });
    },
    onError: (err: unknown) => {
      toast.error(
        'Erro ao gerar chave: ' + ((err as { message?: string })?.message ?? 'desconhecido')
      );
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiKeysBackendService.revokeApiKey(id, accountId),
    onSuccess: () => {
      toast.success('Chave revogada');
      setRevogando(null);
      queryClient.invalidateQueries({ queryKey: ['api-keys', accountId] });
    },
    onError: (err: unknown) => {
      toast.error(
        'Erro ao revogar: ' + ((err as { message?: string })?.message ?? 'desconhecido')
      );
    },
  });

  async function copiarChave() {
    if (!criada) return;
    try {
      await navigator.clipboard.writeText(criada.plaintextKey);
      toast.success('Chave copiada para a área de transferência');
    } catch {
      toast.error('Não foi possível copiar — copie manualmente');
    }
  }

  const ativas = chaves.filter((c) => !c.revokedAt);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Chaves do CRM</CardTitle>
        <p className="text-sm text-muted-foreground">
          Gere uma chave para que sistemas externos (n8n, ERP) acessem os
          endpoints do CRM. Formato: <code className="text-xs">glk_…</code>
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-end">
          <Button
            size="sm"
            className="gap-2"
            onClick={() => {
              setCriada(null);
              setNomeChave('');
              setDialogOpen(true);
            }}
          >
            <Plus className="w-4 h-4" />
            Gerar chave
          </Button>
        </div>

        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : ativas.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            Nenhuma chave ativa. Gere uma para conectar o n8n/ERP.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Prefixo</TableHead>
                <TableHead>Criada em</TableHead>
                <TableHead>Último uso</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ativas.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell>
                    <code className="text-xs">{k.prefix}…</code>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {safeFormatDateBR(k.createdAt, 'dd/MM/yyyy')}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {k.lastUsedAt
                      ? safeFormatDateBR(k.lastUsedAt, 'dd/MM/yyyy HH:mm')
                      : 'Nunca'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setRevogando(k)}
                    >
                      Revogar
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* Dialog gerar chave */}
        <Dialog open={dialogOpen} onOpenChange={(open) => !open && setDialogOpen(false)}>
          <DialogContent className="max-w-md">
            {criada ? (
              <>
                <DialogHeader>
                  <DialogTitle>Chave gerada</DialogTitle>
                  <DialogDescription>
                    Guarde agora — <strong>não será exibida novamente</strong>.
                  </DialogDescription>
                </DialogHeader>
                <div className="rounded-lg border-2 border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono bg-background/60 px-3 py-2 rounded border break-all select-all">
                      {criada.plaintextKey}
                    </code>
                    <Button size="icon" variant="outline" onClick={copiarChave} title="Copiar chave">
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                <DialogFooter>
                  <Button onClick={() => setDialogOpen(false)}>Fechar</Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Gerar chave de API</DialogTitle>
                  <DialogDescription>
                    Dê um nome que identifique quem vai usar (ex.: n8n produção).
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-2 py-2">
                  <Label htmlFor="ak-name">Nome</Label>
                  <Input
                    id="ak-name"
                    placeholder="Ex: n8n produção"
                    value={nomeChave}
                    onChange={(e) => setNomeChave(e.target.value)}
                  />
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDialogOpen(false)}>
                    Cancelar
                  </Button>
                  <Button
                    onClick={() => createMutation.mutate()}
                    disabled={nomeChave.trim().length < 2 || createMutation.isPending}
                  >
                    {createMutation.isPending && (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    )}
                    Gerar
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>

        {/* Confirmar revogação */}
        <AlertDialog open={!!revogando} onOpenChange={(open) => !open && setRevogando(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revogar chave?</AlertDialogTitle>
              <AlertDialogDescription>
                A chave <strong>{revogando?.name}</strong> deixará de funcionar
                imediatamente. Sistemas que a usam perderão o acesso.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={revokeMutation.isPending}>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => revogando && revokeMutation.mutate(revogando.id)}
                disabled={revokeMutation.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {revokeMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Revogar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

function AbaChavesApi() {
  return (
    <div className="space-y-6">
      <SecaoChavesCrm />
      <div>
        <div className="mb-3">
          <h3 className="text-base font-semibold">Provedores de IA</h3>
          <p className="text-sm text-muted-foreground">
            Cole a chave do provedor (OpenAI/Anthropic) para o CRM consumir IA.
          </p>
        </div>
        <AbaIA />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aba: Automações (plano §4.3) — regras de saída + webhooks de entrada
// ---------------------------------------------------------------------------

function GuiaN8n() {
  const [aberto, setAberto] = useState(false);
  return (
    <Card>
      <CardHeader
        className="cursor-pointer py-3"
        onClick={() => setAberto((v) => !v)}
      >
        <CardTitle className="text-sm flex items-center justify-between">
          Como conectar o n8n
          <span className="text-muted-foreground text-xs">
            {aberto ? 'ocultar' : 'ver os 3 passos'}
          </span>
        </CardTitle>
      </CardHeader>
      {aberto && (
        <CardContent className="text-sm text-muted-foreground space-y-1.5 pt-0">
          <p>1. Gere a chave em <strong>Chaves de API</strong> → use como <code className="text-xs">GLEPS_API_KEY</code> no n8n.</p>
          <p>2. Crie a regra <strong>Mensagem recebida (só clientes)</strong> apontando pra URL do n8n → copie o <strong>secret</strong> exibido → <code className="text-xs">GLEPS_WEBHOOK_SECRET</code>.</p>
          <p>3. Clique <strong>Testar</strong> na regra e confira o 200 no n8n.</p>
        </CardContent>
      )}
    </Card>
  );
}

function AbaAutomacoes() {
  return (
    <div className="space-y-6">
      <GuiaN8n />
      <AbaWebhooksSaida />
      <div>
        <div className="mb-3">
          <h3 className="text-base font-semibold">Webhooks de entrada</h3>
          <p className="text-sm text-muted-foreground">
            Endpoints que recebem chamadas de sistemas externos para dentro do CRM.
          </p>
        </div>
        <AbaWebhooksEntrada />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página raiz
// ---------------------------------------------------------------------------

export default function AdminIntegracoesPage() {
  return (
    <div className="page-container space-y-6">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground flex items-center gap-2">
            <Webhook className="w-6 h-6" />
            Integrações
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Gerencie webhooks de saída, handlers de entrada e logs de entrega.
          </p>
        </div>
      </div>

      {/* PLANO-INTEGRACOES §2: 3 abas pelo modelo mental do operador.
          A antiga aba "IA" migrou para dentro de "Chaves de API". */}
      <Tabs defaultValue="automacoes">
        <TabsList className="w-full sm:grid sm:grid-cols-3">
          <TabsTrigger value="automacoes" className="gap-2">
            <Webhook className="w-4 h-4" />
            Automações
          </TabsTrigger>
          <TabsTrigger value="chaves" className="gap-2">
            <Sparkles className="w-4 h-4" />
            Chaves de API
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-2">
            <ScrollText className="w-4 h-4" />
            Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="automacoes" className="mt-4">
          <AbaAutomacoes />
        </TabsContent>

        <TabsContent value="chaves" className="mt-4">
          <AbaChavesApi />
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <AbaLogs />
        </TabsContent>
      </Tabs>
    </div>
  );
}
