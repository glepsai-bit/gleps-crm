/**
 * TRACKING (Meta Ads / CTWA) — inteligência de rastreamento.
 *
 * Duas áreas:
 *  1. Conexão Meta (por conta): token da BM + pixel/dataset + conta de
 *     anúncios + toggles de quais eventos enviar via Conversions API.
 *  2. Funil de métricas: Gasto → Conversas de anúncio → Reuniões → Vendas,
 *     total e por anúncio, com custo por etapa.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Radar, Save } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
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
import { useToast } from '@/hooks/use-toast';
import {
  trackingBackendService,
  type TrackingConfigInput,
} from '@/services/tracking.backend.service';

const brl = (v: number | null | undefined) =>
  v == null
    ? '—'
    : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function AdminTrackingPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [days, setDays] = useState(30);
  const [form, setForm] = useState<TrackingConfigInput>({});
  const [tokenInput, setTokenInput] = useState('');

  const configQuery = useQuery({
    queryKey: ['tracking-config'],
    queryFn: () => trackingBackendService.getConfig(),
  });

  const funnelQuery = useQuery({
    queryKey: ['tracking-funnel', days],
    queryFn: () => trackingBackendService.getFunnel(days),
  });

  const eventsQuery = useQuery({
    queryKey: ['tracking-events'],
    queryFn: () => trackingBackendService.listEvents(20),
  });

  // Hidrata o form quando a config chega
  useEffect(() => {
    const c = configQuery.data;
    if (!c) return;
    setForm({
      pixelId: c.pixelId ?? '',
      adAccountId: c.adAccountId ?? '',
      active: c.active,
      sendLead: c.sendLead,
      sendSchedule: c.sendSchedule,
      sendPurchase: c.sendPurchase,
    });
  }, [configQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (input: TrackingConfigInput) =>
      trackingBackendService.saveConfig(input),
    onSuccess: () => {
      toast({ title: 'Configuração salva' });
      setTokenInput('');
      queryClient.invalidateQueries({ queryKey: ['tracking-config'] });
      queryClient.invalidateQueries({ queryKey: ['tracking-funnel'] });
    },
    onError: (err: unknown) => {
      toast({
        title: 'Erro ao salvar',
        description: err instanceof Error ? err.message : 'Tente novamente',
        variant: 'destructive',
      });
    },
  });

  const handleSave = () => {
    const payload: TrackingConfigInput = { ...form };
    if (tokenInput.trim()) payload.accessToken = tokenInput.trim();
    saveMutation.mutate(payload);
  };

  const config = configQuery.data;
  const funnel = funnelQuery.data;
  const totals = funnel?.totals;

  return (
    <div className="p-4 lg:p-6 space-y-6 max-w-6xl">
      <div className="flex items-center gap-2">
        <Radar className="w-6 h-6 text-primary" />
        <div>
          <h1 className="text-xl font-bold">Tracking de Anúncios</h1>
          <p className="text-sm text-muted-foreground">
            Meta Ads (Click-to-WhatsApp): origem das conversas, funil e envio
            de conversões reais pra Meta.
          </p>
        </div>
      </div>

      {/* ============ Conexão Meta ============ */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            Conexão com a Meta
            {config?.active ? (
              <Badge className="bg-emerald-600 text-white">Ativo</Badge>
            ) : (
              <Badge variant="outline">Inativo</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Gere um token de usuário do sistema na sua Business Manager com
            permissões de anúncios e informe o pixel/dataset e a conta de
            anúncios. Uma conexão por conta.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="tk-token">
                Token de acesso{' '}
                {config?.hasToken && (
                  <span className="text-muted-foreground font-normal">
                    (salvo ····{config.tokenLast4})
                  </span>
                )}
              </Label>
              <Input
                id="tk-token"
                type="password"
                placeholder={config?.hasToken ? 'Preencher só para trocar' : 'EAAG...'}
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tk-pixel">ID do Pixel / Dataset</Label>
              <Input
                id="tk-pixel"
                placeholder="ex.: 1234567890"
                value={form.pixelId ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, pixelId: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tk-adacc">ID da Conta de Anúncios</Label>
              <Input
                id="tk-adacc"
                placeholder="ex.: act_123456 ou 123456"
                value={form.adAccountId ?? ''}
                onChange={(e) =>
                  setForm((f) => ({ ...f, adAccountId: e.target.value }))
                }
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            {(
              [
                ['active', 'Tracking ativo'],
                ['sendLead', 'Enviar conversa real (Lead)'],
                ['sendSchedule', 'Enviar reunião agendada (Schedule)'],
                ['sendPurchase', 'Enviar venda (Purchase)'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="flex items-center gap-2">
                <Switch
                  id={`tk-${key}`}
                  checked={Boolean(form[key])}
                  onCheckedChange={(checked) =>
                    setForm((f) => ({ ...f, [key]: checked }))
                  }
                />
                <Label htmlFor={`tk-${key}`} className="text-sm font-normal">
                  {label}
                </Label>
              </div>
            ))}
          </div>

          <Button onClick={handleSave} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-1" />
            )}
            Salvar configuração
          </Button>
        </CardContent>
      </Card>

      {/* ============ Funil ============ */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Funil de resultados</h2>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Últimos 7 dias</SelectItem>
            <SelectItem value="30">Últimos 30 dias</SelectItem>
            <SelectItem value="90">Últimos 90 dias</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {funnelQuery.isLoading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: 'Investimento',
                value: funnel?.spendAvailable ? brl(totals?.spend ?? 0) : '—',
                sub: funnel?.spendAvailable
                  ? null
                  : 'Conecte a conta de anúncios',
              },
              {
                label: 'Conversas de anúncio',
                value: String(totals?.ctwaConversations ?? 0),
                sub: `${totals?.organicConversations ?? 0} orgânicas · custo ${brl(totals?.costPerConversation)}`,
              },
              {
                label: 'Reuniões agendadas',
                value: String(totals?.meetings ?? 0),
                sub: `custo ${brl(totals?.costPerMeeting)}`,
              },
              {
                label: 'Vendas',
                value: String(totals?.purchases ?? 0),
                sub: `receita ${brl(totals?.revenue ?? 0)} · custo ${brl(totals?.costPerPurchase)}`,
              },
            ].map((card) => (
              <Card key={card.label}>
                <CardContent className="pt-4">
                  <p className="text-xs text-muted-foreground">{card.label}</p>
                  <p className="text-2xl font-bold">{card.value}</p>
                  {card.sub && (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {card.sub}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Por anúncio */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Por anúncio</CardTitle>
              <CardDescription>
                Gasto e resultados atribuídos a cada anúncio (ctwa_clid).
              </CardDescription>
            </CardHeader>
            <CardContent>
              {funnel && funnel.byAd.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Anúncio</TableHead>
                      <TableHead>Campanha</TableHead>
                      <TableHead className="text-right">Gasto</TableHead>
                      <TableHead className="text-right">Conversas</TableHead>
                      <TableHead className="text-right">Reuniões</TableHead>
                      <TableHead className="text-right">Vendas</TableHead>
                      <TableHead className="text-right">Receita</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {funnel.byAd.map((row) => (
                      <TableRow key={row.adId || 'sem-id'}>
                        <TableCell className="max-w-[220px] truncate">
                          {row.adName || row.adId || 'Anúncio não identificado'}
                        </TableCell>
                        <TableCell className="max-w-[180px] truncate">
                          {row.campaignName || '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.spend > 0 ? brl(row.spend) : '—'}
                        </TableCell>
                        <TableCell className="text-right">{row.conversations}</TableCell>
                        <TableCell className="text-right">{row.meetings}</TableCell>
                        <TableCell className="text-right">{row.purchases}</TableCell>
                        <TableCell className="text-right">
                          {row.revenue > 0 ? brl(row.revenue) : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground py-4">
                  Nenhuma conversa de anúncio no período. As conversas vindas
                  de anúncios Click-to-WhatsApp aparecem aqui automaticamente.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Últimos eventos enviados */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Últimos eventos enviados à Meta</CardTitle>
            </CardHeader>
            <CardContent>
              {eventsQuery.data && eventsQuery.data.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Evento</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead>Data</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {eventsQuery.data.map((ev) => (
                      <TableRow key={ev.id}>
                        <TableCell>{ev.eventName}</TableCell>
                        <TableCell>
                          <Badge
                            variant={ev.status === 'sent' ? 'default' : 'outline'}
                            className={
                              ev.status === 'sent'
                                ? 'bg-emerald-600 text-white'
                                : ev.status === 'failed'
                                  ? 'text-destructive border-destructive'
                                  : ''
                            }
                            title={ev.error ?? undefined}
                          >
                            {ev.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {ev.value != null ? brl(Number(ev.value)) : '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(ev.createdAt).toLocaleString('pt-BR')}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground py-4">
                  Nenhum evento enviado ainda.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
