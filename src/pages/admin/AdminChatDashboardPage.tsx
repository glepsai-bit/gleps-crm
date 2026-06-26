/**
 * AdminChatDashboardPage — T-022 (Fase Frontend)
 *
 * Dashboard de métricas do chat interno (Conversation / Message / SLABreach).
 * Fonte: chatMetricsBackendService.getChatMetrics — backend agrega tudo numa
 * única chamada. Filtros (período + inbox + team + agent) reenviam a query via
 * TanStack Query.
 *
 * Conteúdo:
 *  - Filtros: período (7d / 30d / custom), inbox, team, agent
 *  - KPIs: total / open / resolved / avg first response / avg resolution /
 *          SLA breaches / resolved by AI vs Human (%)
 *  - Charts (recharts): volume por dia (composed), top agentes (bar),
 *          distribuição por time (pie), distribuição por inbox (pie)
 *
 * Volume por dia (FIX BUG-3): o endpoint /api/chat/metrics agora devolve
 * `dailyVolume[]` (bucket por dia em UTC). Consumimos direto. Mantemos um
 * fallback (pagina listConversations e agrupa client-side) só pra cobrir
 * deploys antigos do backend que ainda não tenham o campo — assim a UI nunca
 * mostra a antiga linha "flat 0.45" fake.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { chatSocket } from '@/services/socket.client';
import {
  chatMetricsBackendService,
  type ChatMetricsFilters,
  type ChatMetricsResult,
  type LiveAttendanceResult,
  type ReturningLeadsCountResult,
  type ReturningLeadsListResult,
} from '@/services/chat-metrics.backend.service';
import {
  conversationsBackendService,
  type Conversation,
  type ListConversationsFilters,
} from '@/services/conversations.backend.service';
import { inboxesBackendService } from '@/services/inboxes.backend.service';
import { teamsBackendService } from '@/services/teams.backend.service';
import { usersBackendService } from '@/services/users.backend.service';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
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
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
  AreaChart,
  Area,
  ComposedChart,
  Line,
} from 'recharts';
import {
  MessageSquare,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Bot,
  User as UserIcon,
  Calendar as CalendarIcon,
  Filter,
  TrendingUp,
  Repeat,
  Activity,
  Loader2,
  X,
} from 'lucide-react';
import {
  startOfDay,
  endOfDay,
  subDays,
  format,
  eachDayOfInterval,
  differenceInDays,
} from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { DateRange } from 'react-day-picker';
import { cn } from '@/lib/utils';

// ============================================
// Utils
// ============================================

const PIE_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--success))',
  'hsl(var(--warning))',
  'hsl(var(--destructive))',
  'hsl(220 70% 60%)',
  'hsl(280 70% 60%)',
  'hsl(160 70% 45%)',
  'hsl(35 90% 55%)',
];

function formatMin(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value < 1) return '<1 min';
  if (value < 60) return `${Math.round(value)} min`;
  const hours = Math.floor(value / 60);
  const mins = Math.round(value % 60);
  return mins > 0 ? `${hours}h ${mins}min` : `${hours}h`;
}

function pct(part: number, total: number): number {
  if (!total) return 0;
  return (part / total) * 100;
}

type PeriodOption = '7d' | '30d' | 'custom';

// ============================================
// Componente
// ============================================

export default function AdminChatDashboardPage() {
  const { account } = useAuth();
  const queryClient = useQueryClient();

  const [period, setPeriod] = useState<PeriodOption>('30d');
  const [dateRange, setDateRange] = useState<DateRange>({
    from: subDays(new Date(), 30),
    to: new Date(),
  });
  const [inboxId, setInboxId] = useState<string>('all');
  const [teamId, setTeamId] = useState<string>('all');
  const [agentId, setAgentId] = useState<string>('all');

  // T-022 — drill-down "Retornos no período"
  const [returningModalOpen, setReturningModalOpen] = useState(false);

  // T-022 — filtro especial "somente humanos atendendo" (vem do card Atendimento
  // ao Vivo). Aplica `assigneeId IS NOT NULL` no breakdown — distinto do filtro
  // por agente específico (`agentId`).
  const [humanOnlyFilter, setHumanOnlyFilter] = useState(false);

  // ---- Filtros derivados ----
  const effectiveRange = useMemo(() => {
    const today = new Date();
    if (period === '7d') {
      return { from: subDays(today, 7), to: today };
    }
    if (period === '30d') {
      return { from: subDays(today, 30), to: today };
    }
    return {
      from: dateRange.from ?? subDays(today, 30),
      to: dateRange.to ?? today,
    };
  }, [period, dateRange]);

  const filters: ChatMetricsFilters = useMemo(
    () => ({
      fromDate: startOfDay(effectiveRange.from).toISOString(),
      toDate: endOfDay(effectiveRange.to).toISOString(),
      inboxId: inboxId !== 'all' ? inboxId : undefined,
      teamId: teamId !== 'all' ? teamId : undefined,
      agentId: agentId !== 'all' ? agentId : undefined,
    }),
    [effectiveRange, inboxId, teamId, agentId]
  );

  // ---- Queries auxiliares para popular filtros ----
  const inboxesQuery = useQuery({
    queryKey: ['inboxes', account?.id],
    queryFn: () => inboxesBackendService.listInboxes(),
    enabled: Boolean(account?.id),
    staleTime: 1000 * 60 * 5,
  });

  const teamsQuery = useQuery({
    queryKey: ['teams', account?.id],
    queryFn: () => teamsBackendService.listTeams(),
    enabled: Boolean(account?.id),
    staleTime: 1000 * 60 * 5,
  });

  const usersQuery = useQuery({
    queryKey: ['users', account?.id],
    queryFn: () => usersBackendService.list(account?.id),
    enabled: Boolean(account?.id),
    staleTime: 1000 * 60 * 5,
  });

  // ---- Query principal de métricas ----
  // refetchInterval: 60s para manter o dashboard atualizado sem depender de
  // socket events (review low-finding). staleTime menor que o intervalo pra
  // garantir refetch real.
  const metricsQuery = useQuery<ChatMetricsResult>({
    queryKey: ['chat-metrics', filters],
    queryFn: () => chatMetricsBackendService.getChatMetrics(filters),
    enabled: Boolean(account?.id),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
    refetchOnWindowFocus: true,
  });

  const metrics = metricsQuery.data;
  const isLoading = metricsQuery.isLoading;

  // ---- T-022 — Retornos no período ----
  const returningLeadsQuery = useQuery<ReturningLeadsCountResult>({
    queryKey: ['chat-metrics', 'returning-leads', filters],
    queryFn: () => chatMetricsBackendService.getReturningLeadsCount(filters),
    enabled: Boolean(account?.id),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });

  // ---- T-022 — Atendimento ao vivo (IA / Humano / Em aberto) ----
  // refetchInterval 15s + invalidate em conversation:updated (real-time).
  const liveAttendanceQuery = useQuery<LiveAttendanceResult>({
    queryKey: ['chat-metrics', 'live-attendance'],
    queryFn: () => chatMetricsBackendService.getLiveAttendance(),
    enabled: Boolean(account?.id),
    staleTime: 1000 * 5,
    refetchInterval: 1000 * 15,
    refetchOnWindowFocus: true,
  });

  // Subscrever socket conversation:updated para invalidate live attendance.
  useEffect(() => {
    if (!account?.id) return;
    const unsub = chatSocket.onConversationUpdated(() => {
      queryClient.invalidateQueries({
        queryKey: ['chat-metrics', 'live-attendance'],
      });
    });
    return () => {
      unsub();
    };
  }, [account?.id, queryClient]);

  // ---- T-022 — Lista paginada de leads retornados (modal) ----
  const returningListQuery = useQuery<ReturningLeadsListResult>({
    queryKey: ['chat-metrics', 'returning-leads', 'list', filters],
    queryFn: () =>
      chatMetricsBackendService.getReturningLeadsList(filters, 1, 50),
    enabled: Boolean(account?.id) && returningModalOpen,
    staleTime: 1000 * 30,
  });

  // ---- Dados derivados para gráficos ----
  const periodDays = useMemo(() => {
    const diff = differenceInDays(effectiveRange.to, effectiveRange.from) + 1;
    return Math.max(diff, 1);
  }, [effectiveRange]);

  // FIX BUG-3: priorizar `dailyVolume` retornado pelo backend (agregado em SQL
  // — barato, não pagina conversations). Mantemos a query secundária só como
  // fallback caso o backend ainda não tenha a versão nova deployada — assim a
  // UI nunca regressa pra linha fake. A fallback query só dispara quando
  // metrics chegou SEM dailyVolume.
  const hasBackendDaily = Boolean(
    metrics?.dailyVolume && metrics.dailyVolume.length > 0
  );

  const dailyConversationsQuery = useQuery<Conversation[]>({
    queryKey: [
      'chat-metrics',
      'daily-conversations',
      filters.inboxId ?? null,
      filters.teamId ?? null,
      filters.agentId ?? null,
      filters.fromDate ?? null,
      filters.toDate ?? null,
    ],
    queryFn: async () => {
      const baseFilters: ListConversationsFilters = {
        inboxId: filters.inboxId,
        teamId: filters.teamId,
        assigneeId: filters.agentId,
      };
      const PAGE = 200;
      const MAX_PAGES = 5;
      const collected: Conversation[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data, total } = await conversationsBackendService.listConversations({
          ...baseFilters,
          limit: PAGE,
          offset: page * PAGE,
        });
        collected.push(...data);
        if (collected.length >= total || data.length < PAGE) break;
      }
      return collected;
    },
    // Só roda se o backend antigo não trouxe a série
    enabled: Boolean(account?.id) && metricsQuery.isFetched && !hasBackendDaily,
    staleTime: 1000 * 30,
  });

  const dailyVolumeData = useMemo(() => {
    const days = eachDayOfInterval({
      start: effectiveRange.from,
      end: effectiveRange.to,
    });

    // Caminho preferido: backend já agregou.
    if (hasBackendDaily && metrics?.dailyVolume) {
      // Mapa por chave yyyy-mm-dd UTC pra alinhar com o que o BE devolve.
      const byKey = new Map(metrics.dailyVolume.map((b) => [b.date, b]));
      return days.map((d) => {
        const key = format(d, 'yyyy-MM-dd');
        const bucket = byKey.get(key);
        return {
          date: format(d, 'dd/MM'),
          total: bucket?.total ?? 0,
          resolvidas: bucket?.resolved ?? 0,
          abertas: bucket?.open ?? 0,
        };
      });
    }

    // Fallback: agrupar conversations cliente-side (deploy antigo do BE).
    const fromMs = startOfDay(effectiveRange.from).getTime();
    const toMs = endOfDay(effectiveRange.to).getTime();
    const buckets = new Map<
      string,
      { total: number; resolvidas: number; abertas: number }
    >();
    for (const d of days) {
      buckets.set(format(d, 'yyyy-MM-dd'), {
        total: 0,
        resolvidas: 0,
        abertas: 0,
      });
    }

    const conversations = dailyConversationsQuery.data ?? [];
    for (const c of conversations) {
      const createdMs = new Date(c.createdAt).getTime();
      if (createdMs < fromMs || createdMs > toMs) continue;
      const key = format(new Date(c.createdAt), 'yyyy-MM-dd');
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.total += 1;
      if (c.status === 'resolved') {
        bucket.resolvidas += 1;
      } else if (['open', 'pending', 'snoozed'].includes(c.status)) {
        bucket.abertas += 1;
      }
    }

    return days.map((d) => {
      const key = format(d, 'yyyy-MM-dd');
      const bucket = buckets.get(key)!;
      return {
        date: format(d, 'dd/MM'),
        total: bucket.total,
        resolvidas: bucket.resolvidas,
        abertas: bucket.abertas,
      };
    });
  }, [
    hasBackendDaily,
    metrics?.dailyVolume,
    dailyConversationsQuery.data,
    effectiveRange,
  ]);

  const isDailyLoading =
    metricsQuery.isLoading ||
    (!hasBackendDaily && dailyConversationsQuery.isLoading);

  const topAgents = useMemo(() => {
    if (!metrics?.byAgent) return [];
    return [...metrics.byAgent]
      .sort((a, b) => b.resolved - a.resolved)
      .slice(0, 10);
  }, [metrics]);

  const byTeamPie = useMemo(() => {
    if (!metrics?.byTeam) return [];
    return metrics.byTeam
      .filter((t) => t.total > 0)
      .map((t) => ({
        name: t.teamName,
        value: t.total,
      }));
  }, [metrics]);

  const byInboxPie = useMemo(() => {
    if (!metrics?.byInbox) return [];
    return metrics.byInbox
      .filter((i) => i.total > 0)
      .map((i) => ({
        name: i.inboxName,
        value: i.total,
      }));
  }, [metrics]);

  // KPIs derivados
  //
  // H-DASH-1 FIX: numerador (resolvedByAi/Human) vem de ConversationCycle e
  // denominador era resolvedConversations (count em Conversation). Quando uma
  // conversa é reaberta e reconcluída, ela gera múltiplos ciclos resolvidos
  // mas continua contando como 1 só no count de Conversation — o que produzia
  // valores absurdos como 800%. Alinhamos numerador e denominador no mesmo
  // domínio (total de ciclos resolvidos = IA + Humano).
  const totalResolvedCycles = metrics
    ? metrics.resolvedByAi + metrics.resolvedByHuman
    : 0;
  const aiResolvedPct = totalResolvedCycles > 0 && metrics
    ? pct(metrics.resolvedByAi, totalResolvedCycles)
    : 0;
  const humanResolvedPct = totalResolvedCycles > 0 && metrics
    ? pct(metrics.resolvedByHuman, totalResolvedCycles)
    : 0;
  const resolutionRate = metrics
    ? pct(metrics.resolvedConversations, metrics.totalConversations)
    : 0;

  // ---- Handlers ----
  function handlePeriodChange(value: string) {
    const p = value as PeriodOption;
    setPeriod(p);
    const today = new Date();
    if (p === '7d') {
      setDateRange({ from: subDays(today, 7), to: today });
    } else if (p === '30d') {
      setDateRange({ from: subDays(today, 30), to: today });
    }
  }

  // ============================================
  // Render
  // ============================================

  if (!account?.id) {
    return (
      <div className="flex items-center justify-center h-[50vh] text-muted-foreground">
        Carregando conta...
      </div>
    );
  }

  return (
    <div className="page-container space-y-6">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground">
            Dashboard de Chat
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Métricas de conversas, SLA e performance dos agentes
          </p>
        </div>
      </div>

      {/* Filtros */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Filter className="w-4 h-4" />
              <span className="text-sm font-medium">Filtros</span>
            </div>

            {/* Período */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground uppercase">
                Período
              </label>
              <Select value={period} onValueChange={handlePeriodChange}>
                <SelectTrigger className="w-[150px] h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7d">Últimos 7 dias</SelectItem>
                  <SelectItem value="30d">Últimos 30 dias</SelectItem>
                  <SelectItem value="custom">Personalizado</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Date range (somente em custom) */}
            {period === 'custom' && (
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-muted-foreground uppercase">
                  Datas
                </label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        'h-9 justify-start text-left font-normal w-[260px]',
                        !dateRange?.from && 'text-muted-foreground'
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {dateRange?.from ? (
                        dateRange.to ? (
                          <>
                            {format(dateRange.from, 'dd/MM/yy', { locale: ptBR })}{' '}
                            -{' '}
                            {format(dateRange.to, 'dd/MM/yy', { locale: ptBR })}
                          </>
                        ) : (
                          format(dateRange.from, 'dd/MM/yy', { locale: ptBR })
                        )
                      ) : (
                        <span>Selecione um período</span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <CalendarComponent
                      initialFocus
                      mode="range"
                      defaultMonth={dateRange?.from}
                      selected={dateRange}
                      onSelect={(range) => {
                        if (range) setDateRange(range);
                      }}
                      numberOfMonths={2}
                      locale={ptBR}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            )}

            {/* Inbox */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground uppercase">
                Inbox
              </label>
              <Select value={inboxId} onValueChange={setInboxId}>
                <SelectTrigger className="w-[180px] h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os inboxes</SelectItem>
                  {inboxesQuery.data?.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Team */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground uppercase">
                Time
              </label>
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger className="w-[180px] h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os times</SelectItem>
                  {teamsQuery.data?.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Agente */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground uppercase">
                Agente
              </label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger className="w-[200px] h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os agentes</SelectItem>
                  {usersQuery.data?.map((u) => (
                    <SelectItem key={u.user_id} value={u.user_id}>
                      {u.nome || u.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        <KpiCard
          icon={<MessageSquare className="w-4 h-4" />}
          label="Total de conversas"
          value={isLoading ? null : metrics?.totalConversations ?? 0}
          tone="primary"
        />
        <KpiCard
          icon={<TrendingUp className="w-4 h-4" />}
          label="Abertas"
          value={isLoading ? null : metrics?.openConversations ?? 0}
          tone="warning"
          subtitle={
            metrics
              ? `${pct(
                  metrics.openConversations,
                  metrics.totalConversations
                ).toFixed(0)}% do total`
              : undefined
          }
        />
        <KpiCard
          icon={<CheckCircle2 className="w-4 h-4" />}
          label="Resolvidas"
          value={isLoading ? null : metrics?.resolvedConversations ?? 0}
          tone="success"
          subtitle={
            metrics
              ? `${resolutionRate.toFixed(0)}% taxa de resolução`
              : undefined
          }
        />
        {/* T-022 — Retornos no período (clicável: abre modal). */}
        <KpiCard
          icon={<Repeat className="w-4 h-4" />}
          label="Leads que retornaram (>=1 reopen no período)"
          value={
            returningLeadsQuery.isLoading
              ? null
              : returningLeadsQuery.data?.count ?? 0
          }
          tone="warning"
          onClick={() => setReturningModalOpen(true)}
          subtitle={
            returningLeadsQuery.data?.count === 0
              ? 'Nenhum retorno no período'
              : 'Clique para ver detalhes'
          }
        />
        <KpiCard
          icon={<Clock className="w-4 h-4" />}
          label="1ª resposta (média)"
          value={isLoading ? null : metrics?.avgFirstResponseMin ?? null}
          formatter={(v) => formatMin(v as number | null)}
          tone="primary"
        />
        <KpiCard
          icon={<Clock className="w-4 h-4" />}
          label="Resolução (média)"
          value={isLoading ? null : metrics?.avgResolutionMin ?? null}
          formatter={(v) => formatMin(v as number | null)}
          tone="primary"
        />
        <KpiCard
          icon={<AlertTriangle className="w-4 h-4" />}
          label="SLA estourados"
          value={isLoading ? null : metrics?.slaBreaches ?? 0}
          tone="destructive"
        />
      </div>

      {/* T-022 — Atendimento ao vivo (IA vs Humano vs Em Aberto) */}
      <LiveAttendanceCard
        data={liveAttendanceQuery.data}
        isLoading={liveAttendanceQuery.isLoading}
        humanOnlyActive={humanOnlyFilter}
        onFilterHumans={() => setHumanOnlyFilter((v) => !v)}
      />

      {/* IA vs Humano */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Bot className="w-4 h-4 text-primary" />
            Resolução: IA vs Humano
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Distribuição percentual de conversas resolvidas no período
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : metrics && totalResolvedCycles > 0 ? (
            <div className="space-y-4">
              <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="bg-primary transition-all"
                  style={{ width: `${aiResolvedPct}%` }}
                  title={`IA: ${aiResolvedPct.toFixed(1)}%`}
                />
                <div
                  className="bg-success transition-all"
                  style={{ width: `${humanResolvedPct}%` }}
                  title={`Humano: ${humanResolvedPct.toFixed(1)}%`}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/5 border border-primary/20">
                  <div className="p-2 rounded-md bg-primary/10">
                    <Bot className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1">
                    <p className="text-xs text-muted-foreground">IA</p>
                    <p className="text-lg font-bold">
                      {metrics.resolvedByAi}{' '}
                      <span className="text-sm font-normal text-muted-foreground">
                        ({aiResolvedPct.toFixed(1)}%)
                      </span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-3 rounded-lg bg-success/5 border border-success/20">
                  <div className="p-2 rounded-md bg-success/10">
                    <UserIcon className="w-4 h-4 text-success" />
                  </div>
                  <div className="flex-1">
                    <p className="text-xs text-muted-foreground">Humano</p>
                    <p className="text-lg font-bold">
                      {metrics.resolvedByHuman}{' '}
                      <span className="text-sm font-normal text-muted-foreground">
                        ({humanResolvedPct.toFixed(1)}%)
                      </span>
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-6">
              Sem conversas resolvidas no período selecionado.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Charts row 1 — Volume por dia */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <CalendarIcon className="w-4 h-4 text-primary" />
            Volume de conversas por dia
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Distribuição diária de conversas no período ({periodDays} dia
            {periodDays !== 1 ? 's' : ''})
          </p>
        </CardHeader>
        <CardContent>
          {isDailyLoading ? (
            <Skeleton className="h-[280px] w-full" />
          ) : dailyVolumeData.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">
              Sem dados no período.
            </p>
          ) : (
            <ChartContainer
              config={{
                total: { label: 'Total', color: 'hsl(var(--primary))' },
                resolvidas: {
                  label: 'Resolvidas',
                  color: 'hsl(var(--success))',
                },
                abertas: { label: 'Abertas', color: 'hsl(var(--warning))' },
              }}
              className="h-[280px] w-full"
            >
              <ComposedChart
                data={dailyVolumeData}
                margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="5%"
                      stopColor="hsl(var(--primary))"
                      stopOpacity={0.3}
                    />
                    <stop
                      offset="95%"
                      stopColor="hsl(var(--primary))"
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  vertical={false}
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  width={40}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  iconType="circle"
                  iconSize={8}
                />
                <Area
                  type="monotone"
                  dataKey="total"
                  name="Total"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fill="url(#colorTotal)"
                />
                <Line
                  type="monotone"
                  dataKey="resolvidas"
                  name="Resolvidas"
                  stroke="hsl(var(--success))"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="abertas"
                  name="Abertas"
                  stroke="hsl(var(--warning))"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      {/* Charts row 2 — Distribuição por team + inbox (pies) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Por team */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold">
              Distribuição por time
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Conversas atribuídas por time no período
            </p>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-[280px] w-full" />
            ) : byTeamPie.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-12">
                Nenhuma conversa atribuída a times.
              </p>
            ) : (
              <ChartContainer
                config={{}}
                className="h-[280px] w-full [&_.recharts-pie-label-text]:fill-foreground"
              >
                <PieChart>
                  <Pie
                    data={byTeamPie}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    innerRadius={45}
                    paddingAngle={2}
                    label={({ name, percent }) =>
                      `${name} ${(percent * 100).toFixed(0)}%`
                    }
                    labelLine={false}
                  >
                    {byTeamPie.map((_, idx) => (
                      <Cell
                        key={idx}
                        fill={PIE_COLORS[idx % PIE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                </PieChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        {/* Por inbox */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold">
              Distribuição por inbox
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Conversas recebidas por canal no período
            </p>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-[280px] w-full" />
            ) : byInboxPie.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-12">
                Nenhuma conversa por inbox no período.
              </p>
            ) : (
              <ChartContainer
                config={{}}
                className="h-[280px] w-full [&_.recharts-pie-label-text]:fill-foreground"
              >
                <PieChart>
                  <Pie
                    data={byInboxPie}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    innerRadius={45}
                    paddingAngle={2}
                    label={({ name, percent }) =>
                      `${name} ${(percent * 100).toFixed(0)}%`
                    }
                    labelLine={false}
                  >
                    {byInboxPie.map((_, idx) => (
                      <Cell
                        key={idx}
                        fill={PIE_COLORS[idx % PIE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                </PieChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top agentes (bar + table) */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base font-semibold">
                Top agentes
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Ranking por conversas resolvidas e tempo médio de resolução. Clique em
                uma linha para filtrar o dashboard por aquele agente.
              </p>
            </div>
            {agentId !== 'all' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAgentId('all')}
                className="gap-1"
              >
                <X className="w-3.5 h-3.5" />
                Limpar filtro de agente
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {isLoading ? (
            <Skeleton className="h-[260px] w-full" />
          ) : topAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">
              Sem conversas atribuídas a agentes no período.
            </p>
          ) : (
            <>
              <ChartContainer
                config={{
                  resolved: {
                    label: 'Resolvidas',
                    color: 'hsl(var(--success))',
                  },
                  open: { label: 'Abertas', color: 'hsl(var(--warning))' },
                }}
                className="h-[260px] w-full"
              >
                <BarChart
                  data={topAgents.map((a) => ({
                    name: a.agentName,
                    resolved: a.resolved,
                    open: a.open,
                  }))}
                  margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                  layout="vertical"
                >
                  <CartesianGrid
                    horizontal={false}
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                  />
                  <XAxis
                    type="number"
                    axisLine={false}
                    tickLine={false}
                    tick={{
                      fill: 'hsl(var(--muted-foreground))',
                      fontSize: 10,
                    }}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    axisLine={false}
                    tickLine={false}
                    tick={{
                      fill: 'hsl(var(--muted-foreground))',
                      fontSize: 11,
                    }}
                    width={120}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Legend
                    wrapperStyle={{ fontSize: 12 }}
                    iconType="circle"
                    iconSize={8}
                  />
                  <Bar
                    dataKey="resolved"
                    name="Resolvidas"
                    stackId="a"
                    fill="hsl(var(--success))"
                    radius={[0, 0, 0, 0]}
                  />
                  <Bar
                    dataKey="open"
                    name="Abertas"
                    stackId="a"
                    fill="hsl(var(--warning))"
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ChartContainer>

              <ScrollArea className="max-h-[360px]">
                <div className="overflow-x-auto">
                  <Table className="min-w-[600px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[40px]">#</TableHead>
                        <TableHead>Agente</TableHead>
                        <TableHead className="text-center">Total</TableHead>
                        <TableHead className="text-center">Resolvidas</TableHead>
                        <TableHead className="text-center">Abertas</TableHead>
                        <TableHead className="text-right">
                          1ª resposta
                        </TableHead>
                        <TableHead className="text-right">
                          Resolução
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {topAgents.map((a, idx) => {
                        const isSelected = agentId === a.agentId;
                        return (
                          <TableRow
                            key={a.agentId}
                            onClick={() =>
                              setAgentId((cur) =>
                                cur === a.agentId ? 'all' : a.agentId
                              )
                            }
                            data-selected={isSelected || undefined}
                            className={cn(
                              'cursor-pointer transition-colors',
                              idx < 3 && !isSelected && 'bg-primary/5',
                              isSelected &&
                                'bg-primary/10 border-l-4 border-l-primary',
                              !isSelected && 'hover:bg-muted/50'
                            )}
                          >
                            <TableCell className="font-medium text-muted-foreground">
                              {idx + 1}º
                            </TableCell>
                            <TableCell className="font-medium">
                              {a.agentName}
                            </TableCell>
                            <TableCell className="text-center">
                              <Badge variant="secondary">{a.total}</Badge>
                            </TableCell>
                            <TableCell className="text-center text-success font-semibold">
                              {a.resolved}
                            </TableCell>
                            <TableCell className="text-center text-warning">
                              {a.open}
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {formatMin(a.avgFirstResponseMin)}
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {formatMin(a.avgResolutionMin)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </ScrollArea>
            </>
          )}
        </CardContent>
      </Card>

      {/* T-022 — Drill-down modal: leads que retornaram no período */}
      <Dialog open={returningModalOpen} onOpenChange={setReturningModalOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Repeat className="w-4 h-4 text-warning" />
              Leads que retornaram no período
            </DialogTitle>
            <DialogDescription>
              Contatos com ao menos 1 reabertura ({'>='} 2 ciclos) na janela
              selecionada.
            </DialogDescription>
          </DialogHeader>
          {returningListQuery.isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Carregando...
            </div>
          ) : !returningListQuery.data ||
            returningListQuery.data.data.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">
              Nenhum lead retornou no período selecionado.
            </p>
          ) : (
            <ScrollArea className="max-h-[60vh]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contato</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead className="text-center">Retornos</TableHead>
                    <TableHead>Último retorno</TableHead>
                    <TableHead>Inbox</TableHead>
                    <TableHead>Agente atual</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {returningListQuery.data.data.map((item) => (
                    <TableRow key={item.contactId}>
                      <TableCell className="font-medium">
                        {item.contactName ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.contactPhone ?? '—'}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="secondary">{item.cyclesCount}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.lastReopenAt
                          ? format(new Date(item.lastReopenAt), 'dd/MM/yy HH:mm', {
                              locale: ptBR,
                            })
                          : '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.inboxName ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.assigneeName ?? (
                          <span className="italic">Não atribuído</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================
// KPI Card subcomponent
// ============================================

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: number | null;
  subtitle?: string;
  tone?: 'primary' | 'success' | 'warning' | 'destructive';
  formatter?: (v: number | null) => string;
  /** Quando informado, renderiza o card clicável (hover/cursor). */
  onClick?: () => void;
}

function KpiCard({
  icon,
  label,
  value,
  subtitle,
  tone = 'primary',
  formatter,
  onClick,
}: KpiCardProps) {
  const toneClasses: Record<NonNullable<KpiCardProps['tone']>, string> = {
    primary: 'bg-primary/10 text-primary',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    destructive: 'bg-destructive/10 text-destructive',
  };

  const display =
    value === null
      ? '—'
      : formatter
      ? formatter(value)
      : new Intl.NumberFormat('pt-BR').format(value);

  const clickableProps = onClick
    ? {
        role: 'button' as const,
        tabIndex: 0,
        onClick,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        },
      }
    : {};

  return (
    <Card
      className={cn(
        onClick &&
          'cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/30'
      )}
      {...clickableProps}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className={cn('p-1.5 rounded-md', toneClasses[tone])}>
            {icon}
          </div>
          <span className="text-xs font-medium text-muted-foreground">
            {label}
          </span>
        </div>
        <p className="text-2xl font-bold">{display}</p>
        {subtitle && (
          <p className="text-[11px] text-muted-foreground mt-1">{subtitle}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================
// LiveAttendanceCard subcomponent (T-022)
// ============================================

interface LiveAttendanceCardProps {
  data: LiveAttendanceResult | undefined;
  isLoading: boolean;
  humanOnlyActive: boolean;
  onFilterHumans: () => void;
}

function LiveAttendanceCard({
  data,
  isLoading,
  humanOnlyActive,
  onFilterHumans,
}: LiveAttendanceCardProps) {
  const total = data?.total ?? 0;
  const ia = data?.ia.count ?? 0;
  const humano = data?.humano.count ?? 0;
  const emAberto = data?.emAberto.count ?? 0;

  const iaPct = total > 0 ? (ia / total) * 100 : 0;
  const humanPct = total > 0 ? (humano / total) * 100 : 0;
  const openPct = total > 0 ? (emAberto / total) * 100 : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary" />
          Atendimento ao Vivo (IA vs Humano)
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Snapshot das conversas em aberto agora — atualiza a cada 15s e em
          tempo real via socket.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading && !data ? (
          <Skeleton className="h-24 w-full" />
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            Nenhuma conversa em aberto no momento.
          </p>
        ) : (
          <div className="space-y-4">
            <div
              className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`Distribuição: IA ${iaPct.toFixed(0)}%, Humano ${humanPct.toFixed(0)}%, Em Aberto ${openPct.toFixed(0)}%`}
            >
              <div
                className="bg-primary transition-all"
                style={{ width: `${iaPct}%` }}
                title={`IA: ${ia}`}
              />
              <div
                className="bg-success transition-all"
                style={{ width: `${humanPct}%` }}
                title={`Humano: ${humano}`}
              />
              <div
                className="bg-muted-foreground/40 transition-all"
                style={{ width: `${openPct}%` }}
                title={`Em Aberto: ${emAberto}`}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/5 border border-primary/20">
                <div className="p-2 rounded-md bg-primary/10">
                  <Bot className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground">IA</p>
                  <p className="text-lg font-bold">{ia}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onFilterHumans}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg border text-left transition-colors',
                  'bg-success/5 border-success/20 hover:bg-success/10',
                  humanOnlyActive && 'ring-2 ring-success border-success'
                )}
                aria-pressed={humanOnlyActive}
                title="Clique para filtrar conversas atendidas por humanos"
              >
                <div className="p-2 rounded-md bg-success/10">
                  <UserIcon className="w-4 h-4 text-success" />
                </div>
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    Humano
                    {humanOnlyActive && (
                      <Badge variant="secondary" className="text-[10px] py-0">
                        filtrando
                      </Badge>
                    )}
                  </p>
                  <p className="text-lg font-bold">{humano}</p>
                </div>
              </button>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/40 border border-muted-foreground/20">
                <div className="p-2 rounded-md bg-muted-foreground/10">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground">Em Aberto</p>
                  <p className="text-lg font-bold">{emAberto}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
