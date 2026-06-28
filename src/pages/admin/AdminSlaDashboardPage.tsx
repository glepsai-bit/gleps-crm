/**
 * AdminSlaDashboardPage — SLA v2 (T-022)
 *
 * Dashboard agregado de SLA por periodo:
 *  - KPI grande: % de conversas resolvidas DENTRO do SLA
 *  - Cards de breaches (first_response / resolution) + tempo medio
 *  - Distribuicao de outcomes (resolved/transferred/spam/...)
 *  - CSAT medio + taxa de resposta + barra simples
 *  - Ranking de agentes (resolvidas, CSAT, breaches)
 *  - Card "IA vs Humano" com comparativo de resolucao, CSAT e breaches
 *
 * Fonte: slaPoliciesBackendService.getDashboard (GET /api/sla/dashboard).
 * Filtros: DateRange (7d / 30d / custom). Polling de 60s.
 *
 * Multi-tenant: admin -> propria conta automaticamente; super_admin
 * precisa estar impersonando (user.account_id), seguindo o mesmo padrao
 * de AdminSLAPoliciesPage.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  BarChart3,
  Bot,
  Calendar as CalendarIcon,
  CheckCircle2,
  Clock,
  Filter,
  ShieldCheck,
  Star,
  TrendingUp,
  User as UserIcon,
  Users,
} from 'lucide-react';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { DateRange } from 'react-day-picker';

import { useAuth } from '@/contexts/AuthContext';
import {
  slaPoliciesBackendService,
  type SLADashboardResult,
} from '@/services/sla-policies.backend.service';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

type PeriodOption = '7d' | '30d' | 'custom';

// Labels em PT para outcomes vindos do backend (SLA v2 enum). O conjunto
// e o mesmo do resolveSchema em conversation.controller.
const OUTCOME_LABEL: Record<string, string> = {
  resolved: 'Resolvido',
  transferred: 'Transferido',
  spam: 'Spam / Inválido',
  not_related: 'Não relacionado',
  abandoned: 'Abandonado',
  unable_to_resolve: 'Não resolvido',
};

function formatSec(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value < 60) return `${Math.round(value)}s`;
  const totalMin = value / 60;
  if (totalMin < 60) return `${Math.round(totalMin)} min`;
  const hours = Math.floor(totalMin / 60);
  const mins = Math.round(totalMin % 60);
  return mins > 0 ? `${hours}h ${mins}min` : `${hours}h`;
}

function pct(part: number, total: number): number {
  if (!total) return 0;
  return (part / total) * 100;
}

export default function AdminSlaDashboardPage() {
  const { user } = useAuth();

  // Mesmo padrao de AdminSLAPoliciesPage: super_admin precisa impersonar.
  const accountIdParam = useMemo<string | undefined>(() => {
    if (user?.role === 'super_admin') {
      return user.account_id || undefined;
    }
    return undefined;
  }, [user?.role, user?.account_id]);

  const isSuperAdminSemConta =
    user?.role === 'super_admin' && !accountIdParam;

  const [period, setPeriod] = useState<PeriodOption>('30d');
  const [dateRange, setDateRange] = useState<DateRange>({
    from: subDays(new Date(), 30),
    to: new Date(),
  });

  const effectiveRange = useMemo(() => {
    const today = new Date();
    if (period === '7d') return { from: subDays(today, 7), to: today };
    if (period === '30d') return { from: subDays(today, 30), to: today };
    return {
      from: dateRange.from ?? subDays(today, 30),
      to: dateRange.to ?? today,
    };
  }, [period, dateRange]);

  const fromIso = startOfDay(effectiveRange.from).toISOString();
  const toIso = endOfDay(effectiveRange.to).toISOString();

  const dashboardQuery = useQuery<SLADashboardResult>({
    queryKey: ['sla-dashboard', accountIdParam ?? 'self', fromIso, toIso],
    queryFn: () =>
      slaPoliciesBackendService.getDashboard(
        { fromDate: fromIso, toDate: toIso },
        accountIdParam ? { accountId: accountIdParam } : undefined
      ),
    enabled: !isSuperAdminSemConta,
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
    refetchOnWindowFocus: true,
  });

  const data = dashboardQuery.data;
  const isLoading = dashboardQuery.isLoading;

  function handlePeriodChange(value: string) {
    const p = value as PeriodOption;
    setPeriod(p);
    const today = new Date();
    if (p === '7d') setDateRange({ from: subDays(today, 7), to: today });
    else if (p === '30d') setDateRange({ from: subDays(today, 30), to: today });
  }

  // Derivados
  const totalResolved = data
    ? (data.aiVsHuman.ai.resolved ?? 0) + (data.aiVsHuman.human.resolved ?? 0)
    : 0;
  const withinSlaPct = data
    ? pct(data.resolvedWithinSla, Math.max(totalResolved, 1))
    : 0;
  const outcomeEntries = data
    ? Object.entries(data.outcomes)
        .map(([k, v]) => ({ outcome: k, label: OUTCOME_LABEL[k] ?? k, count: v }))
        .sort((a, b) => b.count - a.count)
    : [];
  const totalOutcomes = outcomeEntries.reduce((s, e) => s + e.count, 0);
  const csatResponsePct = data ? data.csatResponseRate * 100 : 0;

  if (isSuperAdminSemConta) {
    return (
      <div className="page-container space-y-6">
        <div className="page-header">
          <div>
            <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground flex items-center gap-2">
              <BarChart3 className="w-6 h-6" />
              SLA Dashboard
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1">
              Métricas agregadas de SLA, outcomes e CSAT por conta.
            </p>
          </div>
        </div>
        <Card>
          <CardContent className="pt-10 pb-10 text-center text-muted-foreground">
            <ShieldCheck className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p className="font-medium text-base">SLA é gerenciado por conta.</p>
            <p className="text-sm mt-1">
              Entre em uma conta (impersonação) para visualizar o dashboard.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="page-container space-y-6">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground flex items-center gap-2">
            <BarChart3 className="w-6 h-6" />
            SLA Dashboard
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Métricas de SLA, outcomes, CSAT e ranking de agentes no período.
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

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground uppercase">
                Período
              </label>
              <Select value={period} onValueChange={handlePeriodChange}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7d">Últimos 7 dias</SelectItem>
                  <SelectItem value="30d">Últimos 30 dias</SelectItem>
                  <SelectItem value="custom">Personalizado</SelectItem>
                </SelectContent>
              </Select>
            </div>

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
                        'justify-start text-left font-normal w-[260px]',
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
          </div>
        </CardContent>
      </Card>

      {/* KPIs principais */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* % dentro do SLA — KPI grande/verde, destaque visual */}
        <Card className="md:col-span-1 border-success/30 bg-success/5">
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-2">
              <div className="p-1.5 rounded-md bg-success/10 text-success">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <span className="text-xs font-medium text-muted-foreground">
                % dentro do SLA
              </span>
            </div>
            {isLoading ? (
              <Skeleton className="h-12 w-32" />
            ) : (
              <>
                <p className="text-4xl font-bold text-success">
                  {withinSlaPct.toFixed(1)}%
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {data?.resolvedWithinSla ?? 0} de {totalResolved} resolvidas
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-2">
              <div className="p-1.5 rounded-md bg-primary/10 text-primary">
                <TrendingUp className="w-4 h-4" />
              </div>
              <span className="text-xs font-medium text-muted-foreground">
                Total de conversas
              </span>
            </div>
            {isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <p className="text-2xl font-bold">
                {data?.totalConversations ?? 0}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-2">
              <div className="p-1.5 rounded-md bg-warning/10 text-warning">
                <AlertTriangle className="w-4 h-4" />
              </div>
              <span className="text-xs font-medium text-muted-foreground">
                SLA estourado (período)
              </span>
            </div>
            {isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <p className="text-2xl font-bold">
                {(data?.breachedFirstResponse ?? 0) +
                  (data?.breachedResolution ?? 0)}
              </p>
            )}
            <p className="text-[11px] text-muted-foreground mt-1">
              {data?.breachedFirstResponse ?? 0} 1ª resp ·{' '}
              {data?.breachedResolution ?? 0} resolução
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tempos medios */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-2">
              <div className="p-1.5 rounded-md bg-primary/10 text-primary">
                <Clock className="w-4 h-4" />
              </div>
              <span className="text-xs font-medium text-muted-foreground">
                Tempo médio de 1ª resposta
              </span>
            </div>
            {isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <p className="text-2xl font-bold">
                {formatSec(data?.avgFirstResponseSec ?? null)}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-2">
              <div className="p-1.5 rounded-md bg-primary/10 text-primary">
                <CheckCircle2 className="w-4 h-4" />
              </div>
              <span className="text-xs font-medium text-muted-foreground">
                Tempo médio de resolução
              </span>
            </div>
            {isLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <p className="text-2xl font-bold">
                {formatSec(data?.avgResolutionSec ?? null)}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Outcomes */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-primary" />
            Outcomes
          </CardTitle>
          <CardDescription className="text-xs">
            Distribuição dos resultados informados ao resolver as conversas no
            período.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : outcomeEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              Nenhum outcome registrado no período.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resultado</TableHead>
                  <TableHead className="text-right">Quantidade</TableHead>
                  <TableHead className="text-right">%</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outcomeEntries.map((e) => (
                  <TableRow key={e.outcome}>
                    <TableCell className="font-medium">{e.label}</TableCell>
                    <TableCell className="text-right">{e.count}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {pct(e.count, totalOutcomes).toFixed(1)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* CSAT */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Star className="w-4 h-4 text-amber-500" />
            Avaliação do cliente (CSAT)
          </CardTitle>
          <CardDescription className="text-xs">
            CSAT médio (1-5) e taxa de resposta no período.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-md border border-border p-4">
                  <p className="text-xs text-muted-foreground">
                    CSAT médio
                  </p>
                  <p className="text-3xl font-bold mt-1 flex items-baseline gap-1">
                    {data?.csatAvg == null ? (
                      <span className="text-muted-foreground text-base">
                        Sem respostas no período
                      </span>
                    ) : (
                      <>
                        {data.csatAvg.toFixed(2)}
                        <span className="text-sm font-normal text-muted-foreground">
                          / 5
                        </span>
                      </>
                    )}
                  </p>
                  {data?.csatAvg != null && (
                    <div className="flex items-center gap-0.5 mt-2">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <Star
                          key={n}
                          className={cn(
                            'w-4 h-4',
                            (data.csatAvg ?? 0) >= n
                              ? 'fill-amber-500 text-amber-500'
                              : 'text-muted-foreground'
                          )}
                        />
                      ))}
                    </div>
                  )}
                </div>
                <div className="rounded-md border border-border p-4">
                  <p className="text-xs text-muted-foreground">
                    Taxa de resposta
                  </p>
                  <p className="text-3xl font-bold mt-1">
                    {csatResponsePct.toFixed(1)}%
                  </p>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-amber-500 transition-all"
                      style={{
                        width: `${Math.min(100, csatResponsePct)}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Ranking de Agentes */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="w-4 h-4 text-primary" />
            Ranking de Agentes
          </CardTitle>
          <CardDescription className="text-xs">
            Agentes que resolveram conversas no período. Ordenado por resolvidas
            (desc).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : !data || data.byAgent.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              Nenhum agente resolveu conversas no período.
            </p>
          ) : (
            <ScrollArea className="max-h-[360px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]">#</TableHead>
                    <TableHead>Agente</TableHead>
                    <TableHead className="text-center">Resolvidas</TableHead>
                    <TableHead className="text-center">CSAT</TableHead>
                    <TableHead className="text-center">Breaches</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byAgent.map((a, idx) => (
                    <TableRow key={a.userId}>
                      <TableCell className="text-muted-foreground font-medium">
                        {idx + 1}º
                      </TableCell>
                      <TableCell className="font-medium">{a.name}</TableCell>
                      <TableCell className="text-center">
                        <Badge variant="secondary">{a.resolved}</Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        {a.csatAvg == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="font-semibold">
                            {a.csatAvg.toFixed(2)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {a.breaches > 0 ? (
                          <Badge
                            variant="outline"
                            className="border-destructive/40 text-destructive"
                          >
                            {a.breaches}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* IA vs Humano */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Bot className="w-4 h-4 text-primary" />
            IA vs Humano
          </CardTitle>
          <CardDescription className="text-xs">
            Comparativo de resolução, CSAT médio e breaches no período.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !data ? null : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="p-2 rounded-md bg-primary/10">
                    <Bot className="w-4 h-4 text-primary" />
                  </div>
                  <span className="font-semibold">IA</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Resolvidas</p>
                    <p className="text-xl font-bold">
                      {data.aiVsHuman.ai.resolved}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">CSAT</p>
                    <p className="text-xl font-bold">
                      {data.aiVsHuman.ai.csat == null
                        ? '—'
                        : data.aiVsHuman.ai.csat.toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Breaches</p>
                    <p className="text-xl font-bold text-destructive">
                      {data.aiVsHuman.ai.breaches}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-success/20 bg-success/5 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="p-2 rounded-md bg-success/10">
                    <UserIcon className="w-4 h-4 text-success" />
                  </div>
                  <span className="font-semibold">Humano</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Resolvidas</p>
                    <p className="text-xl font-bold">
                      {data.aiVsHuman.human.resolved}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">CSAT</p>
                    <p className="text-xl font-bold">
                      {data.aiVsHuman.human.csat == null
                        ? '—'
                        : data.aiVsHuman.human.csat.toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Breaches</p>
                    <p className="text-xl font-bold text-destructive">
                      {data.aiVsHuman.human.breaches}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
