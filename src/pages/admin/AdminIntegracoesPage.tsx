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
} from '@/services/webhooks.backend.service';
import {
  inboundIntegrationsBackendService,
  INBOUND_HANDLERS,
  type InboundIntegration,
  type InboundHandler,
} from '@/services/inbound-integrations.backend.service';
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
});
type WebhookFormData = z.infer<typeof webhookSchema>;

const inboundSchema = z.object({
  slug: z
    .string()
    .min(1, 'Slug é obrigatório')
    .regex(/^[a-z0-9-]+$/, 'Slug: apenas letras minúsculas, números e hífens'),
  handler: z.string().min(1, 'Handler é obrigatório') as z.ZodType<InboundHandler>,
  configRaw: z.string().optional(),
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
    defaultValues: { name: '', url: '', events: [], active: true },
  });

  const createMutation = useMutation({
    mutationFn: (data: WebhookFormData) =>
      webhooksBackendService.createWebhook({
        name: data.name,
        url: data.url,
        events: data.events as WebhookEvent[],
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
    form.reset({ name: '', url: '', events: [], active: true });
    setIsDialogOpen(true);
  }

  function abrirEditarDialog(wh: WebhookSubscription) {
    setEditando(wh);
    setCriado(null);
    form.reset({ name: wh.name, url: wh.url, events: wh.events, active: wh.active });
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
          Novo Webhook
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
                          onClick={() => abrirEditarDialog(wh)}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Testar"
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
                    <Button size="icon" variant="outline" onClick={copiarSecret} title="Copiar secret">
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-amber-800 dark:text-amber-300/80">
                    Use este secret para validar a assinatura HMAC-SHA256 no cabeçalho
                    <code className="mx-1">X-Gleps-Signature</code> de cada requisição recebida.
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
                <DialogTitle>{editando ? 'Editar Webhook' : 'Novo Webhook'}</DialogTitle>
                <DialogDescription>
                  {editando
                    ? 'Atualize as configurações do webhook.'
                    : 'Configure um endpoint para receber eventos do CRM via HTTP POST.'}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                {/* Nome */}
                <div className="space-y-2">
                  <Label htmlFor="wh-name">Nome</Label>
                  <Input
                    id="wh-name"
                    placeholder="Ex: Notificação ERP"
                    {...form.register('name')}
                  />
                  {form.formState.errors.name && (
                    <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
                  )}
                </div>

                {/* URL */}
                <div className="space-y-2">
                  <Label htmlFor="wh-url">URL de destino</Label>
                  <Input
                    id="wh-url"
                    placeholder="https://meuservidor.com/webhook"
                    {...form.register('url')}
                  />
                  {form.formState.errors.url && (
                    <p className="text-xs text-destructive">{form.formState.errors.url.message}</p>
                  )}
                </div>

                {/* Eventos */}
                <div className="space-y-2">
                  <Label>Eventos</Label>
                  <div className="grid grid-cols-2 gap-2 border rounded-md p-3">
                    {WEBHOOK_EVENTS.map((ev) => (
                      <div key={ev.value} className="flex items-center gap-2">
                        <Checkbox
                          id={`ev-${ev.value}`}
                          checked={selectedEvents.includes(ev.value)}
                          onCheckedChange={() => toggleEvent(ev.value)}
                        />
                        <Label htmlFor={`ev-${ev.value}`} className="text-sm cursor-pointer font-normal">
                          {ev.label}
                        </Label>
                      </div>
                    ))}
                  </div>
                  {form.formState.errors.events && (
                    <p className="text-xs text-destructive">{form.formState.errors.events.message}</p>
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
  const urlExemplo = accountId && slugAtual
    ? `${window.location.origin}/api/integrations/inbound-receive/${accountId}/${slugAtual}`
    : '/api/integrations/inbound-receive/:accountId/:slug';

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
                  {...form.register('configRaw')}
                />
              </div>

              {/* URL gerada */}
              {slugAtual && (
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
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}

              {/* Exemplo cURL */}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Exemplo cURL</Label>
                <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto whitespace-pre-wrap">
{`curl -X POST "${urlExemplo}" \\
  -H "Content-Type: application/json" \\
  -d '{"contactId": "xxx", "telefone": "5511999999999"}'`}
                </pre>
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

      <Tabs defaultValue="saida">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="saida" className="gap-2">
            <Webhook className="w-4 h-4" />
            Webhooks de saída
          </TabsTrigger>
          <TabsTrigger value="entrada" className="gap-2">
            <Plug className="w-4 h-4" />
            Webhooks de entrada
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-2">
            <ScrollText className="w-4 h-4" />
            Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="saida" className="mt-4">
          <AbaWebhooksSaida />
        </TabsContent>

        <TabsContent value="entrada" className="mt-4">
          <AbaWebhooksEntrada />
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <AbaLogs />
        </TabsContent>
      </Tabs>
    </div>
  );
}
