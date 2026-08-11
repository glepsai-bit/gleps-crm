/**
 * TRACKING (Meta Ads / CTWA) — inteligência de rastreamento.
 *
 * Três blocos:
 *  1. Conexão Meta (por conta) + diagnóstico de cada ativo.
 *  2. Congruência CRM × Meta: o que aconteceu aqui vs. o que o gerenciador
 *     recebeu, com reconciliação do que ficou pra trás.
 *  3. Performance: KPIs, evolução diária e quebra por campanha/anúncio.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Radar } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  type TrackingReconcileReport,
  type TrackingVerifyResult,
} from '@/services/tracking.backend.service';
import { TrackingConnectionCard } from '@/components/tracking/TrackingConnectionCard';
import { TrackingValidationCard } from '@/components/tracking/TrackingValidationCard';
import { TrackingPerformanceChart } from '@/components/tracking/TrackingPerformanceChart';
import { brl, int, pct, ratio } from '@/components/tracking/format';

export default function AdminTrackingPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [days, setDays] = useState(30);
  const [verifyResult, setVerifyResult] = useState<TrackingVerifyResult | null>(null);
  const [lastRun, setLastRun] = useState<TrackingReconcileReport | null>(null);

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
    queryFn: () => trackingBackendService.listEvents(50),
  });

  const saveMutation = useMutation({
    mutationFn: (input: TrackingConfigInput) => trackingBackendService.saveConfig(input),
    onSuccess: () => {
      toast({ title: 'Configuração salva' });
      queryClient.invalidateQueries({ queryKey: ['tracking-config'] });
      queryClient.invalidateQueries({ queryKey: ['tracking-funnel'] });
    },
    onError: (err: unknown) =>
      toast({
        title: 'Erro ao salvar',
        description: err instanceof Error ? err.message : 'Tente novamente',
        variant: 'destructive',
      }),
  });

  const verifyMutation = useMutation({
    mutationFn: () => trackingBackendService.verify(days),
    onSuccess: (data) => {
      setVerifyResult(data);
      const problems = data.checks.filter((c) => !c.ok).length;
      const gaps = data.report?.recoverable ?? 0;
      toast({
        title: problems === 0 && gaps === 0 ? 'Tudo certo' : 'Validação concluída',
        description:
          problems > 0
            ? `${problems} problema(s) de conexão encontrados.`
            : gaps > 0
              ? `${gaps} evento(s) do CRM ainda não chegaram à Meta.`
              : 'Conexão e dados estão congruentes.',
      });
    },
    onError: (err: unknown) =>
      toast({
        title: 'Erro na validação',
        description: err instanceof Error ? err.message : 'Tente novamente',
        variant: 'destructive',
      }),
  });

  const reconcileMutation = useMutation({
    mutationFn: () => trackingBackendService.reconcile(days, true),
    onSuccess: (report) => {
      setLastRun(report);
      toast({
        title: 'Reconciliação concluída',
        description: `${report.sent} evento(s) enviados à Meta${
          report.failed > 0 ? ` · ${report.failed} falha(s)` : ''
        }.`,
      });
      verifyMutation.mutate();
    },
    onError: (err: unknown) =>
      toast({
        title: 'Erro ao reconciliar',
        description: err instanceof Error ? err.message : 'Tente novamente',
        variant: 'destructive',
      }),
    // onSettled, não onSuccess: se o client cortar por timeout, o servidor
    // pode ter enviado tudo mesmo assim. Recarregar sempre evita a tela
    // mostrar um estado antigo depois de um erro que não era erro.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tracking-funnel'] });
      queryClient.invalidateQueries({ queryKey: ['tracking-events'] });
    },
  });

  const config = configQuery.data;
  const funnel = funnelQuery.data;
  const t = funnel?.totals;

  const kpis = [
    {
      label: 'Investimento',
      value: funnel?.spendAvailable ? brl(t?.spend ?? 0) : '—',
      sub: funnel?.spendAvailable
        ? `${int(t?.impressions)} impressões · ${int(t?.linkClicks)} cliques`
        : 'Sem leitura de gasto',
    },
    {
      label: 'Conversas de anúncio',
      value: int(t?.ctwaConversations ?? 0),
      sub: `${int(t?.organicConversations ?? 0)} orgânicas · custo ${brl(t?.costPerConversation)}`,
    },
    {
      label: 'Reuniões agendadas',
      value: int(t?.meetings ?? 0),
      sub: `${pct(t?.convRate)} das conversas · custo ${brl(t?.costPerMeeting)}`,
    },
    {
      label: 'Vendas',
      value: int(t?.purchases ?? 0),
      sub: `${pct(t?.closeRate)} das reuniões · custo ${brl(t?.costPerPurchase)}`,
    },
    { label: 'Receita', value: brl(t?.revenue ?? 0), sub: 'Vendas pagas atribuídas a anúncio' },
    {
      label: 'ROAS',
      value: ratio(t?.roas),
      sub: t?.roas != null ? 'Receita ÷ investimento' : 'Depende do investimento',
    },
  ];

  return (
    <div className="p-4 lg:p-6 space-y-5 max-w-7xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Radar className="w-6 h-6 text-primary shrink-0" />
          <div>
            <h1 className="text-xl font-bold">Tracking de Anúncios</h1>
            <p className="text-sm text-muted-foreground">
              Meta Ads (Click-to-WhatsApp): origem das conversas, funil e envio de
              conversões reais pra Meta.
            </p>
          </div>
        </div>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Últimos 7 dias</SelectItem>
            <SelectItem value="14">Últimos 14 dias</SelectItem>
            <SelectItem value="30">Últimos 30 dias</SelectItem>
            <SelectItem value="90">Últimos 90 dias</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <TrackingConnectionCard
        config={config}
        checks={verifyResult?.checks ?? null}
        saving={saveMutation.isPending}
        verifying={verifyMutation.isPending}
        onSave={(input) => saveMutation.mutate(input)}
        onVerify={() => verifyMutation.mutate()}
      />

      {/* Motivo real da ausência de investimento — antes isso era um "—" mudo */}
      {funnel?.spendError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Não foi possível ler o investimento na Meta</AlertTitle>
          <AlertDescription className="space-y-1">
            <p className="font-mono text-xs break-words">{funnel.spendError}</p>
            <p>
              Normalmente é o usuário do sistema sem a conta de anúncios atribuída na
              Business Manager, ou token gerado sem a permissão <code>ads_read</code>.
            </p>
          </AlertDescription>
        </Alert>
      )}
      {funnel && !funnel.hasAdAccount && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Conta de anúncios não informada</AlertTitle>
          <AlertDescription>
            Sem ela não há investimento, custo por etapa, ROAS nem nome de campanha.
          </AlertDescription>
        </Alert>
      )}

      <TrackingValidationCard
        funnel={funnel}
        report={verifyResult?.report ?? null}
        verified={Boolean(verifyResult)}
        verifying={verifyMutation.isPending}
        reconciling={reconcileMutation.isPending}
        lastRun={lastRun}
        onVerify={() => verifyMutation.mutate()}
        onReconcile={() => reconcileMutation.mutate()}
      />

      {funnelQuery.isLoading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {kpis.map((card) => (
              <Card key={card.label}>
                <CardContent className="pt-4">
                  <p className="text-xs text-muted-foreground">{card.label}</p>
                  <p className="text-2xl font-bold tabular-nums">{card.value}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">{card.sub}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <TrackingPerformanceChart daily={funnel?.daily ?? []} />

          <Tabs defaultValue="campanha">
            <TabsList>
              <TabsTrigger value="campanha">Por campanha</TabsTrigger>
              <TabsTrigger value="anuncio">Por anúncio</TabsTrigger>
              <TabsTrigger value="eventos">Eventos enviados</TabsTrigger>
            </TabsList>

            {/* ---------- Campanha ---------- */}
            <TabsContent value="campanha">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Resultado por campanha</CardTitle>
                  <CardDescription>
                    Agrupado a partir do anúncio de origem de cada conversa.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {funnel && funnel.byCampaign.length > 0 ? (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Campanha</TableHead>
                            <TableHead className="text-right">Anúncios</TableHead>
                            <TableHead className="text-right">Gasto</TableHead>
                            <TableHead className="text-right">Conversas</TableHead>
                            <TableHead className="text-right">Custo/conversa</TableHead>
                            <TableHead className="text-right">Reuniões</TableHead>
                            <TableHead className="text-right">Vendas</TableHead>
                            <TableHead className="text-right">Receita</TableHead>
                            <TableHead className="text-right">ROAS</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {funnel.byCampaign.map((row) => (
                            <TableRow key={row.campaignId || row.campaignName}>
                              <TableCell className="max-w-[240px] truncate font-medium">
                                {row.campaignName}
                              </TableCell>
                              <TableCell className="text-right">{row.ads}</TableCell>
                              <TableCell className="text-right">
                                {row.spend > 0 ? brl(row.spend) : '—'}
                              </TableCell>
                              <TableCell className="text-right">{row.conversations}</TableCell>
                              <TableCell className="text-right">
                                {brl(row.costPerConversation)}
                              </TableCell>
                              <TableCell className="text-right">{row.meetings}</TableCell>
                              <TableCell className="text-right">{row.purchases}</TableCell>
                              <TableCell className="text-right">
                                {row.revenue > 0 ? brl(row.revenue) : '—'}
                              </TableCell>
                              <TableCell className="text-right">{ratio(row.roas)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground py-4">
                      Nenhuma campanha com dados no período.
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ---------- Anúncio ---------- */}
            <TabsContent value="anuncio">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Resultado por anúncio</CardTitle>
                  <CardDescription>
                    Gasto e resultados atribuídos a cada anúncio (ctwa_clid).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {funnel && funnel.byAd.length > 0 ? (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Anúncio</TableHead>
                            <TableHead>Campanha</TableHead>
                            <TableHead className="text-right">Gasto</TableHead>
                            <TableHead className="text-right">Impressões</TableHead>
                            <TableHead className="text-right">Conversas</TableHead>
                            <TableHead className="text-right">Custo/conversa</TableHead>
                            <TableHead className="text-right">Reuniões</TableHead>
                            <TableHead className="text-right">Vendas</TableHead>
                            <TableHead className="text-right">Receita</TableHead>
                            <TableHead className="text-right">ROAS</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {funnel.byAd.map((row) => (
                            <TableRow key={row.adId || 'sem-id'}>
                              <TableCell className="max-w-[220px] truncate">
                                {row.adName || row.adId || 'Anúncio não identificado'}
                              </TableCell>
                              <TableCell className="max-w-[180px] truncate text-muted-foreground">
                                {row.campaignName || '—'}
                              </TableCell>
                              <TableCell className="text-right">
                                {row.spend > 0 ? brl(row.spend) : '—'}
                              </TableCell>
                              <TableCell className="text-right">
                                {row.impressions > 0 ? int(row.impressions) : '—'}
                              </TableCell>
                              <TableCell className="text-right">{row.conversations}</TableCell>
                              <TableCell className="text-right">
                                {brl(row.costPerConversation)}
                              </TableCell>
                              <TableCell className="text-right">{row.meetings}</TableCell>
                              <TableCell className="text-right">{row.purchases}</TableCell>
                              <TableCell className="text-right">
                                {row.revenue > 0 ? brl(row.revenue) : '—'}
                              </TableCell>
                              <TableCell className="text-right">{ratio(row.roas)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground py-4">
                      Nenhuma conversa de anúncio no período. As conversas vindas de
                      anúncios Click-to-WhatsApp aparecem aqui automaticamente.
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ---------- Eventos ---------- */}
            <TabsContent value="eventos">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Últimos eventos enviados à Meta</CardTitle>
                  <CardDescription>
                    Auditoria linha a linha. <code>sent</code> = a Meta confirmou o
                    recebimento.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {eventsQuery.data && eventsQuery.data.length > 0 ? (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Evento</TableHead>
                            <TableHead>Origem</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Valor</TableHead>
                            <TableHead>Data</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {eventsQuery.data.map((ev) => (
                            <TableRow key={ev.id}>
                              <TableCell>{ev.eventName}</TableCell>
                              <TableCell className="text-muted-foreground text-xs">
                                {ev.sourceType === 'conversation'
                                  ? 'Conversa'
                                  : ev.sourceType === 'calendar_event'
                                    ? 'Agenda'
                                    : ev.sourceType === 'sale'
                                      ? 'Venda'
                                      : '—'}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant={ev.status === 'sent' ? 'default' : 'outline'}
                                  className={
                                    ev.status === 'sent'
                                      ? 'bg-emerald-600 text-white hover:bg-emerald-600'
                                      : ev.status === 'failed'
                                        ? 'text-destructive border-destructive'
                                        : ''
                                  }
                                  title={ev.error ?? undefined}
                                >
                                  {ev.status === 'skipped' ? 'fora do prazo' : ev.status}
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
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground py-4">
                      Nenhum evento enviado ainda.
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
